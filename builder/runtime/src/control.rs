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
    pub cached_tokens: std::sync::atomic::AtomicU64,
    pub reported_usage_calls: std::sync::atomic::AtomicU64,
    pub reported_input_usage_calls: std::sync::atomic::AtomicU64,
    pub reported_output_usage_calls: std::sync::atomic::AtomicU64,
    pub reported_cached_usage_calls: std::sync::atomic::AtomicU64,
    input_tokens_overflow: AtomicBool,
    output_tokens_overflow: AtomicBool,
    cached_tokens_overflow: AtomicBool,
    usage_lock: std::sync::Mutex<()>,
}

impl Metrics {
    /// Call once for each actual provider attempt after consolidating its usage
    /// events. Missing values remain unknown, including failed/cancelled calls.
    /// `model_calls` is incremented before dispatch, so attempts that never
    /// report usage keep the corresponding aggregate incomplete.
    pub fn record_usage(&self, input: Option<u64>, output: Option<u64>, cached: Option<u64>) {
        let _guard = self
            .usage_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        fn record(
            total: &std::sync::atomic::AtomicU64,
            reported: &std::sync::atomic::AtomicU64,
            overflow: &AtomicBool,
            value: Option<u64>,
        ) {
            if let Some(value) = value {
                let _ = total.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |total| {
                    if total.checked_add(value).is_none() {
                        overflow.store(true, Ordering::Relaxed);
                    }
                    Some(total.saturating_add(value))
                });
                // Publish the sum before the count that makes it complete.
                reported.fetch_add(1, Ordering::Release);
            }
        }
        record(
            &self.input_tokens,
            &self.reported_input_usage_calls,
            &self.input_tokens_overflow,
            input,
        );
        record(
            &self.output_tokens,
            &self.reported_output_usage_calls,
            &self.output_tokens_overflow,
            output,
        );
        record(
            &self.cached_tokens,
            &self.reported_cached_usage_calls,
            &self.cached_tokens_overflow,
            cached,
        );
        if input.is_some() || output.is_some() || cached.is_some() {
            self.reported_usage_calls.fetch_add(1, Ordering::Release);
        }
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let _guard = self
            .usage_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let calls = self.model_calls.load(Ordering::Acquire);
        let input_calls = self.reported_input_usage_calls.load(Ordering::Acquire);
        let output_calls = self.reported_output_usage_calls.load(Ordering::Acquire);
        let cached_calls = self.reported_cached_usage_calls.load(Ordering::Acquire);
        let input = self.input_tokens.load(Ordering::Relaxed);
        let output = self.output_tokens.load(Ordering::Relaxed);
        let cached = self.cached_tokens.load(Ordering::Relaxed);
        let complete = |sum, reported, overflow: &AtomicBool| {
            (calls == reported && !overflow.load(Ordering::Relaxed)).then_some(sum)
        };
        serde_json::json!({
            "model_calls": calls,
            "tool_calls": self.tool_calls.load(Ordering::Relaxed),
            "input_tokens": complete(input, input_calls, &self.input_tokens_overflow),
            "output_tokens": complete(output, output_calls, &self.output_tokens_overflow),
            "cached_tokens": complete(cached, cached_calls, &self.cached_tokens_overflow),
            // These are lower-bound sums of the attempts reporting each field,
            // not estimates for calls whose usage the provider did not report.
            "reported_input_tokens": input,
            "reported_output_tokens": output,
            "reported_cached_tokens": cached,
            "reported_input_usage_calls": input_calls,
            "reported_output_usage_calls": output_calls,
            "reported_cached_usage_calls": cached_calls,
            "reported_usage_calls": self.reported_usage_calls.load(Ordering::Acquire),
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

/// Accepted direction awaiting the agent. Stop never enters the inbox: it
/// wakes the run supervisor through the cancellation channel.
#[derive(Clone, Debug, PartialEq)]
pub struct Steering {
    pub command_id: Uuid,
    pub instruction: String,
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
    pub telemetry: Mutex<Option<crate::telemetry::RunSpan>>,
    pub user: String,
    pub conversation: String,
    /// Background autonomy run; admitted from its own per-user pool.
    pub autonomy: bool,
    pub sender: mpsc::Sender<Steering>,
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
        let steering = match &command {
            // Stop bypasses both steering limits and wakes the run supervisor,
            // including when the agent is blocked sending output to a slow client.
            Command::Cancel { .. } => {
                if *self.cancellation.borrow() {
                    return Ok(false);
                }
                self.cancellation.send_replace(true);
                commands.insert(command.id(), command);
                return Ok(true);
            }
            Command::Steer {
                command_id,
                instruction,
            } => Steering {
                command_id: *command_id,
                instruction: instruction.clone(),
            },
        };
        if *self.cancellation.borrow() {
            return Err(409);
        }
        if commands.len() >= 256 {
            return Err(429);
        }
        self.sender.try_send(steering).map_err(|error| {
            if matches!(error, mpsc::error::TrySendError::Closed(_)) {
                409u16
            } else {
                429u16
            }
        })?;
        commands.insert(command.id(), command);
        Ok(true)
    }

    pub async fn finish_if_idle(&self, inbox: &mpsc::Receiver<Steering>) -> bool {
        let _guard = self.commands.lock().await;
        if !inbox.is_empty() || *self.cancellation.borrow() {
            return false;
        }
        self.finished.store(true, Ordering::Relaxed);
        true
    }

    /// The run's outcome is known; later commands get the finished answer.
    /// Uses the submit lock so no command is accepted after this returns.
    pub async fn finish(&self) {
        let _guard = self.commands.lock().await;
        self.finished.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_usage_is_unknown_and_reported_zero_is_known() {
        let metrics = Metrics::default();
        assert_eq!(metrics.snapshot()["input_tokens"], 0);
        metrics.model_calls.fetch_add(1, Ordering::Relaxed);
        metrics.record_usage(None, None, None);
        let missing = metrics.snapshot();
        for field in ["input_tokens", "output_tokens", "cached_tokens"] {
            assert!(missing[field].is_null(), "{field}");
        }
        assert_eq!(missing["reported_usage_calls"], 0);
        assert_eq!(missing["reported_input_usage_calls"], 0);

        let zero = Metrics::default();
        zero.model_calls.fetch_add(1, Ordering::Relaxed);
        zero.record_usage(Some(0), Some(0), Some(0));
        let known = zero.snapshot();
        for field in ["input_tokens", "output_tokens", "cached_tokens"] {
            assert_eq!(known[field], 0, "{field}");
        }
        assert_eq!(known["reported_usage_calls"], 1);
        assert_eq!(known["reported_cached_usage_calls"], 1);
    }

    #[test]
    fn partial_usage_and_failed_retry_cannot_become_complete_totals() {
        let metrics = Metrics::default();
        metrics.model_calls.fetch_add(1, Ordering::Relaxed);
        metrics.record_usage(Some(100), Some(20), None);
        let partial = metrics.snapshot();
        assert_eq!(partial["input_tokens"], 100);
        assert_eq!(partial["output_tokens"], 20);
        assert!(partial["cached_tokens"].is_null());
        assert_eq!(partial["reported_cached_usage_calls"], 0);
        assert_eq!(partial["reported_usage_calls"], 1);

        metrics.model_calls.fetch_add(1, Ordering::Relaxed);
        metrics.record_usage(None, Some(5), Some(0));
        let partial = metrics.snapshot();
        assert!(partial["input_tokens"].is_null());
        assert_eq!(partial["output_tokens"], 25);
        assert!(partial["cached_tokens"].is_null());
        assert_eq!(partial["reported_input_tokens"], 100);
        assert_eq!(partial["reported_input_usage_calls"], 1);
        assert_eq!(partial["reported_output_usage_calls"], 2);
        assert_eq!(partial["reported_cached_usage_calls"], 1);
        assert_eq!(partial["reported_usage_calls"], 2);

        // An actual failed/in-flight provider attempt is part of completion
        // cost even when it produces no usage response at all.
        metrics.model_calls.fetch_add(1, Ordering::Relaxed);
        let failed = metrics.snapshot();
        for field in ["input_tokens", "output_tokens", "cached_tokens"] {
            assert!(failed[field].is_null(), "{field}");
        }
        assert_eq!(failed["reported_output_tokens"], 25);
        assert_eq!(failed["model_calls"], 3);
    }

    #[test]
    fn concurrent_coordinator_and_worker_reports_keep_per_field_counts() {
        let metrics = Arc::new(Metrics::default());
        let handles: Vec<_> = (0..4)
            .map(|worker| {
                let metrics = metrics.clone();
                std::thread::spawn(move || {
                    for _ in 0..100 {
                        metrics.model_calls.fetch_add(1, Ordering::Relaxed);
                        metrics.record_usage(Some(100), Some(20), (worker != 0).then_some(10));
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let complete = metrics.snapshot();
        assert_eq!(complete["model_calls"], 400);
        assert_eq!(complete["input_tokens"], 40_000);
        assert_eq!(complete["output_tokens"], 8_000);
        assert!(complete["cached_tokens"].is_null());
        assert_eq!(complete["reported_cached_tokens"], 3_000);
        assert_eq!(complete["reported_cached_usage_calls"], 300);
        assert_eq!(complete["reported_usage_calls"], 400);
    }

    #[test]
    fn overflowing_usage_sums_are_unknown_instead_of_wrapping_to_zero() {
        let metrics = Metrics::default();
        metrics.model_calls.fetch_add(2, Ordering::Relaxed);
        metrics.record_usage(Some(u64::MAX), Some(0), Some(0));
        metrics.record_usage(Some(1), Some(0), Some(0));
        let snapshot = metrics.snapshot();
        assert!(snapshot["input_tokens"].is_null());
        assert_eq!(snapshot["reported_input_tokens"], u64::MAX);
        assert_eq!(snapshot["output_tokens"], 0);
    }

    #[tokio::test]
    async fn cancellation_bypasses_exhausted_command_history_and_is_sticky() {
        let (sender, mut receiver) = mpsc::channel(1);
        let run = RunHandle {
            user: "alice".into(),
            conversation: "chat".into(),
            autonomy: false,
            sender,
            commands: Mutex::new(HashMap::new()),
            finished: AtomicBool::new(false),
            cancellation: watch::channel(false).0,
            metrics: Metrics::default(),
            telemetry: Mutex::new(None),
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
            autonomy: false,
            sender,
            commands: Mutex::new(HashMap::new()),
            finished: AtomicBool::new(false),
            cancellation: watch::channel(false).0,
            metrics: Metrics::default(),
            telemetry: Mutex::new(None),
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
        assert_eq!(
            receiver.recv().await,
            Some(Steering {
                command_id: command.id(),
                instruction: "Use source B".into()
            })
        );
    }

    #[tokio::test]
    async fn accepted_direction_prevents_finalization() {
        let (sender, mut inbox) = mpsc::channel(8);
        let run = RunHandle {
            user: "alice".into(),
            conversation: "chat".into(),
            autonomy: false,
            sender,
            commands: Mutex::new(HashMap::new()),
            finished: AtomicBool::new(false),
            cancellation: watch::channel(false).0,
            metrics: Metrics::default(),
            telemetry: Mutex::new(None),
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
