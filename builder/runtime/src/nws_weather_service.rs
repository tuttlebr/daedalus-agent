//! Native NWS requests, shared points-cache lifecycle and weather tool output.
use super::{Checked, Invalid, Settings, Time, cache_ttl, invalid, nws_url};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct ResponseData {
    payload: Value,
    markers: crate::document_json::Surrogates,
    fetched: String,
    headers: Value,
}
type Reply = Arc<ResponseData>;

struct Part {
    value: Value,
    markers: crate::document_json::Surrogates,
}
impl Part {
    fn from(value: Value, reply: &Reply) -> Self {
        Self {
            value,
            markers: reply.markers.clone(),
        }
    }
    fn unavailable(error: &Invalid, source: Option<&str>) -> Self {
        Self {
            value: json!({"status":"unavailable","reason":error.class,"source_url":source}),
            markers: Default::default(),
        }
    }
    fn outcome(result: Checked<Self>, source: Option<&str>) -> Checked<Self> {
        match result {
            Err(error) if error.class == "CancelledError" => Err(error),
            Err(error) => Ok(Self::unavailable(&error, source)),
            Ok(part) => Ok(part),
        }
    }
}

fn assemble(mut value: Value, mut parts: Vec<(&str, Part)>) -> Checked<crate::document_json::Text> {
    use std::collections::{BTreeMap, BTreeSet};
    let used: BTreeSet<_> = parts
        .iter()
        .flat_map(|(_, part)| {
            crate::memory_tools::json_text(&part.value, false, false, true)
                .chars()
                .collect::<Vec<_>>()
        })
        .collect();
    let mut available = (0xf0000..=0xffffd)
        .chain(0x100000..=0x10fffd)
        .filter_map(char::from_u32)
        .filter(|character| !used.contains(character));
    let mut markers = BTreeMap::new();
    let mut by_unit = BTreeMap::new();
    fn rename(value: &mut Value, mapping: &BTreeMap<char, char>) {
        let text = |text: &str| {
            text.chars()
                .map(|c| mapping.get(&c).copied().unwrap_or(c))
                .collect::<String>()
        };
        match value {
            Value::String(value) => *value = text(value),
            Value::Array(values) => values.iter_mut().for_each(|value| rename(value, mapping)),
            Value::Object(values) => {
                *values = std::mem::take(values)
                    .into_iter()
                    .map(|(key, mut value)| {
                        rename(&mut value, mapping);
                        (text(&key), value)
                    })
                    .collect();
            }
            _ => (),
        }
    }
    for (name, part) in &mut parts {
        let mut mapping = BTreeMap::new();
        for (old, unit) in &part.markers {
            let replacement = if let Some(marker) = by_unit.get(unit) {
                *marker
            } else {
                let marker = available.next().ok_or_else(|| {
                    invalid(
                        "UnicodeEncodeError",
                        "No isolated surrogate marker is available",
                    )
                })?;
                markers.insert(marker, *unit);
                by_unit.insert(*unit, marker);
                marker
            };
            mapping.insert(*old, replacement);
        }
        rename(&mut part.value, &mapping);
        value[*name] = std::mem::take(&mut part.value);
    }
    let statuses: Vec<_> = ["forecast", "alerts", "observations"]
        .into_iter()
        .filter_map(|name| value.get(name).map(|part| part["status"].as_str().unwrap()))
        .collect();
    value["status"] = json!(if statuses.iter().all(|status| *status == "ok") {
        "ok"
    } else if statuses.iter().all(|status| *status == "unavailable") {
        "unavailable"
    } else {
        "partial"
    });
    Ok(crate::document_json::Text::new(
        crate::memory_tools::json_text(&value, false, false, true),
        markers,
    ))
}

