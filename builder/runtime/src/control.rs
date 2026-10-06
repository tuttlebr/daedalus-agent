//! Each run has its own bounded inbox, authenticated owner, and command IDs.

use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, watch};
use uuid::Uuid;

#[derive(Default)]
pub struct Metrics {
    pub model_calls: std::sync::atomic::AtomicU64,
    pub tool_calls: std::sync::atomic::AtomicU64,
    pub input_tokens: std::sync::atomic::AtomicU64,
    pub output_tokens: std::sync::atomic::AtomicU64,
    pub reported_usage_calls: std::sync::atomic::AtomicU64,
}

impl Metrics {
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "model_calls": self.model_calls.load(Ordering::Relaxed),
            "tool_calls": self.tool_calls.load(Ordering::Relaxed),
            "input_tokens": self.input_tokens.load(Ordering::Relaxed),
            "output_tokens": self.output_tokens.load(Ordering::Relaxed),
            "reported_usage_calls": self.reported_usage_calls.load(Ordering::Relaxed),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Steer {
        command_id: Uuid,
        instruction: String,
    },
    Cancel {
        command_id: Uuid,
    },
}

impl Command {
    pub fn id(&self) -> Uuid {
        match self {
            Self::Steer { command_id, .. } | Self::Cancel { command_id } => *command_id,
        }
    }

    pub fn valid(&self) -> bool {
        match self {
            Self::Steer { instruction, .. } => {
                !instruction.trim().is_empty() && instruction.len() <= 16_000
            }
            Self::Cancel { .. } => true,
        }
    }
}

pub struct RunHandle {
    pub user: String,
    pub conversation: String,
    pub sender: mpsc::Sender<Command>,
    pub commands: Mutex<HashMap<Uuid, Command>>,
    pub finished: AtomicBool,
    pub cancellation: watch::Sender<bool>,
    pub metrics: Metrics,
}

pub type Runs = Arc<Mutex<HashMap<String, Arc<RunHandle>>>>;

impl RunHandle {
    pub async fn submit(&self, user: &str, command: Command) -> Result<bool, u16> {
        if user != self.user {
            return Err(404);
        }
        if !command.valid() {
            return Err(400);
        }
        let mut commands = self.commands.lock().await;
        if let Some(previous) = commands.get(&command.id()) {
            return if previous == &command {
                Ok(false)
            } else {
                Err(409)
            };
        }
        if self.finished.load(Ordering::Relaxed) {
            return Err(409);
        }
        // Stop bypasses both steering limits and wakes the run supervisor,
        // including when the agent is blocked sending output to a slow client.
        if matches!(command, Command::Cancel { .. }) {
            if *self.cancellation.borrow() {
                return Ok(false);
            }
            self.cancellation.send_replace(true);
            commands.insert(command.id(), command);
            return Ok(true);
        }
        if *self.cancellation.borrow() {
            return Err(409);
        }
        if commands.len() >= 256 {
            return Err(429);
        }
        self.sender.try_send(command.clone()).map_err(|error| {
            if matches!(error, mpsc::error::TrySendError::Closed(_)) {
                409u16
            } else {
                429u16
            }
        })?;
        commands.insert(command.id(), command);
        Ok(true)
    }

    pub async fn finish_if_idle(&self, inbox: &mpsc::Receiver<Command>) -> bool {
        let _guard = self.commands.lock().await;
        if !inbox.is_empty() || *self.cancellation.borrow() {
            return false;
        }
        self.finished.store(true, Ordering::Relaxed);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_bypasses_exhausted_command_history_and_is_sticky() {
        let (sender, mut receiver) = mpsc::channel(1);
        let run = RunHandle {
            user: "alice".into(),
            conversation: "chat".into(),
            sender,
            commands: Mutex::new(HashMap::new()),
            finished: AtomicBool::new(false),
            cancellation: watch::channel(false).0,
            metrics: Metrics::default(),
        };
        for _ in 0..256 {
            assert_eq!(
                run.submit(
                    "alice",
                    Command::Steer {
                        command_id: Uuid::new_v4(),
                        instruction: "fixture".into()
                    }
                )
                .await,
                Ok(true)
            );
            receiver.recv().await.unwrap();
        }
        assert_eq!(
            run.submit(
                "alice",
                Command::Cancel {
                    command_id: Uuid::new_v4()
                }
            )
            .await,
            Ok(true)
        );
        assert_eq!(
            run.submit(
                "alice",
                Command::Cancel {
                    command_id: Uuid::new_v4()
                }
            )
            .await,
            Ok(false)
        );
        assert!(!run.finish_if_idle(&receiver).await);
        assert_eq!(
            run.submit(
                "alice",
                Command::Steer {
                    command_id: Uuid::new_v4(),
                    instruction: "late".into()
                }
            )
            .await,
            Err(409)
        );
    }

    #[tokio::test]
    async fn commands_are_scoped_idempotent_and_bounded() {
        let (sender, mut receiver) = mpsc::channel(1);
        let run = RunHandle {
            user: "alice".into(),
            conversation: "chat".into(),
            sender,
            commands: Mutex::new(HashMap::new()),
            finished: AtomicBool::new(false),
            cancellation: watch::channel(false).0,
            metrics: Metrics::default(),
        };
        let command = Command::Steer {
            command_id: Uuid::new_v4(),
            instruction: "Use source B".into(),
        };
        assert_eq!(run.submit("bob", command.clone()).await, Err(404));
        assert_eq!(run.submit("alice", command.clone()).await, Ok(true));
        assert_eq!(run.submit("alice", command.clone()).await, Ok(false));
        assert_eq!(
            run.submit(
                "alice",
                Command::Cancel {
                    command_id: command.id()
                }
            )
            .await,
            Err(409)
        );
        assert_eq!(
            run.submit(
                "alice",
                Command::Cancel {
                    command_id: Uuid::new_v4()
                }
            )
            .await,
            Ok(true)
        );
        assert!(*run.cancellation.borrow());
        assert_eq!(receiver.recv().await, Some(command));
    }

    #[tokio::test]
    async fn accepted_direction_prevents_finalization() {
        let (sender, mut inbox) = mpsc::channel(8);
        let run = RunHandle {
            user: "alice".into(),
            conversation: "chat".into(),
            sender,
            commands: Mutex::new(HashMap::new()),
            finished: AtomicBool::new(false),
            cancellation: watch::channel(false).0,
            metrics: Metrics::default(),
        };
        let command = Command::Steer {
            command_id: Uuid::new_v4(),
            instruction: "Continue".into(),
        };
        assert_eq!(run.submit("alice", command).await, Ok(true));
        assert!(!run.finish_if_idle(&inbox).await);
        inbox.recv().await.unwrap();
        assert!(run.finish_if_idle(&inbox).await);
        assert_eq!(
            run.submit(
                "alice",
                Command::Cancel {
                    command_id: Uuid::new_v4()
                }
            )
            .await,
            Err(409)
        );
    }
}
