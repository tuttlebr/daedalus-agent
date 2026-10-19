//! Keep a started ingestion's collection lock until its owned work settles,
//! including when its HTTP/batch waiter times out or is cancelled.
use anyhow::Result;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, LazyLock, Mutex as MapMutex, Weak},
    time::Duration,
};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Collections(MapMutex<HashMap<String, Weak<Mutex<()>>>>);
impl Collections {
    /// The process's one write-ownership registry. The HTTP routes and every
    /// document tool build their own processors; uploads and tool ingests into
    /// the same collection must still serialize their writes.
    pub fn shared() -> Arc<Self> {
        static SHARED: LazyLock<Arc<Collections>> = LazyLock::new(Arc::default);
        SHARED.clone()
    }
    pub fn get(&self, collection: &str) -> Arc<Mutex<()>> {
        let mut locks = self.0.lock().unwrap();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(collection).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(collection.into(), Arc::downgrade(&lock));
        lock
    }
}

#[derive(Debug)]
pub enum WaitError {
    Timeout,
    Failed(anyhow::Error),
}

/// The timeout includes waiting for the collection. Before acquisition, dropping
/// the waiter cancels its queue entry. Once acquired, the worker owns the guard
/// and runs to completion even if its waiter disappears. This preserves the
/// retained thread helper's guarantee that a late write cannot overlap a local
/// successor on the same collection.
pub async fn run<F, W, T>(
    lock: Arc<Mutex<()>>,
    duration: Duration,
    work: F,
) -> std::result::Result<T, WaitError>
where
    F: FnOnce() -> W + Send + 'static,
    W: Future<Output = Result<T>> + Send + 'static,
    T: Send + 'static,
{
    tokio::time::timeout(duration, async move {
        let guard = lock.lock_owned().await;
        // No await separates lock acquisition from moving it into the worker.
        // Dropping JoinHandle detaches the worker without dropping its guard.
        tokio::spawn(async move {
            let _guard = guard;
            let result = work().await;
            if result.is_err() {
                tracing::warn!("Owned ingestion finished with an error");
            }
            result
        })
        .await
        .map_err(|error| WaitError::Failed(error.into()))?
        .map_err(WaitError::Failed)
    })
    .await
    .map_err(|_| WaitError::Timeout)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn abandoned_waiter_retains_running_write_until_it_settles() {
        // The retained Python helper's real-thread regression exercises both
        // abandonment paths. Barriers keep this native equivalent deterministic.
        for cancel in [false, true] {
            let locks = Collections::default();
            let lock = locks.get("private_collection");
            let calls = Arc::new(MapMutex::new(Vec::new()));
            let (started, ready) = oneshot::channel();
            let (release, released) = oneshot::channel();
            let first = tokio::spawn(run(
                lock.clone(),
                Duration::from_millis(if cancel { 2000 } else { 20 }),
                {
                    let calls = calls.clone();
                    move || async move {
                        started.send(()).unwrap();
                        released.await.unwrap();
                        calls.lock().unwrap().push("first");
                        Ok(())
                    }
                },
            ));
            ready.await.unwrap();
            if cancel {
                first.abort();
                assert!(first.await.unwrap_err().is_cancelled());
            } else {
                assert!(matches!(first.await.unwrap(), Err(WaitError::Timeout)));
            }
            assert!(lock.try_lock().is_err());
            let second = tokio::spawn(run(
                locks.get("private_collection"),
                Duration::from_secs(2),
                {
                    let calls = calls.clone();
                    move || async move {
                        calls.lock().unwrap().push("second");
                        Ok(())
                    }
                },
            ));
            tokio::task::yield_now().await;
            assert!(calls.lock().unwrap().is_empty());
            // A separate collection is never held by this abandoned request.
            run(
                locks.get("another_private_collection"),
                Duration::from_secs(1),
                || async { Ok(()) },
            )
            .await
            .unwrap();
            release.send(()).unwrap();
            second.await.unwrap().unwrap();
            assert_eq!(*calls.lock().unwrap(), vec!["first", "second"]);
            assert!(lock.try_lock().is_ok());
        }
    }

    #[tokio::test]
    async fn abandoned_queue_entry_never_starts_work() {
        for cancel in [false, true] {
            let lock = Arc::new(Mutex::new(()));
            let held = lock.clone().lock_owned().await;
            let calls = Arc::new(AtomicUsize::new(0));
            let queued = tokio::spawn(run(
                lock.clone(),
                Duration::from_millis(if cancel { 2000 } else { 20 }),
                {
                    let calls = calls.clone();
                    move || async move {
                        calls.fetch_add(1, Ordering::Relaxed);
                        Ok(())
                    }
                },
            ));
            tokio::task::yield_now().await;
            if cancel {
                queued.abort();
                assert!(queued.await.unwrap_err().is_cancelled());
            } else {
                assert!(matches!(queued.await.unwrap(), Err(WaitError::Timeout)));
            }
            drop(held);
            run(lock, Duration::from_secs(1), || async { Ok(()) })
                .await
                .unwrap();
            assert_eq!(calls.load(Ordering::Relaxed), 0);
        }
    }

    #[tokio::test]
    async fn failed_worker_releases_ownership_and_unused_names_are_reclaimed() {
        let locks = Collections::default();
        let first = locks.get("collection");
        assert!(Arc::ptr_eq(&first, &locks.get("collection")));
        let result = run(first.clone(), Duration::from_secs(1), || async {
            Err::<(), _>(anyhow::anyhow!("Synthetic worker failure"))
        })
        .await;
        match result {
            Err(WaitError::Failed(error)) => {
                assert_eq!(error.to_string(), "Synthetic worker failure")
            }
            result => panic!("Unexpected result: {result:?}"),
        }
        assert!(first.try_lock().is_ok());
        drop(first);
        let next = locks.get("next");
        assert!(next.try_lock().is_ok());
        assert_eq!(locks.0.lock().unwrap().len(), 1);
    }
}