fn required<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Checked<&'a Value> {
    object
        .get(key)
        .ok_or_else(|| invalid("KeyError", format!("Missing NWS field: {key}")))
}
fn linked_url(value: &Value, reply: &Reply) -> Checked<String> {
    let url = nws_url(value)?;
    if url
        .chars()
        .any(|character| reply.markers.contains_key(&character))
    {
        return Err(invalid(
            "UnicodeEncodeError",
            "NWS link contains an isolated surrogate",
        ));
    }
    Ok(url)
}
fn alerts(reply: Reply, source: &str) -> Checked<Part> {
    let features = reply.payload["features"]
        .as_array()
        .ok_or_else(|| invalid("ValueError", "Missing alerts features"))?;
    if features
        .iter()
        .any(|feature| !feature.is_object() || !feature["properties"].is_object())
    {
        return Err(invalid("ValueError", "Missing alerts features"));
    }
    let mut result = json!({"status":"ok","source_url":source,"fetched_at":reply.fetched,"issued_at":null,"items":[]});
    result["issued_at"] = reply.payload["updated"].clone();
    result["items"] = Value::Array(
        features
            .iter()
            .map(|feature| {
                let mut item = json!({"source_url":null});
                item["source_url"] = feature["id"].clone();
                for field in [
                    "event",
                    "severity",
                    "urgency",
                    "certainty",
                    "headline",
                    "sent",
                    "effective",
                    "onset",
                    "expires",
                    "ends",
                    "description",
                    "instruction",
                ] {
                    item[field] = feature["properties"][field].clone();
                }
                item
            })
            .collect(),
    );
    Ok(Part::from(result, &reply))
}
struct Pending {
    receiver: tokio::sync::watch::Receiver<Option<Checked<Reply>>>,
    task: tokio::task::JoinHandle<()>,
}
#[derive(Default)]
struct Cache {
    entries: VecDeque<(String, Instant, Reply)>,
    pending: HashMap<String, Pending>,
}
struct Service {
    http: Checked<crate::public_http::Client>,
    timeout: Duration,
    ttl: f64,
    cache: Mutex<Cache>,
}
pub struct Tool {
    settings: Settings,
    service: Arc<Service>,
}
#[cfg(test)]
static FIXED_TIME: std::sync::OnceLock<Time> = std::sync::OnceLock::new();
fn now() -> Time {
    #[cfg(test)]
    if let Some(time) = FIXED_TIME.get() {
        return time.clone();
    }
    Time {
        local: chrono::Utc::now().naive_utc(),
        offset: 0,
    }
}
impl From<crate::public_http::Failure> for Invalid {
    fn from(value: crate::public_http::Failure) -> Self {
        invalid(value.class, value.message)
    }
}

/// JSON response decoding follows json.loads(bytes), including UTF BOMs and
/// constants accepted by CPython. Mark isolated surrogates until final output.
fn decode(raw: &[u8]) -> Checked<(Value, crate::document_json::Surrogates)> {
    let encoding = if raw.starts_with(b"\xff\xfe\0\0") || raw.starts_with(b"\0\0\xfe\xff") {
        "utf_32"
    } else if raw.starts_with(b"\xff\xfe") || raw.starts_with(b"\xfe\xff") {
        "utf_16"
    } else if raw.starts_with(b"\xef\xbb\xbf") {
        "utf_8_sig"
    } else if raw.len() >= 4 && raw[0] == 0 {
        if raw[1] == 0 {
            "utf_32_be"
        } else {
            "utf_16_be"
        }
    } else if raw.len() >= 4 && raw[1] == 0 {
        if raw[2] == 0 && raw[3] == 0 {
            "utf_32_le"
        } else {
            "utf_16_le"
        }
    } else if raw.len() == 2 && raw[0] == 0 {
        "utf_16_be"
    } else if raw.len() == 2 && raw[1] == 0 {
        "utf_16_le"
    } else {
        "utf_8"
    };
    let text = crate::document_codecs::decode(encoding, raw, false)
        .map_err(|_| invalid("UnicodeDecodeError", "Invalid NWS JSON encoding"))?;
    let mut replacements = HashMap::new();
    let mut normalized = String::new();
    let (mut at, mut quoted) = (0, false);
    while at < text.len() {
        let rest = &text[at..];
        if quoted && rest.starts_with('\\') {
            let size = 1 + rest[1..].chars().next().map_or(0, char::len_utf8);
            normalized.push_str(&rest[..size]);
            at += size;
            continue;
        }
        if rest.starts_with('"') {
            quoted = !quoted;
        }
        if !quoted
            && let Some(token) = ["NaN", "Infinity", "-Infinity"]
                .into_iter()
                .find(|token| rest.starts_with(token))
        {
            let mut number = format!("8{}{}", "0".repeat(50), replacements.len());
            while text.contains(&number) {
                number.push('0');
            }
            normalized.push_str(&number);
            replacements.insert(number, token);
            at += token.len();
        } else {
            let character = rest.chars().next().unwrap();
            normalized.push(character);
            at += character.len_utf8();
        }
    }
    let (mut value, markers) = crate::document_json::decode_indexed(normalized.as_bytes())
        .ok_or_else(|| invalid("JSONDecodeError", "Invalid NWS JSON response"))?;
    fn restore(value: &mut Value, replacements: &HashMap<String, &str>) {
        match value {
            Value::Number(number) => {
                if let Some(token) = replacements.get(&number.to_string()) {
                    *number = serde_json::Number::from_string_unchecked((*token).into());
                }
            }
            Value::Array(values) => values
                .iter_mut()
                .for_each(|value| restore(value, replacements)),
            Value::Object(values) => values
                .values_mut()
                .for_each(|value| restore(value, replacements)),
            _ => (),
        }
    }
    restore(&mut value, &replacements);
    Ok((value, markers))
}

