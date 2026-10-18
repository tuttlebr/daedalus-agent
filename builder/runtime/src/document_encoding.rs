//! Default charset-normalizer 3.4.9 selection used by NV-Ingest's text reader.
//! Algorithms adapted under the MIT license in notices/charset-normalizer.txt.
use crate::{document_codecs, document_detection, document_iso2022::InternalCodecError};
use anyhow::{Result, anyhow};
use base64::Engine;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock},
};

const LARGE: usize = 10_000_000;
type Text = Arc<Vec<u32>>;
type Coherence = Vec<(String, f64)>;
#[derive(Default, Deserialize)]
struct Encoding {
    multi: bool,
    languages: Vec<String>,
}
struct Tables {
    encodings: Vec<(String, Encoding)>,
    aliases: HashMap<String, String>,
    similar: HashMap<String, Vec<String>>,
    marks: Vec<(String, Vec<u8>)>,
    legacy: HashMap<String, String>,
}
static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let source: Value =
        serde_json::from_str(include_str!("../resources/document-detection.json")).unwrap();
    let mut marks = Vec::new();
    for (name, values) in source["marks"].as_object().unwrap() {
        for value in values.as_array().unwrap() {
            marks.push((
                name.clone(),
                base64::engine::general_purpose::STANDARD
                    .decode(value.as_str().unwrap())
                    .unwrap(),
            ));
        }
    }
    Tables {
        encodings: source["encodings"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, value)| (name.clone(), serde_json::from_value(value.clone()).unwrap()))
            .collect(),
        aliases: serde_json::from_value(source["aliases"].clone()).unwrap(),
        similar: serde_json::from_value(source["similar"].clone()).unwrap(),
        marks,
        legacy: serde_json::from_value(source["chardet"].clone()).unwrap(),
    }
});

fn specified(raw: &[u8]) -> Option<String> {
    static DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)(?:encoding|charset|coding)[:= ]{1,10}["']?([a-zA-Z0-9\-_]+)["']?"#)
            .unwrap()
    });
    let zone: String = raw
        .iter()
        .take(8192)
        .filter(|&&byte| byte < 128)
        .map(|&byte| byte as char)
        .collect();
    for found in DECLARATION.captures_iter(&zone) {
        let name = found[1].to_ascii_lowercase().replace('-', "_");
        if let Some(target) = TABLES.aliases.get(&name) {
            return Some(target.clone());
        }
        if TABLES.aliases.values().any(|target| *target == name) {
            return Some(name);
        }
    }
    None
}
fn attempt(name: &str, raw: &[u8], ignore: bool) -> Result<Option<Text>> {
    match document_codecs::codepoints(name, raw, ignore) {
        Ok(text) => Ok(Some(Arc::new(text))),
        Err(error) if error.is::<InternalCodecError>() => Err(error),
        Err(_) => Ok(None),
    }
}
fn contains(text: &[u32], needle: &[u32]) -> bool {
    needle.is_empty() || text.windows(needle.len()).any(|window| window == needle)
}

