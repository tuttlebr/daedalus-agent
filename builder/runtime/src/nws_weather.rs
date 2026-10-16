//! Native NWS settings, validation and forecast coverage contracts.
use crate::{document_search::Failure, memory_tools::trim};
use anyhow::{Result, bail};
use chrono::{Datelike, Offset, TimeZone, Timelike};
use serde_json::{Value, json};
use std::sync::LazyLock;

#[path = "nws_weather_service.rs"]
mod service;
pub use service::Tool;

static CONTRACT: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../resources/nws-weather.json")).unwrap());

pub struct Settings {
    values: Value,
}
impl Settings {
    pub fn new(raw: &Value) -> Result<Self> {
        let mut values = CONTRACT["defaults"].clone();
        for (key, input) in raw
            .as_object()
            .ok_or_else(|| Failure::new("ValidationError"))?
        {
            if key == "_type" && input == "nws_weather" {
                continue;
            }
            let field = CONTRACT["configuration_schema"]["properties"]
                .get(key)
                .ok_or_else(|| Failure::new("ValidationError"))?;
            let value = crate::document_tools::coerce(input, field)?;
            if field.get("minimum").is_some() {
                let number = value
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .ok_or_else(|| Failure::new("ValidationError"))?;
                if field["minimum"]
                    .as_f64()
                    .is_some_and(|minimum| number < minimum)
                    || field["maximum"]
                        .as_f64()
                        .is_some_and(|maximum| number > maximum)
                {
                    bail!("Weather configuration number out of bounds");
                }
            }
            values[key] = value;
        }
        Ok(Self { values })
    }
    fn schema(&self, name: &str) -> Result<Value> {
        let mut schema = CONTRACT["schema"].clone();
        schema["name"] = json!(name);
        if let Some(description) = self.values["description"]
            .as_str()
            .filter(|text| !text.is_empty())
        {
            if trim(description).is_empty() {
                bail!("Tool requires a nonempty model-facing description");
            }
            schema["description"] = json!(description);
        }
        Ok(schema)
    }
}

fn arguments(raw: &Value) -> Result<Value> {
    static INPUT: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
        jsonschema::options()
            .should_validate_formats(false)
            .build(&CONTRACT["schema"]["parameters"])
            .unwrap()
    });
    let schema = &CONTRACT["schema"]["parameters"];
    let mut errors: Vec<_> = INPUT.iter_errors(raw).collect();
    errors.sort_by_key(|error| {
        let mut current = schema;
        error
            .schema_path()
            .to_string()
            .split('/')
            .skip(1)
            .map(|part| {
                let rank = current
                    .as_object()
                    .and_then(|map| map.keys().position(|key| key == part))
                    .unwrap_or(0);
                current = &current[part];
                rank
            })
            .collect::<Vec<_>>()
    });
    let validation: Vec<_> = errors.into_iter().take(8).map(|error| {
        let location: Vec<_> = error.instance_path().to_string().split('/').skip(1).map(|part| json!(part.replace("~1", "/").replace("~0", "~"))).collect();
        let keyword = error.kind().keyword();
        json!({"type":"value_error","loc":location,"msg":format!("Value error, Argument contract: {keyword}"),"ctx":{"error":format!("Argument contract: {keyword}")}})
    }).collect();
    if !validation.is_empty() {
        return Err(Failure {
            class: "ValidationError",
            validation,
        }
        .into());
    }
    let mut result = json!({});
    for (key, field) in schema["properties"].as_object().unwrap() {
        result[key] = if let Some(value) = raw.get(key) {
            crate::document_tools::coerce(value, field)?
        } else {
            field["default"].clone()
        };
    }
    Ok(result)
}