impl Tool {
    pub fn new(raw: &Value) -> anyhow::Result<Self> {
        let settings = Settings::new(raw)?;
        let agent = settings.values["user_agent"].as_str().unwrap();
        let timeout = settings.values["timeout"].as_f64().unwrap();
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("accept", "application/geo+json".parse().unwrap());
        // HTTPX constructs ASCII headers before validating their HTTP syntax at
        // dispatch. Invalid syntax must become an unavailable component, rather
        // than changing otherwise valid configuration into a startup failure.
        let http = if !agent.is_ascii() {
            Err(invalid(
                "UnicodeEncodeError",
                "NWS User-Agent must be ASCII",
            ))
        } else if agent.starts_with([' ', '\t']) || agent.ends_with([' ', '\t']) {
            Err(invalid(
                "LocalProtocolError",
                "Invalid NWS User-Agent header",
            ))
        } else if let Ok(header) = agent.parse() {
            headers.insert("user-agent", header);
            crate::public_http::Client::anonymous(timeout, 5., 2 * 1024 * 1024, headers)
                .map_err(Invalid::from)
        } else {
            Err(invalid(
                "LocalProtocolError",
                "Invalid NWS User-Agent header",
            ))
        };
        let ttl = settings.values["points_cache_ttl_seconds"]
            .as_f64()
            .unwrap();
        Ok(Self {
            settings,
            service: Arc::new(Service {
                http,
                timeout: Duration::from_secs_f64(timeout),
                ttl,
                cache: Mutex::new(Cache::default()),
            }),
        })
    }
    pub fn schema(&self, name: &str) -> anyhow::Result<Value> {
        self.ready()?;
        self.settings.schema(name)
    }
    fn ready(&self) -> anyhow::Result<()> {
        // The retained registry enters tool factories lazily during request
        // preparation. Header encoding is a factory failure, not a configuration
        // failure at process startup or an unavailable weather component.
        if let Err(error) = &self.service.http
            && error.class == "UnicodeEncodeError"
        {
            return Err(error.clone().into());
        }
        Ok(())
    }
    pub async fn call(&self, raw: &Value) -> anyhow::Result<crate::document_json::Text> {
        self.ready()?;
        let input = super::arguments(raw)?;
        self.weather(&input)
            .await
            .map_err(|error| crate::document_search::Failure::new(error.class).into())
    }
    async fn bounded<T>(
        &self,
        operation: impl std::future::Future<Output = Checked<T>>,
    ) -> Checked<T> {
        tokio::time::timeout(self.service.timeout, operation)
            .await
            .map_err(|_| invalid("TimeoutError", "NWS operation timed out"))?
    }
    async fn weather(&self, input: &Value) -> Checked<crate::document_json::Text> {
        let coordinates = format!(
            "{:.4},{:.4}",
            input["latitude"].as_f64().unwrap(),
            input["longitude"].as_f64().unwrap()
        );
        let points_url = format!("https://api.weather.gov/points/{coordinates}");
        let alerts_url = format!("https://api.weather.gov/alerts/active?point={coordinates}");
        let (point_result, alert_result) = tokio::join!(
            self.bounded(self.point(&points_url)),
            self.bounded(self.service.json(&alerts_url))
        );
        let mut parts = vec![(
            "alerts",
            Part::outcome(
                alert_result.and_then(|reply| alerts(reply, &alerts_url)),
                Some(&alerts_url),
            )?,
        )];
        let observations = input["include_observations"] == true;
        match point_result {
            Err(error) => {
                if error.class == "CancelledError" {
                    return Err(error);
                }
                parts.push(("forecast", Part::unavailable(&error, Some(&points_url))));
                if observations {
                    parts.push(("observations", Part::unavailable(&error, Some(&points_url))));
                }
            }
            Ok(point) => {
                let empty = json!({});
                let properties = super::object(point.payload.get("properties").unwrap_or(&empty))?;
                let relative = super::object(properties.get("relativeLocation").unwrap_or(&empty))?;
                let relative = super::object(relative.get("properties").unwrap_or(&empty))?;
                let mut location = json!({"source_url":points_url,"fetched_at":point.fetched,"timezone":null,"city":null,"state":null});
                location["timezone"] = properties.get("timeZone").cloned().unwrap_or(Value::Null);
                for field in ["city", "state"] {
                    location[field] = relative.get(field).cloned().unwrap_or(Value::Null);
                }
                parts.push(("location", Part::from(location, &point)));
                let forecast = self.bounded(self.forecast(
                    &point,
                    properties,
                    input["days"].as_i64().unwrap(),
                ));
                if observations {
                    let (forecast, observation) = tokio::join!(
                        forecast,
                        self.bounded(self.observations(&point, properties))
                    );
                    parts.push(("forecast", Part::outcome(forecast, None)?));
                    parts.push(("observations", Part::outcome(observation, None)?));
                } else {
                    parts.push(("forecast", Part::outcome(forecast.await, None)?));
                }
            }
        }
        assemble(
            json!({"latitude":input["latitude"],"longitude":input["longitude"]}),
            parts,
        )
    }
    async fn forecast(
        &self,
        point: &Reply,
        properties: &serde_json::Map<String, Value>,
        days: i64,
    ) -> Checked<Part> {
        let url = linked_url(required(properties, "forecast")?, point)?;
        let reply = self.service.json(&url).await?;
        let zone = required(properties, "timeZone")?
            .as_str()
            .ok_or_else(|| invalid("TypeError", "NWS timezone must be a string"))?;
        let value = super::forecast(&reply.payload, &reply.fetched, &url, zone, days, &now())?;
        Ok(Part::from(value, &reply))
    }
    async fn observations(
        &self,
        point: &Reply,
        properties: &serde_json::Map<String, Value>,
    ) -> Checked<Part> {
        let stations_url = linked_url(required(properties, "observationStations")?, point)?;
        let stations = self.service.json(&stations_url).await?;
        let empty_list = json!([]);
        let features = stations.payload.get("features").unwrap_or(&empty_list);
        if !crate::config::truthy(features) {
            return Err(invalid("ValueError", "No observation stations available"));
        }
        let first = match features {
            Value::Array(values) => &values[0],
            Value::Object(_) => return Err(invalid("KeyError", "Missing station index")),
            _ => return Err(invalid("TypeError", "Invalid station features")),
        };
        let station = first
            .as_object()
            .ok_or_else(|| invalid("TypeError", "Invalid station entry"))?;
        let url = linked_url(required(station, "id")?, &stations)?
            .trim_end_matches('/')
            .to_owned()
            + "/observations/latest";
        let reply = self.service.json(&url).await?;
        let empty = json!({});
        let data = super::object(reply.payload.get("properties").unwrap_or(&empty))?;
        let fresh = data
            .get("timestamp")
            .and_then(super::parse_time)
            .is_some_and(|observed| {
                (0..=7_200_000_000).contains(&(now().instant() - observed.instant()))
            });
        let meaningful = ["temperature", "windSpeed", "visibility"]
            .into_iter()
            .any(|key| {
                data.get(key)
                    .and_then(Value::as_object)
                    .and_then(|value| value.get("value"))
                    .is_some_and(|value| !value.is_null())
            });
        let mut fields = json!({});
        for field in [
            "timestamp",
            "textDescription",
            "temperature",
            "relativeHumidity",
            "windDirection",
            "windSpeed",
            "windGust",
            "visibility",
        ] {
            fields[field] = data.get(field).cloned().unwrap_or(Value::Null);
        }
        let mut value = json!({"status":if fresh && meaningful {"ok"} else {"partial"},"source_url":url,"fetched_at":reply.fetched,"freshness":if fresh {"current"} else {"stale_or_unknown"},"observation":null});
        value["observation"] = fields;
        Ok(Part::from(value, &reply))
    }
    async fn point(&self, url: &str) -> Checked<Reply> {
        let receiver = {
            let mut cache = self.service.cache.lock().unwrap();
            if let Some(index) = cache.entries.iter().position(|(key, _, _)| key == url) {
                let cached = cache.entries.remove(index).unwrap();
                if cached.1 > Instant::now() {
                    let result = cached.2.clone();
                    cache.entries.push_back(cached);
                    return Ok(result);
                }
            }
            if let Some(pending) = cache.pending.get(url) {
                Some(pending.receiver.clone())
            } else if cache.pending.len() >= 64 {
                None
            } else {
                let (sender, receiver) = tokio::sync::watch::channel(None);
                let service = Arc::clone(&self.service);
                let key = url.to_owned();
                let task = tokio::spawn(async move {
                    let result = service.load_point(&key).await;
                    // The map owns this task until completion, independently of
                    // any waiter. Dropping/cancelling a waiter never aborts it.
                    let _ = sender.send(Some(result));
                    service.cache.lock().unwrap().pending.remove(&key);
                });
                cache.pending.insert(
                    url.into(),
                    Pending {
                        receiver: receiver.clone(),
                        task,
                    },
                );
                Some(receiver)
            }
        };
        let Some(mut receiver) = receiver else {
            return self.service.load_point(url).await;
        };
        loop {
            if let Some(value) = receiver.borrow().clone() {
                return value;
            }
            receiver
                .changed()
                .await
                .map_err(|_| invalid("CancelledError", "NWS point load cancelled"))?;
        }
    }
    pub async fn close(&self) {
        let pending: Vec<_> = self
            .service
            .cache
            .lock()
            .unwrap()
            .pending
            .drain()
            .map(|(_, pending)| pending.task)
            .collect();
        for task in &pending {
            task.abort();
        }
        for task in pending {
            let _ = task.await;
        }
        self.service.cache.lock().unwrap().entries.clear();
    }
}
impl Drop for Tool {
    fn drop(&mut self) {
        let mut cache = self.service.cache.lock().unwrap();
        for (_, pending) in cache.pending.drain() {
            pending.task.abort();
        }
        cache.entries.clear();
    }
}
impl Service {
    async fn json(&self, url: &str) -> Checked<Reply> {
        let mut current = nws_url(&json!(url))?;
        for _ in 0..6 {
            let http = self.http.as_ref().map_err(Clone::clone)?;
            let response = http.get(&current, &["https"]).await?;
            if !(300..400).contains(&response.status) {
                if !(200..300).contains(&response.status) {
                    return Err(invalid(
                        "HTTPStatusError",
                        "NWS returned an unsuccessful status",
                    ));
                }
                let (payload, markers) = decode(&response.body)?;
                if !payload.is_object() {
                    return Err(invalid("ValueError", "NWS returned a non-object response"));
                }
                return Ok(Arc::new(ResponseData {
                    payload,
                    markers,
                    fetched: now().isoformat(),
                    headers: response.headers,
                }));
            }
            let location = response.headers["location"].as_str().unwrap_or("");
            if !location.is_empty() {
                let normalized = location
                    .trim_start_matches(|c: char| c <= '\u{20}')
                    .replace(['\r', '\n', '\t'], "");
                // Check an explicit authority before WHATWG URL normalization
                // can decode a hostname or discard empty URL credentials.
                if let Some(authority) = normalized.strip_prefix("//") {
                    if !authority
                        .split(['/', '?', '#'])
                        .next()
                        .unwrap_or("")
                        .is_empty()
                    {
                        nws_url(&json!(format!("https:{normalized}")))?;
                    }
                } else if let Some((scheme, rest)) = normalized.split_once(':')
                    && scheme
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_alphabetic)
                    && scheme
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"+-.".contains(&byte))
                    && (!scheme.eq_ignore_ascii_case("https") || rest.starts_with("//"))
                {
                    nws_url(&json!(normalized))?;
                }
                // urllib keeps the base query when the reference consists of
                // an empty query and optional fragment. URL::join clears it.
                let reference = if normalized == "?" || normalized.starts_with("?#") {
                    &normalized[1..]
                } else {
                    normalized.as_str()
                };
                let joined = reqwest::Url::parse(&current)
                    .and_then(|url| url.join(reference))
                    .map_err(|_| invalid("ValueError", "Invalid NWS redirect"))?;
                current = nws_url(&json!(joined.as_str()))?;
            }
        }
        Err(invalid("UnsafeURLError", "Too many NWS redirects"))
    }
    async fn load_point(&self, url: &str) -> Checked<Reply> {
        let result = tokio::time::timeout(self.timeout, self.json(url))
            .await
            .map_err(|_| invalid("TimeoutError", "NWS points timed out"))??;
        let ttl = cache_ttl(&result.headers, self.ttl);
        if ttl > 0. {
            let mut cache = self.cache.lock().unwrap();
            cache.entries.retain(|(key, _, _)| key != url);
            cache.entries.push_back((
                url.to_owned(),
                Instant::now() + Duration::from_secs_f64(ttl),
                result.clone(),
            ));
            while cache.entries.len() > 64 {
                cache.entries.pop_front();
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn state(control: &reqwest::Client) -> Value {
        control
            .get("http://127.0.0.1:9090/state")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn wait(control: &reqwest::Client, key: &str, count: u64) {
        for _ in 0..500 {
            if state(control).await[key].as_u64().unwrap() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("Peer did not reach {key}={count}");
    }
    async fn release(control: &reqwest::Client) {
        control
            .post("http://127.0.0.1:9090/release")
            .json(&json!({}))
            .send()
            .await
            .unwrap();
    }
    fn start(tool: &Arc<Tool>, url: &str) -> tokio::task::JoinHandle<Checked<Reply>> {
        let (tool, url) = (Arc::clone(tool), url.to_owned());
        tokio::spawn(async move { tool.point(&url).await })
    }
    async fn outcome(task: tokio::task::JoinHandle<Checked<Reply>>) -> Checked<Reply> {
        task.await.unwrap_or_else(|error| {
            assert!(error.is_cancelled(), "Point task panicked: {error}");
            Err(invalid("CancelledError", "Synthetic waiter cancellation"))
        })
    }
    async fn lifecycle(tool: &Arc<Tool>, url: &str, mode: &str) -> Vec<Checked<Reply>> {
        let control = reqwest::Client::builder()
            .no_proxy()
            .tls_certs_only(
                reqwest::Certificate::from_pem_bundle(include_bytes!("../resources/public-ca.pem"))
                    .unwrap(),
            )
            .build()
            .unwrap();
        if mode == "concurrent" {
            let tasks: Vec<_> = (0..8).map(|_| start(tool, url)).collect();
            wait(&control, "held", 1).await;
            release(&control).await;
            return futures::future::join_all(tasks.into_iter().map(outcome)).await;
        }
        if mode == "pending_capacity" {
            let tasks: Vec<_> = (0..64)
                .map(|index| {
                    start(
                        tool,
                        &format!("https://api.weather.gov/points/pending-{index}"),
                    )
                })
                .collect();
            wait(&control, "held", 64).await;
            let overflow = vec![start(tool, url), start(tool, url)];
            wait(&control, "held", 66).await;
            for task in &overflow {
                task.abort();
            }
            let mut results = futures::future::join_all(overflow.into_iter().map(outcome)).await;
            wait(&control, "disconnected", 2).await;
            release(&control).await;
            results.extend(futures::future::join_all(tasks.into_iter().map(outcome)).await);
            results.push(tool.point(url).await);
            return results;
        }
        let task = start(tool, url);
        wait(&control, "held", 1).await;
        let second = if mode == "cancel_one" {
            Some(start(tool, url))
        } else {
            None
        };
        tokio::task::yield_now().await;
        let cancelled = if mode == "close" {
            tool.close().await;
            let result = outcome(task).await;
            wait(&control, "disconnected", 1).await;
            result
        } else {
            task.abort();
            let result = outcome(task).await;
            assert_eq!(
                state(&control).await["disconnected"],
                0,
                "Cancelling a waiter closed the shared load"
            );
            result
        };
        release(&control).await;
        let loaded = match second {
            Some(task) => outcome(task).await,
            None => tool.point(url).await,
        };
        vec![cancelled, loaded, tool.point(url).await]
    }
    fn observation(result: Checked<Reply>, times: &mut Vec<String>) -> Value {
        match result {
            Ok(reply) => {
                let index = times
                    .iter()
                    .position(|time| *time == reply.fetched)
                    .unwrap_or_else(|| {
                        times.push(reply.fetched.clone());
                        times.len() - 1
                    });
                let text = crate::document_json::Text::new(
                    crate::memory_tools::json_text(&reply.payload, false, false, true),
                    reply.markers.clone(),
                );
                json!({"ok":text.observation(), "fetch":index, "headers":reply.headers})
            }
            Err(error) => json!({"error":error.class}),
        }
    }
    #[tokio::test]
    #[ignore = "requires isolated NWS DNS/TLS services"]
    async fn actual_service() {
        let raw = std::fs::read(std::env::var("DAEDALUS_PUBLIC_HTTP_CASE").unwrap()).unwrap();
        let case: Value = serde_json::from_slice(&raw).unwrap();
        if case["mode"] == "weather" {
            assert!(
                FIXED_TIME
                    .set(super::super::parse_time(&case["now"]).unwrap())
                    .is_ok()
            );
            let result = match Tool::new(&case["config"]) {
                Err(error) => {
                    json!({"startup_error":error.downcast_ref::<Invalid>().map_or("ValidationError", |error| error.class)})
                }
                Ok(tool) => match tool.schema("nws_weather") {
                    Err(error) => {
                        json!({"startup_error":error.downcast_ref::<Invalid>().map_or("ValueError", |error| error.class)})
                    }
                    Ok(schema) => {
                        let mut results = Vec::new();
                        for input in case["inputs"].as_array().unwrap() {
                            results.push(match tool.call(input).await {
                                Ok(text) => json!({"ok":text.observation()}),
                                Err(error) => {
                                    let failure = error
                                        .downcast_ref::<crate::document_search::Failure>()
                                        .unwrap();
                                    let mut value = json!({"error":failure.class});
                                    if failure.class == "ValidationError" {
                                        value["validation"] = json!(failure.validation);
                                    }
                                    value
                                }
                            });
                        }
                        tool.close().await;
                        json!({"schema":schema,"responses":results})
                    }
                },
            };
            std::fs::write(
                std::env::var("DAEDALUS_PUBLIC_HTTP_OUTPUT").unwrap(),
                serde_json::to_vec(&result).unwrap(),
            )
            .unwrap();
            return;
        }
        let tool = Arc::new(Tool::new(&case["config"]).unwrap());
        tool.schema("nws_weather").unwrap();
        let mut times = Vec::new();
        let mut results = Vec::new();
        if let Some(mode) = case["mode"].as_str() {
            for result in lifecycle(&tool, case["urls"][0].as_str().unwrap(), mode).await {
                results.push(observation(result, &mut times));
            }
        } else {
            for url in case["urls"].as_array().unwrap() {
                let result = tool.point(url.as_str().unwrap()).await;
                results.push(observation(result, &mut times));
                if case["close_each"] == true {
                    tool.close().await;
                }
                if let Some(delay) = case["pause"].as_f64() {
                    tokio::time::sleep(Duration::from_secs_f64(delay)).await;
                }
            }
        }
        tool.close().await;
        std::fs::write(
            std::env::var("DAEDALUS_PUBLIC_HTTP_OUTPUT").unwrap(),
            serde_json::to_vec(&results).unwrap(),
        )
        .unwrap();
    }
}