#[derive(Clone)]
struct Candidate {
    name: String,
    bom: bool,
    chaos: f64,
    coherence: Coherence,
    text: Option<Text>,
    aliases: Vec<String>,
}
impl Candidate {
    fn less(&self, other: &Self, large: bool) -> bool {
        let chaos_difference = (self.chaos - other.chaos).abs();
        let coherence = self.coherence.first().map_or(0., |(_, value)| *value);
        let other_coherence = other.coherence.first().map_or(0., |(_, value)| *value);
        if chaos_difference < 0.005 && (coherence - other_coherence).abs() > 0.02 {
            coherence > other_coherence
        } else if chaos_difference < 0.005 && !large {
            self.text.as_ref().unwrap().len() < other.text.as_ref().unwrap().len()
        } else {
            self.chaos < other.chaos
        }
    }
    fn label(&self) -> String {
        let name = if self.name == "utf_8" && self.bom {
            "utf_8_sig"
        } else {
            &self.name
        };
        TABLES
            .legacy
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.into())
    }
}
fn append(matches: &mut Vec<Candidate>, mut item: Candidate, large: bool) {
    if !large
        && let Some(previous) = matches
            .iter_mut()
            .find(|previous| previous.chaos == item.chaos && previous.text == item.text)
    {
        previous.aliases.push(item.name);
        return;
    }
    item.aliases.push(item.name.clone());
    // CPython re-sorts an already sorted prefix after each append. Stable binary
    // insertion keeps ties in discovery order and uses its strict-less predicate.
    let mut low = 0;
    let mut high = matches.len();
    while low < high {
        let mid = (low + high) / 2;
        if item.less(&matches[mid], large) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    matches.insert(low, item);
}
fn early_match(
    item: &Candidate,
    specified: Option<&str>,
    tested: &HashSet<String>,
    early: &mut Vec<Candidate>,
    large: bool,
) -> Option<Candidate> {
    if (matches!(item.name.as_str(), "ascii" | "utf_8") || Some(item.name.as_str()) == specified)
        && item.chaos < 0.1
    {
        if item.chaos == 0. {
            return Some(item.clone());
        }
        append(early, item.clone(), large);
    }
    if !early.is_empty()
        && specified.is_none_or(|name| tested.contains(name))
        && tested.contains("ascii")
        && tested.contains("utf_8")
    {
        Some(early[0].clone())
    } else {
        None
    }
}

struct Probe<'a> {
    raw: &'a [u8],
    name: &'a str,
    multi: bool,
    bom: bool,
    strip: bool,
    mark: &'a [u8],
    whole: Option<Text>,
    deferred: bool,
}
impl Probe<'_> {
    fn full(&self) -> Result<Option<Text>> {
        let bytes = if self.strip && self.name != "utf_7" {
            &self.raw[self.mark.len()..]
        } else {
            self.raw
        };
        let mut decoded = attempt(self.name, bytes, false)?;
        if self.name == "utf_7"
            && self.bom
            && let Some(text) = &mut decoded
            && text.first() == Some(&0xfeff)
        {
            Arc::make_mut(text).remove(0);
        }
        Ok(decoded)
    }
    fn chunk(&self, offset: usize, size: usize) -> Result<Option<Text>> {
        if !self.multi
            && let Some(text) = &self.whole
            && !text.is_empty()
        {
            return Ok(Some(Arc::new(
                text[offset.min(text.len())..(offset + size).min(text.len())].to_vec(),
            )));
        }
        if self.deferred {
            let bytes = if self.strip {
                &self.raw[self.mark.len()..]
            } else {
                self.raw
            };
            return attempt(
                self.name,
                &bytes[offset.min(bytes.len())..(offset + size).min(bytes.len())],
                false,
            );
        }
        let end = (offset + size).min(self.raw.len());
        let slice = |start: isize| {
            let start = if start < 0 {
                (self.raw.len() as isize + start).max(0) as usize
            } else {
                start as usize
            };
            let bytes = &self.raw[start.min(end)..end];
            if self.bom && !self.strip {
                [self.mark, bytes].concat()
            } else {
                bytes.to_vec()
            }
        };
        let mut chunk = attempt(self.name, &slice(offset as isize), self.multi)?;
        if self.multi
            && offset > 0
            && let (Some(whole), Some(text)) = (&self.whole, &chunk)
            && !whole.is_empty()
            && !contains(whole, &text[..size.min(16).min(text.len())])
        {
            for start in (offset as isize - 3..=offset as isize).rev() {
                chunk = attempt(self.name, &slice(start), true)?;
                if let Some(text) = &chunk
                    && contains(whole, &text[..size.min(16).min(text.len())])
                {
                    break;
                }
            }
        }
        Ok(chunk)
    }
}

pub fn detect(raw: &[u8]) -> Result<Option<String>> {
    Ok(detect_candidate(raw)?.map(|item| item.label()))
}