fn cache_ttl(headers: &Value, default: f64) -> f64 {
    let directives = headers["cache-control"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    if headers["set-cookie"]
        .as_str()
        .is_some_and(|text| !text.is_empty())
        || ["no-store", "private", "no-cache"]
            .iter()
            .any(|value| directives.contains(value))
    {
        return 0.;
    }
    static AGE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r#"(?:^|,)\s*max-age\s*=\s*"?(\d+)"#).unwrap());
    let age = headers["age"].as_str().unwrap_or("0");
    let age = if !age.is_empty() && age.bytes().all(|byte| byte.is_ascii_digit()) {
        age.parse::<f64>().unwrap_or(0.)
    } else {
        0.
    };
    let server = AGE
        .captures(&directives)
        .and_then(|capture| capture[1].parse::<f64>().ok())
        .map_or(default, |maximum| (maximum - age).max(0.));
    default.min(server)
}

#[derive(Clone, Debug)]
struct Invalid {
    class: &'static str,
    message: String,
}
impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Invalid {}
type Checked<T> = std::result::Result<T, Invalid>;
fn invalid(class: &'static str, message: impl Into<String>) -> Invalid {
    Invalid {
        class,
        message: message.into(),
    }
}
fn object(value: &Value) -> Checked<&serde_json::Map<String, Value>> {
    value.as_object().ok_or_else(|| {
        invalid(
            "AttributeError",
            format!(
                "'{}' object has no attribute 'get'",
                crate::milvus_serialization::kind(value)
            ),
        )
    })
}

#[derive(Clone)]
pub(crate) struct Time {
    local: chrono::NaiveDateTime,
    offset: i64,
}
impl Time {
    pub(crate) fn instant(&self) -> i64 {
        self.local.and_utc().timestamp_micros() - self.offset
    }
    fn zoned(time: chrono::DateTime<chrono_tz::Tz>) -> Self {
        Self {
            local: time.naive_local(),
            offset: i64::from(time.offset().fix().local_minus_utc()) * 1_000_000,
        }
    }
    fn isoformat(&self) -> String {
        let mut result = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            self.local.year(),
            self.local.month(),
            self.local.day(),
            self.local.hour(),
            self.local.minute(),
            self.local.second()
        );
        let micro = self.local.nanosecond() / 1000;
        if micro != 0 {
            result.push_str(&format!(".{micro:06}"));
        }
        let absolute = self.offset.unsigned_abs();
        result.push(if self.offset < 0 { '-' } else { '+' });
        result.push_str(&format!(
            "{:02}:{:02}",
            absolute / 3_600_000_000,
            absolute / 60_000_000 % 60
        ));
        if !absolute.is_multiple_of(60_000_000) {
            result.push_str(&format!(":{:02}", absolute / 1_000_000 % 60));
            if !absolute.is_multiple_of(1_000_000) {
                result.push_str(&format!(".{:06}", absolute % 1_000_000));
            }
        }
        result
    }
}

pub(crate) fn parse_time(value: &Value) -> Option<Time> {
    let text = value.as_str()?.replace('Z', "+00:00");
    static DATE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"^(\d{4})(?:-(\d{2})-(\d{2})|(\d{2})(\d{2})|-W(\d{2})(?:-(\d))?|W(\d{2})(\d)?)(.)",
        )
        .unwrap()
    });
    static CLOCK: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^([0-9]{2})(?:(:?)([0-9]{2})(?:(:?)([0-9]{2}))?)?(?:[.,]([0-9]+))?$")
            .unwrap()
    });
    let date = DATE.captures(&text)?;
    let year: i32 = date[1].parse().ok()?;
    if !(1..=9999).contains(&year) {
        return None;
    }
    let date_value = if let Some(month) = date.get(2).or_else(|| date.get(4)) {
        let day = date.get(3).or_else(|| date.get(5))?;
        chrono::NaiveDate::from_ymd_opt(
            year,
            month.as_str().parse().ok()?,
            day.as_str().parse().ok()?,
        )?
    } else {
        let week: u32 = date.get(6).or_else(|| date.get(8))?.as_str().parse().ok()?;
        let day: usize = date
            .get(7)
            .or_else(|| date.get(9))
            .map_or("1", |v| v.as_str())
            .parse()
            .ok()?;
        let weekdays = [
            chrono::Weekday::Mon,
            chrono::Weekday::Tue,
            chrono::Weekday::Wed,
            chrono::Weekday::Thu,
            chrono::Weekday::Fri,
            chrono::Weekday::Sat,
            chrono::Weekday::Sun,
        ];
        chrono::NaiveDate::from_isoywd_opt(year, week, *weekdays.get(day.checked_sub(1)?)?)?
    };
    let clock = &text[date.get(0)?.end()..];
    let split = clock.find(['+', '-'])?;
    let parse_clock = |text: &str| -> Option<(u32, u32, u32, u32)> {
        let parts = CLOCK.captures(text)?;
        if let (Some(minute_separator), Some(second_separator)) = (parts.get(2), parts.get(4))
            && minute_separator.as_str() != second_separator.as_str()
        {
            return None;
        }
        let fraction = parts.get(6).map_or("", |v| v.as_str());
        let digits = &fraction[..fraction.len().min(6)];
        let micro = if digits.is_empty() {
            0
        } else {
            digits.parse::<u32>().ok()? * 10_u32.pow(6 - digits.len() as u32)
        };
        Some((
            parts[1].parse().ok()?,
            parts.get(3).map_or("0", |v| v.as_str()).parse().ok()?,
            parts.get(5).map_or("0", |v| v.as_str()).parse().ok()?,
            micro,
        ))
    };
    let (hour, minute, second, micro) = parse_clock(&clock[..split])?;
    if second >= 60 {
        return None;
    }
    let local = date_value.and_hms_micro_opt(hour, minute, second, micro)?;
    let (hour, minute, second, micro) = parse_clock(&clock[split + 1..])?;
    let seconds = i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second);
    // CPython uses timezone.utc when the integral offset is zero, including
    // offsets with a fractional-only suffix.
    let offset = if seconds == 0 {
        0
    } else {
        seconds * 1_000_000 + i64::from(micro)
    };
    if offset >= 86_400_000_000 {
        return None;
    }
    Some(Time {
        local,
        offset: if clock.as_bytes()[split] == b'-' {
            -offset
        } else {
            offset
        },
    })
}

