//! Process-wide acknowledged mutation clocks, matching the retained SDK cache.
use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
};

type Key = (String, String, String);

struct Cache {
    capacity: usize,
    values: VecDeque<(Key, u64)>,
}
impl Cache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            values: VecDeque::new(),
        }
    }
    fn position(&self, endpoint: &str, database: &str, collection: &str) -> Option<usize> {
        let database = if database.is_empty() {
            "default"
        } else {
            database
        };
        self.values.iter().position(|((host, db, name), _)| {
            host == endpoint && db == database && name == collection
        })
    }
    fn get(&mut self, endpoint: &str, database: &str, collection: &str) -> u64 {
        let Some(index) = self.position(endpoint, database, collection) else {
            return 0;
        };
        let entry = self.values.remove(index).unwrap();
        let timestamp = entry.1;
        self.values.push_back(entry);
        timestamp
    }
    fn record(&mut self, endpoint: &str, database: &str, collection: &str, timestamp: u64) {
        // Even an older acknowledgement touches an existing SDK LRU entry.
        if let Some(index) = self.position(endpoint, database, collection) {
            let mut entry = self.values.remove(index).unwrap();
            entry.1 = entry.1.max(timestamp);
            self.values.push_back(entry);
        } else if timestamp > 0 {
            let database = if database.is_empty() {
                "default"
            } else {
                database
            };
            self.values.push_back((
                (endpoint.into(), database.into(), collection.into()),
                timestamp,
            ));
            while self.values.len() > self.capacity {
                self.values.pop_front();
            }
        }
    }
}

static CLOCKS: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::new(4096)));

pub fn get(endpoint: &str, database: &str, collection: &str) -> u64 {
    CLOCKS
        .lock()
        .expect("Milvus mutation clocks")
        .get(endpoint, database, collection)
}

pub fn record(endpoint: &str, database: &str, collection: &str, timestamp: u64) {
    CLOCKS
        .lock()
        .expect("Milvus mutation clocks")
        .record(endpoint, database, collection, timestamp);
}

#[cfg(test)]
pub fn clear() {
    CLOCKS
        .lock()
        .expect("Milvus mutation clocks")
        .values
        .clear();
}

#[cfg(test)]
mod tests {
    #[test]
    fn retained_mutation_clocks() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-timestamps.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let mut cache = super::Cache::new(case["capacity"].as_u64().unwrap() as usize);
            for step in case["steps"].as_array().unwrap() {
                let fields = step.as_array().unwrap();
                match fields[0].as_str().unwrap() {
                    "fill" => {
                        for index in 0..fields[1].as_u64().unwrap() {
                            cache.record("synthetic-server", "", &format!("c{index}"), index + 2);
                        }
                    }
                    "set" => cache.record(
                        fields[1].as_str().unwrap(),
                        fields[2].as_str().unwrap(),
                        fields[3].as_str().unwrap(),
                        fields[4].as_u64().unwrap(),
                    ),
                    "get" => assert_eq!(
                        cache.get(
                            fields[1].as_str().unwrap(),
                            fields[2].as_str().unwrap(),
                            fields[3].as_str().unwrap()
                        ),
                        fields[4].as_u64().unwrap(),
                        "{}: {step}",
                        case["name"]
                    ),
                    _ => panic!("unknown mutation clock fixture operation"),
                }
            }
        }
    }
}