fn detect_candidate(raw: &[u8]) -> Result<Option<Candidate>> {
    if raw.is_empty() {
        return Ok(Some(Candidate {
            name: "utf_8".into(),
            bom: false,
            chaos: 0.,
            coherence: Vec::new(),
            text: Some(Arc::new(Vec::new())),
            aliases: Vec::new(),
        }));
    }
    let large = raw.len() >= LARGE;
    let specified = specified(raw);
    let (sig_name, mark) = TABLES
        .marks
        .iter()
        .find(|(_, mark)| raw.starts_with(mark))
        .map_or((None, &[][..]), |(name, mark)| {
            (Some(name.as_str()), mark.as_slice())
        });
    let mut priority = Vec::new();
    priority.extend(specified.iter().cloned());
    priority.extend(sig_name.map(str::to_owned));
    priority.extend(["ascii".into(), "utf_8".into()]);
    priority.extend(TABLES.encodings.iter().map(|(name, _)| name.clone()));
    let mut tested = HashSet::new();
    let mut skip = HashSet::new();
    let mut results = Vec::new();
    let mut early = Vec::new();
    let mut cache: HashMap<Text, (f64, Coherence)> = HashMap::new();
    let mut fallback_specified = None;
    let mut fallback_ascii = None;
    let mut fallback_utf = None;
    let mut definitive = false;
    let mut definitive_languages = HashSet::new();
    let mut later_single = 0;
    let mut definitive_multi = false;
    let steps = if raw.len() <= 2560 { 1 } else { 5 };
    let size = if steps == 1 { raw.len() } else { 512 };
    let extra = Encoding {
        multi: true,
        languages: Vec::new(),
    };
    let unknown = Encoding::default();
    'encoding: for name in priority {
        if !tested.insert(name.clone()) {
            continue;
        }
        let bom = sig_name == Some(name.as_str());
        let strip = bom && !matches!(name.as_str(), "utf_16" | "utf_32");
        if matches!(name.as_str(), "utf_16" | "utf_32" | "utf_7") && !bom {
            continue;
        }
        if skip.contains(&name) {
            continue;
        }
        let meta = TABLES
            .encodings
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value)
            .unwrap_or(if name == "utf_8_sig" {
                &extra
            } else {
                &unknown
            });
        if definitive
            && !meta
                .languages
                .iter()
                .any(|language| definitive_languages.contains(language))
        {
            continue;
        }
        if !meta.multi && ((definitive && later_single >= 7) || definitive_multi) {
            continue;
        }
        let mut probe = Probe {
            raw,
            name: &name,
            multi: meta.multi,
            bom,
            strip,
            mark,
            whole: None,
            deferred: !meta.multi && !large,
        };
        if large && !meta.multi {
            if attempt(
                &name,
                &raw[if strip { mark.len() } else { 0 }..500_000],
                false,
            )?
            .is_none()
            {
                continue;
            }
        } else if !probe.deferred {
            probe.whole = probe.full()?;
            if probe.whole.is_none() {
                continue;
            }
        }
        let offsets: Vec<_> = (if bom { mark.len() } else { 0 }..raw.len())
            .step_by(raw.len() / steps)
            .collect();
        let maximum_bad = (offsets.len() / 4).max(2);
        let mut bad = 0;
        let mut lazy_failure = false;
        let mut chunks = Vec::new();
        let mut ratios = Vec::new();
        for offset in offsets {
            if !probe.deferred
                && (meta.multi || probe.whole.as_ref().is_none_or(|text| text.is_empty()))
                && offset + size > raw.len() + 8
            {
                continue;
            }
            let Some(chunk) = probe.chunk(offset, size)? else {
                if probe.deferred {
                    continue 'encoding;
                }
                lazy_failure = true;
                bad = maximum_bad;
                break;
            };
            if (probe.deferred
                || (!meta.multi && probe.whole.as_ref().is_some_and(|text| !text.is_empty())))
                && chunk.is_empty()
            {
                break;
            }
            let ratio = document_detection::mess_ratio(&chunk, 0.2)?;
            chunks.push(chunk);
            ratios.push(ratio);
            bad += usize::from(ratio >= 0.2);
            if bad >= maximum_bad || (bom && !strip) {
                break;
            }
        }
        if !lazy_failure && large && !meta.multi && attempt(&name, &raw[50_000..], false)?.is_none()
        {
            continue;
        }
        let mean = if ratios.is_empty() {
            0.
        } else {
            document_detection::float_sum(&ratios) / ratios.len() as f64
        };
        if mean >= 0.2 || bad >= maximum_bad {
            if let Some(similar) = TABLES.similar.get(&name) {
                skip.extend(similar.iter().cloned());
            }
            if !lazy_failure
                && (matches!(name.as_str(), "ascii" | "utf_8" | "utf_16" | "utf_32")
                    || specified.as_deref() == Some(&name))
            {
                if probe.whole.is_none() {
                    probe.whole = probe.full()?;
                }
                if probe.whole.is_none() {
                    continue;
                }
                let item = Candidate {
                    name: name.clone(),
                    bom,
                    chaos: 0.2,
                    coherence: Vec::new(),
                    text: if large { None } else { probe.whole },
                    aliases: Vec::new(),
                };
                if specified.as_deref() == Some(&name) {
                    fallback_specified = Some(item);
                } else if name == "ascii" {
                    fallback_ascii = Some(item);
                } else {
                    fallback_utf = Some(item);
                }
            }
            continue;
        }
        if probe.deferred {
            probe.whole = probe.full()?;
            if probe.whole.is_none() {
                continue;
            }
        }
        let retained = if !large
            || name == "ascii"
            || name == "utf_8"
            || specified.as_deref() == Some(&name)
        {
            probe.whole.clone()
        } else {
            None
        };
        if !meta.multi
            && let Some(text) = &probe.whole
            && let Some((chaos, coherence)) = cache.get(text)
        {
            let item = Candidate {
                name: name.clone(),
                bom,
                chaos: *chaos,
                coherence: coherence.clone(),
                text: retained,
                aliases: Vec::new(),
            };
            append(&mut results, item.clone(), large);
            if let Some(best) = early_match(&item, specified.as_deref(), &tested, &mut early, large)
            {
                return Ok(Some(best));
            }
            continue;
        }
        let mut coherence_chunks = Vec::new();
        if name != "ascii" {
            let inclusion = (!meta.languages.is_empty()).then(|| meta.languages.join(","));
            for chunk in &chunks {
                coherence_chunks.push(document_detection::coherence_ratio(
                    chunk,
                    0.1,
                    inclusion.as_deref(),
                )?);
            }
        }
        let coherence = document_detection::merge_coherence(&coherence_chunks);
        let item = Candidate {
            name: name.clone(),
            bom,
            chaos: mean,
            coherence: coherence.clone(),
            text: retained,
            aliases: Vec::new(),
        };
        append(&mut results, item.clone(), large);
        if !meta.multi
            && let Some(text) = &probe.whole
        {
            cache
                .entry(text.clone())
                .or_insert((mean, coherence.clone()));
        }
        if definitive && !meta.multi && mean < 0.02 {
            later_single += 1;
        }
        if let Some(best) = early_match(&item, specified.as_deref(), &tested, &mut early, large) {
            return Ok(Some(best));
        }
        if !definitive
            && !meta.multi
            && coherence.iter().any(|(_, value)| *value >= 0.5)
            && tested.contains("ascii")
            && tested.contains("utf_8")
        {
            definitive = true;
            definitive_languages.extend(meta.languages.iter().cloned());
        }
        if !definitive_multi
            && meta.multi
            && !name.starts_with("utf_")
            && probe
                .whole
                .as_ref()
                .is_some_and(|text| (text.len() as f64) < raw.len() as f64 * 0.98)
            && tested.contains("ascii")
            && tested.contains("utf_8")
        {
            definitive_multi = true;
        }
        if bom {
            return Ok(results
                .iter()
                .find(|item| item.aliases.contains(&name))
                .cloned());
        }
    }
    if results.is_empty()
        && let Some(fallback) = fallback_specified.or(fallback_utf).or(fallback_ascii)
    {
        append(&mut results, fallback, large);
    }
    Ok(results.into_iter().next())
}