fn nws_url(value: &Value) -> Checked<String> {
    let rejected = || {
        invalid(
            "UnsafeURLError",
            "NWS links must stay on https://api.weather.gov",
        )
    };
    if !crate::config::truthy(value) {
        return Err(rejected());
    }
    let raw = match value {
        Value::String(text) => text.as_str(),
        Value::Null => return Err(rejected()),
        _ => {
            return Err(invalid(
                "AttributeError",
                format!(
                    "'{}' object has no attribute 'decode'",
                    crate::milvus_serialization::kind(value)
                ),
            ));
        }
    };
    let normalized = raw
        .trim_start_matches(|c: char| c <= '\u{20}')
        .replace(['\r', '\n', '\t'], "");
    let (scheme, rest) = normalized
        .split_once(':')
        .unwrap_or(("", normalized.as_str()));
    let authority = rest
        .strip_prefix("//")
        .unwrap_or("")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    if authority.contains('[') != authority.contains(']') {
        return Err(invalid("ValueError", "Invalid IPv6 URL"));
    }
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, value)| value);
    let (host, port) = host_port
        .split_once(':')
        .map_or((host_port, None), |(host, port)| (host, Some(port)));
    if !scheme.eq_ignore_ascii_case("https") || !host.eq_ignore_ascii_case("api.weather.gov") {
        return Err(rejected());
    }
    if let Some(port) = port.filter(|port| !port.is_empty()) {
        if !port.bytes().all(|c| c.is_ascii_digit()) {
            return Err(invalid(
                "ValueError",
                format!("Port could not be cast to integer value as '{port}'"),
            ));
        }
        let port = port
            .parse::<u16>()
            .map_err(|_| invalid("ValueError", "Port out of range 0-65535"))?;
        if port != 443 {
            return Err(rejected());
        }
    }
    if authority.contains('@') {
        return Err(rejected());
    }
    Ok(raw.into())
}

fn forecast(
    payload: &Value,
    fetched: &str,
    source: &str,
    timezone: &str,
    days: i64,
    now: &Time,
) -> Checked<Value> {
    let payload = object(payload)?;
    if timezone.starts_with('/') {
        return Err(invalid(
            "ValueError",
            format!("ZoneInfo keys may not be absolute paths, got: {timezone}"),
        ));
    }
    if timezone.is_empty()
        || timezone
            .split('/')
            .any(|part| part.is_empty() || part == ".")
    {
        return Err(invalid(
            "ValueError",
            format!("ZoneInfo keys must be normalized relative paths, got: {timezone}"),
        ));
    }
    if timezone.split('/').any(|part| part == "..") {
        return Err(invalid(
            "ValueError",
            format!("ZoneInfo keys must refer to subdirectories of TZPATH, got: {timezone}"),
        ));
    }
    let zone: chrono_tz::Tz = timezone.parse().map_err(|_| {
        invalid(
            "ZoneInfoNotFoundError",
            format!("'No time zone found with key {timezone}'"),
        )
    })?;
    let local_now = chrono::DateTime::from_timestamp_micros(now.instant())
        .unwrap()
        .with_timezone(&zone);
    let first = local_now.date_naive();
    let last = first
        .checked_add_signed(chrono::Duration::days(days))
        .ok_or_else(|| invalid("OverflowError", "date value out of range"))?;
    let coverage_end = Time::zoned(
        zone.from_local_datetime(&last.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .ok_or_else(|| invalid("ValueError", "Invalid local coverage boundary"))?,
    );
    let dates: Vec<_> = (0..days)
        .map(|i| (first + chrono::Duration::days(i)).to_string())
        .collect();
    let empty = json!({});
    let properties = object(payload.get("properties").unwrap_or(&empty))?;
    let empty_periods = json!([]);
    let entries = properties.get("periods").unwrap_or(&empty_periods);
    let entries: Vec<Value> = match entries {
        Value::Array(values) => values.clone(),
        Value::Object(values) => values.keys().map(|key| json!(key)).collect(),
        Value::String(value) => value.chars().map(|c| json!(c.to_string())).collect(),
        _ => {
            return Err(invalid(
                "TypeError",
                format!(
                    "'{}' object is not iterable",
                    crate::milvus_serialization::kind(entries)
                ),
            ));
        }
    };
    let mut intervals = Vec::new();
    let mut periods = Vec::new();
    for entry in entries {
        let entry = object(&entry)?;
        let (Some(start), Some(end)) = (
            entry.get("startTime").and_then(parse_time),
            entry.get("endTime").and_then(parse_time),
        ) else {
            continue;
        };
        if end.instant() <= start.instant()
            || end.instant() <= now.instant()
            || start.instant() >= coverage_end.instant()
        {
            continue;
        }
        intervals.push((start, end));
        let mut selected = json!({});
        for field in [
            "name",
            "startTime",
            "endTime",
            "isDaytime",
            "temperature",
            "temperatureUnit",
            "probabilityOfPrecipitation",
            "windSpeed",
            "windDirection",
            "shortForecast",
            "detailedForecast",
        ] {
            selected[field] = entry.get(field).cloned().unwrap_or(Value::Null);
        }
        periods.push(selected);
    }
    intervals.sort_by_key(|(start, end)| (start.instant(), end.instant()));
    let mut gaps = Vec::new();
    let mut cursor = now.clone();
    for (start, end) in intervals {
        if start.instant() > cursor.instant() {
            let end = if start.instant() <= coverage_end.instant() {
                &start
            } else {
                &coverage_end
            };
            gaps.push(json!({"start":cursor.isoformat(),"end":end.isoformat()}));
        }
        if end.instant() > cursor.instant() {
            cursor = end;
        }
    }
    if cursor.instant() < coverage_end.instant() {
        gaps.push(json!({"start":cursor.isoformat(),"end":coverage_end.isoformat()}));
    }
    let issued_at = properties
        .get("updateTime")
        .filter(|value| crate::config::truthy(value))
        .or_else(|| properties.get("generatedAt"))
        .cloned()
        .unwrap_or(Value::Null);
    let stale = parse_time(&issued_at)
        .is_none_or(|issued| now.instant() - issued.instant() > 86_400_000_000);
    let missing = periods.iter().any(|period| {
        period["temperature"].is_null()
            || !crate::config::truthy(&period["temperatureUnit"])
            || !(crate::config::truthy(&period["shortForecast"])
                || crate::config::truthy(&period["detailedForecast"]))
    });
    let mut result = json!({"status":if gaps.is_empty() && !stale && !missing {"ok"} else {"partial"},"source_url":source,"fetched_at":fetched,"issued_at":null,"freshness":if stale {"stale_or_unknown"} else {"current"},"missing_period_values":missing,"timezone":timezone,"coverage":{"dates":dates,"start":Time::zoned(local_now).isoformat(),"end":coverage_end.isoformat(),"today":"remaining_hours","complete":gaps.is_empty(),"gaps":gaps},"periods":[]});
    // Preserve Python JSON numbers, including non-finite values, without
    // passing an already-decoded remote value through serde's strict parser.
    result["issued_at"] = issued_at;
    result["periods"] = Value::Array(periods);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let mut value: Value =
            serde_json::from_str(include_str!("../tests/fixtures/nws-weather.json")).unwrap();
        crate::document_codecs::tests::expand(&mut value);
        value
    }
    #[test]
    fn retained_settings_and_arguments() {
        let fixture = fixture();
        for case in fixture["configuration"].as_array().unwrap() {
            let actual = match Settings::new(&case["input"]) {
                Err(_) => json!({"error":true}),
                Ok(settings) => {
                    let mut value = json!({"ok":settings.values});
                    match settings.schema("configured_weather") {
                        Ok(schema) => value["schema"] = schema,
                        Err(_) => value["schema_error"] = json!("ValueError"),
                    }
                    value
                }
            };
            assert_eq!(actual, case["expected"], "configuration: {}", case["input"]);
        }
        for case in fixture["inputs"].as_array().unwrap() {
            let actual = match arguments(&case["input"]) {
                Err(error) => {
                    let failure = error.downcast_ref::<Failure>().unwrap();
                    json!({"error":failure.class,"validation":failure.validation})
                }
                Ok(input) => {
                    // Mirror only the synthetic offline transport failure. Live
                    // service behavior is verified separately before activation.
                    let coordinates = format!(
                        "{:.4},{:.4}",
                        input["latitude"].as_f64().unwrap(),
                        input["longitude"].as_f64().unwrap()
                    );
                    let point = json!({"status":"unavailable","reason":"RuntimeError","source_url":format!("https://api.weather.gov/points/{coordinates}")});
                    let mut result = json!({"latitude":input["latitude"],"longitude":input["longitude"],"alerts":{"status":"unavailable","reason":"RuntimeError","source_url":format!("https://api.weather.gov/alerts/active?point={coordinates}")},"forecast":point});
                    if input["include_observations"] == true {
                        result["observations"] = point;
                    }
                    result["status"] = json!("unavailable");
                    json!({"ok":crate::memory_tools::json_text(&result,false,false,true)})
                }
            };
            assert_eq!(actual, case["expected"], "input: {}", case["input"]);
        }
    }
    #[test]
    fn retained_cache_ttl() {
        for case in fixture()["cache_ttl"].as_array().unwrap() {
            assert_eq!(
                cache_ttl(&case["headers"], case["default"].as_f64().unwrap()),
                case["expected"].as_f64().unwrap(),
                "{}",
                case["headers"]
            );
        }
    }
    fn observed<T: serde::Serialize>(result: Checked<T>) -> Value {
        match result {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error.class,"message":error.message}),
        }
    }
    #[test]
    fn retained_dates_and_urls() {
        for case in fixture()["times"].as_array().unwrap() {
            assert_eq!(
                json!({"ok":parse_time(&case["input"]).map(|time|time.isoformat())}),
                case["expected"],
                "time: {}",
                case["input"]
            );
        }
        for case in fixture()["urls"].as_array().unwrap() {
            assert_eq!(
                observed(nws_url(&case["input"])),
                case["expected"],
                "URL: {}",
                case["input"]
            );
        }
    }
    #[test]
    fn retained_forecast_coverage() {
        for text in [
            include_str!("../tests/fixtures/nws-weather-forecasts-0.json"),
            include_str!("../tests/fixtures/nws-weather-forecasts-1.json"),
            include_str!("../tests/fixtures/nws-weather-forecasts-2.json"),
            include_str!("../tests/fixtures/nws-weather-forecasts-3.json"),
            include_str!("../tests/fixtures/nws-weather-forecasts-4.json"),
            include_str!("../tests/fixtures/nws-weather-forecasts-5.json"),
        ] {
            let mut fixtures: Value = serde_json::from_str(text).unwrap();
            crate::document_codecs::tests::expand(&mut fixtures);
            for case in fixtures["forecasts"].as_array().unwrap() {
                let now = parse_time(&case["now"]).unwrap();
                let actual = forecast(
                    &case["payload"],
                    case["fetched_at"].as_str().unwrap(),
                    case["source_url"].as_str().unwrap(),
                    case["timezone"].as_str().unwrap(),
                    case["days"].as_i64().unwrap(),
                    &now,
                );
                assert_eq!(
                    observed(actual),
                    case["expected"],
                    "forecast: {} {} {}",
                    case["name"],
                    case["now"],
                    case["timezone"]
                );
            }
        }
    }
}