pub fn read_text(raw: &[u8]) -> Result<Vec<u32>> {
    let name =
        detect(raw)?.ok_or_else(|| anyhow!("Unable to determine document text encoding."))?;
    document_codecs::codepoints(&name, raw, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn detection_is_total_and_selects_decodable_encodings() {
        // read_text decodes the whole input strictly with the selected label.
        // Hostile bytes, marks and declarations must neither panic detection
        // nor select an encoding that cannot decode the document.
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as usize
        };
        let alphabets: [&[u8]; 6] = [
            b"abcdefghijklmnopqrstuvwxyz      .,\n",
            b"\x1b\x1b$()B@JN.\x0e\x0fabc \n\x80\xa1",
            b"+-ABCabc/+019 \n",
            &[
                0x81, 0x30, 0xfe, 0x39, 0xa1, 0xb0, b' ', b'a', 0xe3, 0x81, 0x82,
            ],
            b"\xe9\xe8\xe0 lorem ipsum caf\xe9 na\xefve \xc3\xa9t\xc3\xa9",
            &[0, 0, 0xfe, 0xff, 0xff, 0xfe, b'a', 0, 0xd8, 0xdc],
        ];
        let prefixes: [&[u8]; 8] = [
            b"",
            b"\xef\xbb\xbf",
            b"\xff\xfe",
            b"\xfe\xff",
            b"\xff\xfe\x00\x00",
            b"+/v8",
            b"\x84\x31\x95\x33",
            b"<meta charset=\"",
        ];
        let declared = [
            "utf-7",
            "shift_jis",
            "iso-2022-jp",
            "big5",
            "cp1252",
            "base64",
            "utf-16",
            "unknown",
        ];
        let mut detected = 0;
        for round in 0..400 {
            let mut raw = prefixes[next() % prefixes.len()].to_vec();
            if raw.ends_with(b"\"") {
                raw.extend(declared[next() % declared.len()].as_bytes());
                raw.extend(b"\">");
            }
            let alphabet = alphabets[next() % alphabets.len()];
            let length = if round % 50 == 0 {
                2600 + next() % 4000
            } else {
                next() % 300
            };
            for _ in 0..length {
                raw.push(if next() % 10 == 0 {
                    next() as u8
                } else {
                    alphabet[next() % alphabet.len()]
                });
            }
            let label = std::panic::catch_unwind(|| detect(&raw))
                .unwrap_or_else(|_| panic!("detection panicked on {raw:?}"));
            if let Ok(Some(label)) = label {
                detected += 1;
                assert!(
                    document_codecs::codepoints(&label, &raw, false).is_ok(),
                    "{label} cannot decode {raw:?}"
                );
            }
        }
        assert!(detected > 50, "only {detected} inputs selected an encoding");
    }
    #[test]
    fn pinned_full_encoding_selection_and_sdk_text() {
        for source in [
            include_str!("../tests/fixtures/document-detection-full-0.json"),
            include_str!("../tests/fixtures/document-detection-full-1.json"),
            include_str!("../tests/fixtures/document-detection-full-2.json"),
        ] {
            let mut fixture: Value = serde_json::from_str(source).unwrap();
            crate::document_codecs::tests::expand(&mut fixture);
            for case in fixture["declarations"].as_array().unwrap() {
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(case["data"].as_str().unwrap())
                    .unwrap();
                assert_eq!(
                    json!(specified(&raw)),
                    case["expected"],
                    "declaration: {case}"
                );
            }
            for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(case["data"].as_str().unwrap())
                    .unwrap()
                    .repeat(case["repeat"].as_u64().unwrap() as usize);
                let selected = detect(&raw);
                if let Some(expected) = case["expected"].get("encoding") {
                    assert_eq!(
                        json!(selected.unwrap()),
                        *expected,
                        "selection {i}: {}",
                        case["label"]
                    );
                } else {
                    assert!(selected.is_err(), "selection {i}: {}", case["label"]);
                }
                let text = read_text(&raw);
                if let Some(expected) = case["expected"].get("text") {
                    let text = text.unwrap();
                    assert_eq!(
                        text.len(),
                        expected["characters"].as_u64().unwrap() as usize,
                        "text length {i}: {}",
                        case["label"]
                    );
                    let mut digest = Sha256::new();
                    for code in text {
                        digest.update(code.to_le_bytes());
                    }
                    assert_eq!(
                        format!("{:x}", digest.finalize()),
                        expected["sha256_utf32le"],
                        "text {i}: {}",
                        case["label"]
                    );
                } else {
                    assert!(text.is_err(), "text {i}: {}", case["label"]);
                }
            }
        }
    }
}
