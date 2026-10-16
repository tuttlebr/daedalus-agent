//! Pinned charset-normalizer 3.4.9 text analysis.
//! Algorithms adapted under the MIT license in notices/charset-normalizer.txt.
use crate::document_codecs::decompress;
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

const PRINTABLE: u32 = 1 << 0;
const ALPHA: u32 = 1 << 1;
const UPPER: u32 = 1 << 2;
const LOWER: u32 = 1 << 3;
const SPACE: u32 = 1 << 4;
const DIGIT: u32 = 1 << 5;
const ASCII: u32 = 1 << 6;
const CASE_VARIABLE: u32 = 1 << 7;
const ACCENT: u32 = 1 << 8;
const LATIN: u32 = 1 << 9;
const CJK: u32 = 1 << 10;
const ARABIC: u32 = 1 << 11;
const GLYPH: u32 = 1 << 12;
const PUNCT: u32 = 1 << 13;
const SYMBOL: u32 = 1 << 14;
const SEPARATOR: u32 = 1 << 15;
const EMOTICON: u32 = 1 << 16;
const SAFE: u32 = 1 << 17;
const COMMON_CJK: u32 = 1 << 18;
const ARABIC_ISOLATED: u32 = 1 << 19;
const CASE_IGNORABLE: u32 = 1 << 20;
const CASED: u32 = 1 << 21;

struct Properties {
    spans: Vec<[u32; 3]>,
    ranges: usize,
    suspicious: Vec<u8>,
    accents: HashMap<u32, Option<u32>>,
    lower: HashMap<u32, Vec<u32>>,
}
static PROPERTIES: LazyLock<Properties> = LazyLock::new(|| {
    let source: Value = serde_json::from_str(include_str!(
        "../resources/document-detection-properties.json"
    ))
    .unwrap();
    let ranges = source["ranges"].as_array().unwrap().len();
    let suspicious = decompress(&source["suspicious"]);
    assert_eq!(suspicious.len(), ranges * ranges);
    Properties {
        spans: serde_json::from_value(source["properties"].clone()).unwrap(),
        ranges,
        suspicious,
        accents: serde_json::from_value(source["accents"].clone()).unwrap(),
        lower: serde_json::from_value(source["lower"].clone()).unwrap(),
    }
});

#[derive(Clone, Copy)]
struct Info {
    code: u32,
    flags: u32,
    range: usize,
}
impl Info {
    fn has(self, flag: u32) -> bool {
        self.flags & flag != 0
    }
    fn accent(self) -> Result<u32> {
        PROPERTIES
            .accents
            .get(&self.code)
            .copied()
            .unwrap_or(Some(self.code))
            .ok_or_else(|| anyhow!("Invalid text accent decomposition."))
    }
}
fn info(code: u32) -> Info {
    let index = PROPERTIES.spans.partition_point(|span| span[0] <= code) - 1;
    let span = PROPERTIES.spans[index];
    Info {
        code,
        flags: span[1],
        range: span[2] as usize,
    }
}
fn suspicious(a: usize, b: usize) -> bool {
    PROPERTIES.suspicious[a * PROPERTIES.ranges + b] != 0
}
fn fraction(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.
    } else {
        numerator as f64 / denominator as f64
    }
}
fn round(value: f64, places: usize) -> f64 {
    // Decimal formatting rounds the original binary float. Multiplying before
    // round_ties_even would introduce different halfway cases from Python.
    format!("{value:.places$}").parse().unwrap()
}
pub(super) fn float_sum(values: &[f64]) -> f64 {
    // CPython 3.12 uses Neumaier compensation for built-in sum(float values).
    // Detector means near decimal rounding boundaries depend on this detail.
    let mut sum: f64 = 0.;
    let mut correction = 0.;
    for &value in values {
        let next = sum + value;
        correction += if sum.abs() >= value.abs() {
            (sum - next) + value
        } else {
            (value - next) + sum
        };
        sum = next;
    }
    if correction != 0. && correction.is_finite() {
        sum += correction;
    }
    sum
}

#[derive(Default)]
struct Word {
    words: usize,
    foreign: usize,
    characters: usize,
    bad_characters: usize,
    length: usize,
    accents: usize,
    glyphs: usize,
    upper: usize,
    last: Option<Info>,
    first_lower: bool,
    non_ascii: bool,
    bad: bool,
    foreign_watch: bool,
}
impl Word {
    fn feed(&mut self, info: Info) {
        if info.has(ALPHA) {
            if self.length == 0 {
                self.first_lower = info.has(LOWER);
            }
            self.length += 1;
            self.last = Some(info);
            self.upper += usize::from(info.has(UPPER));
            self.non_ascii |= !info.has(ASCII);
            self.accents += usize::from(info.has(ACCENT));
            self.glyphs += usize::from(info.has(GLYPH));
            self.foreign_watch |= (!info.has(LATIN) || info.has(ACCENT)) && !info.has(GLYPH);
            return;
        }
        if self.length == 0 {
            return;
        }
        if info.has(SPACE | PUNCT | SEPARATOR) {
            self.words += 1;
            self.characters += self.length;
            if self.length >= 4 {
                if fraction(self.accents, self.length) >= 0.5 {
                    self.bad = true;
                } else if (self
                    .last
                    .is_some_and(|last| last.has(ACCENT) && last.has(UPPER))
                    && self.upper != self.length)
                    || self.glyphs == 1
                    || (self.non_ascii && self.first_lower && self.upper == self.length - 1)
                {
                    self.foreign += 1;
                    self.bad = true;
                }
            }
            if self.length >= 24
                && self.foreign_watch
                && !(self.upper > 0 && fraction(self.upper, self.length) <= 0.3)
            {
                self.foreign += 1;
                self.bad = true;
            }
            if self.bad {
                self.bad_characters += self.length;
            }
            self.length = 0;
            self.last = None;
            self.accents = 0;
            self.glyphs = 0;
            self.upper = 0;
            self.first_lower = false;
            self.non_ascii = false;
            self.bad = false;
            self.foreign_watch = false;
        } else if ![b'<', b'>', b'-', b'=', b'~', b'|', b'_']
            .iter()
            .any(|&c| u32::from(c) == info.code)
            && !info.has(DIGIT)
            && info.has(SYMBOL)
        {
            self.bad = true;
            self.length += 1;
            self.last = Some(info);
        }
    }
    fn ratio(&self) -> f64 {
        if self.words <= 10 && self.foreign == 0 {
            0.
        } else {
            fraction(self.bad_characters, self.characters)
        }
    }
}

struct AlternatingCase {
    buffered: bool,
    since_separator: usize,
    successive: usize,
    final_count: usize,
    characters: usize,
    last: Option<Info>,
    ascii_only: bool,
}
impl Default for AlternatingCase {
    fn default() -> Self {
        Self {
            buffered: false,
            since_separator: 0,
            successive: 0,
            final_count: 0,
            characters: 0,
            last: None,
            ascii_only: true,
        }
    }
}
impl AlternatingCase {
    fn feed(&mut self, info: Info) {
        if !(info.has(ALPHA) && info.has(CASE_VARIABLE)) && self.since_separator > 0 {
            if self.since_separator <= 64 && !info.has(DIGIT) && !self.ascii_only {
                self.final_count += self.successive;
            }
            self.successive = 0;
            self.since_separator = 0;
            self.last = None;
            self.buffered = false;
            self.characters += 1;
            self.ascii_only = true;
            return;
        }
        self.ascii_only &= info.has(ASCII);
        if let Some(last) = self.last {
            if (info.has(UPPER) && last.has(LOWER)) || (info.has(LOWER) && last.has(UPPER)) {
                if self.buffered {
                    self.successive += 2;
                    self.buffered = false;
                } else {
                    self.buffered = true;
                }
            } else {
                self.buffered = false;
            }
        }
        self.characters += 1;
        self.since_separator += 1;
        self.last = Some(info);
    }
    fn ratio(&self) -> f64 {
        fraction(self.final_count, self.characters)
    }
}

#[derive(Default)]
struct Chaos {
    total: usize,
    unprintable: usize,
    printable: usize,
    symbols: usize,
    last_printable: Option<u32>,
    alpha: usize,
    accents: usize,
    latin: usize,
    duplicate: usize,
    last_latin: Option<Info>,
    last_range: Option<usize>,
    range_changes: usize,
    cjk: usize,
    uncommon: usize,
    arabic: usize,
    isolated: usize,
    word: Word,
    case: AlternatingCase,
}
impl Chaos {
    fn unprintable(&mut self, info: Info) {
        self.total += 1;
        if !info.has(SPACE | PRINTABLE) && ![0x1a, 0xfeff].contains(&info.code) {
            self.unprintable += 1;
        }
    }
    fn feed(&mut self, info: Info, ascii: bool) -> Result<()> {
        self.unprintable(info);
        self.word.feed(info);
        if !ascii {
            self.case.feed(info);
        }
        if info.has(PRINTABLE) {
            self.printable += 1;
            if self.last_printable != Some(info.code) && !info.has(SAFE) {
                if info.has(PUNCT) {
                    self.symbols += 1;
                } else if !info.has(DIGIT) && info.has(SYMBOL) && !info.has(EMOTICON) {
                    self.symbols += 2;
                }
            }
            self.last_printable = Some(info.code);
            if !ascii {
                if info.has(SPACE | PUNCT | SAFE) {
                    self.last_range = None;
                } else {
                    if let Some(last) = self.last_range
                        && suspicious(last, info.range)
                    {
                        self.range_changes += 1;
                    }
                    self.last_range = Some(info.range);
                }
            }
        }
        if ascii || !info.has(ALPHA) {
            return Ok(());
        }
        self.alpha += 1;
        self.accents += usize::from(info.has(ACCENT));
        if info.has(LATIN) {
            self.latin += 1;
            if let Some(last) = self.last_latin
                && info.has(ACCENT)
                && last.has(ACCENT)
            {
                self.duplicate += usize::from(info.has(UPPER) && last.has(UPPER));
                self.duplicate += usize::from(info.accent()? == last.accent()?);
            }
            self.last_latin = Some(info);
        }
        if info.has(CJK) {
            self.cjk += 1;
            self.uncommon += usize::from(!info.has(COMMON_CJK));
        }
        if info.has(ARABIC) {
            self.arabic += 1;
            self.isolated += usize::from(info.has(ARABIC_ISOLATED));
        }
        Ok(())
    }
    fn ratio(&self) -> f64 {
        let symbols = fraction(self.symbols, self.printable);
        let accents = fraction(self.accents, self.alpha);
        let uncommon = fraction(self.uncommon, self.cjk);
        (if symbols >= 0.3 { symbols } else { 0. })
            + (if self.alpha >= 8 && accents >= 0.35 {
                accents
            } else {
                0.
            })
            + fraction(self.unprintable * 8, self.total)
            + fraction(self.duplicate * 2, self.latin)
            + (if self.printable > 13 {
                fraction(self.range_changes * 2, self.printable)
            } else {
                0.
            })
            + self.word.ratio()
            + (if self.cjk >= 8 && uncommon > 0.5 {
                uncommon / 10.
            } else {
                0.
            })
            + self.case.ratio()
            + (if self.arabic >= 8 {
                fraction(self.isolated, self.arabic)
            } else {
                0.
            })
    }
}

pub fn mess_ratio(text: &[u32], maximum: f64) -> Result<f64> {
    let step = if text.len() < 511 {
        32
    } else if text.len() < 1024 {
        64
    } else {
        128
    };
    let ascii = text.iter().all(|&n| n < 128);
    let mut state = Chaos::default();
    for block in text.chunks(step) {
        for &code in block {
            state.feed(info(code), ascii)?;
        }
        let ratio = state.ratio();
        if ratio >= maximum {
            return Ok(round(ratio, 3));
        }
    }
    let newline = info(10);
    state.word.feed(newline);
    if !ascii {
        state.case.feed(newline);
    }
    state.unprintable(newline);
    Ok(round(state.ratio(), 3))
}

type Coherence = Vec<(String, f64)>;
struct Language {
    name: String,
    rank: HashMap<u32, usize>,
    length: usize,
    accents: bool,
    latin: bool,
}
static LANGUAGES: LazyLock<Vec<Language>> = LazyLock::new(|| {
    let source: Value =
        serde_json::from_str(include_str!("../resources/document-detection.json")).unwrap();
    source["frequencies"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| {
            let characters: Vec<u32> = value
                .as_array()
                .unwrap()
                .iter()
                .map(|value| u32::from(value.as_str().unwrap().chars().next().unwrap()))
                .collect();
            Language {
                name: name.clone(),
                rank: characters
                    .iter()
                    .copied()
                    .enumerate()
                    .map(|(i, code)| (code, i))
                    .collect(),
                length: characters.len(),
                accents: characters.iter().any(|&code| info(code).has(ACCENT)),
                latin: characters.iter().all(|&code| info(code).has(LATIN)),
            }
        })
        .collect()
});

pub(crate) fn lowercase(text: &[u32]) -> Vec<u32> {
    let mut output = Vec::with_capacity(text.len());
    for (i, &code) in text.iter().enumerate() {
        if code == 0x3a3 {
            // Unicode's contextual final sigma is the only locale-independent
            // lowercasing rule that cannot be represented by a per-codepoint map.
            let before = text[..i]
                .iter()
                .rev()
                .map(|&code| info(code))
                .find(|info| !info.has(CASE_IGNORABLE));
            let after = text[i + 1..]
                .iter()
                .map(|&code| info(code))
                .find(|info| !info.has(CASE_IGNORABLE));
            let final_sigma = before.is_some_and(|info| info.has(CASED))
                && !after.is_some_and(|info| info.has(CASED));
            output.push(if final_sigma { 0x3c2 } else { 0x3c3 });
        } else if let Some(lower) = PROPERTIES.lower.get(&code) {
            output.extend(lower);
        } else {
            output.push(code);
        }
    }
    output
}

fn alpha_layers(text: &[u32]) -> Vec<Vec<u32>> {
    let mut layers: Vec<(usize, Vec<u32>)> = Vec::new();
    for &code in text {
        let info = info(code);
        if !info.has(ALPHA) || info.range == 0 {
            continue;
        }
        if let Some((_, text)) = layers
            .iter_mut()
            .find(|(range, _)| !suspicious(*range, info.range))
        {
            text.push(code);
        } else {
            layers.push((info.range, vec![code]));
        }
    }
    layers
        .into_iter()
        .map(|(_, text)| lowercase(&text))
        .collect()
}

fn alphabet_languages(characters: &[u32], latin_only: bool) -> Vec<&'static Language> {
    let characters: HashSet<u32> = characters.iter().copied().collect();
    let accented = characters.iter().any(|&code| info(code).has(ACCENT));
    let mut candidates: Vec<_> = LANGUAGES
        .iter()
        .filter_map(|language| {
            if (latin_only && !language.latin) || (accented && !language.accents) {
                return None;
            }
            let common = language
                .rank
                .keys()
                .filter(|code| characters.contains(code))
                .count();
            let ratio = fraction(common, language.length);
            (ratio >= 0.2).then_some((language, ratio))
        })
        .collect();
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
    candidates
        .into_iter()
        .map(|(language, _)| language)
        .collect()
}

fn popularity(language: &Language, characters: &[u32]) -> f64 {
    let large = language.length > 26;
    let projection = fraction(language.length, characters.len());
    let common: Vec<_> = characters
        .iter()
        .enumerate()
        .filter_map(|(i, code)| language.rank.get(code).map(|&rank| (rank, i)))
        .collect();
    let mut approved = 0;
    for &(rank, order) in &common {
        let projected = (order as f64 * projection) as usize;
        let distance = projected.abs_diff(rank);
        if !large && distance > 4 {
            continue;
        }
        if (large && (distance as f64) < language.length as f64 / 3.) || rank == 0 {
            approved += 1;
            continue;
        }
        let after_length = language.length - rank;
        let mut before = 0;
        let mut after = 0;
        for &(other_rank, other_order) in &common {
            if other_rank < rank {
                if other_order < order {
                    before += 1;
                    if 5 * before >= 2 * rank {
                        approved += 1;
                        break;
                    }
                }
            } else if other_order >= order {
                after += 1;
                if 5 * after >= 2 * after_length {
                    approved += 1;
                    break;
                }
            }
        }
    }
    fraction(approved, characters.len())
}

pub fn coherence_ratio(text: &[u32], threshold: f64, inclusion: Option<&str>) -> Result<Coherence> {
    let mut results = Vec::new();
    let mut sufficient = 0;
    let included: Vec<&str> = inclusion
        .map(|v| v.split(',').collect())
        .unwrap_or_default();
    let latin_only = included.contains(&"Latin Based");
    let selected: Vec<_> = included
        .into_iter()
        .filter(|name| *name != "Latin Based")
        .map(|name| {
            LANGUAGES
                .iter()
                .find(|language| language.name == name)
                .ok_or_else(|| anyhow!("Unknown detector language."))
        })
        .collect::<Result<_>>()?;
    for layer in alpha_layers(text) {
        if layer.len() <= 32 {
            continue;
        }
        let mut order: Vec<(u32, usize)> = Vec::new();
        let mut index = HashMap::new();
        for code in layer {
            let next = order.len();
            let position = *index.entry(code).or_insert_with(|| {
                order.push((code, 0));
                next
            });
            order[position].1 += 1;
        }
        order.sort_by_key(|item| std::cmp::Reverse(item.1));
        let characters: Vec<u32> = order.into_iter().map(|(code, _)| code).collect();
        let languages = if selected.is_empty() {
            alphabet_languages(&characters, latin_only)
        } else {
            selected.clone()
        };
        for language in languages {
            let ratio = popularity(language, &characters);
            if ratio < threshold {
                continue;
            }
            sufficient += usize::from(ratio >= 0.8);
            results.push((language.name.clone(), round(ratio, 4)));
            if sufficient >= 3 {
                break;
            }
        }
    }
    // The retained helper only removes the alternative-name suffix when at
    // least two matches collapse to the same base language.
    let mut folded: Coherence = Vec::new();
    let mut duplicate = false;
    for (name, ratio) in &results {
        let name = name.replace('—', "");
        if let Some((_, previous)) = folded.iter_mut().find(|(key, _)| *key == name) {
            *previous = previous.max(*ratio);
            duplicate = true;
        } else {
            folded.push((name, *ratio));
        }
    }
    if duplicate {
        results = folded;
    }
    results.sort_by(|a, b| b.1.total_cmp(&a.1));
    Ok(results)
}

pub fn merge_coherence(chunks: &[Coherence]) -> Coherence {
    let mut languages: Vec<(String, Vec<f64>)> = Vec::new();
    for chunk in chunks {
        for (name, ratio) in chunk {
            if let Some((_, ratios)) = languages.iter_mut().find(|(key, _)| key == name) {
                ratios.push(*ratio);
            } else {
                languages.push((name.clone(), vec![*ratio]));
            }
        }
    }
    let mut results: Coherence = languages
        .into_iter()
        .map(|(name, ratios)| (name, round(float_sum(&ratios) / ratios.len() as f64, 4)))
        .collect();
    results.sort_by(|a, b| b.1.total_cmp(&a.1));
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn pinned_cpython_properties_and_chaos() {
        let codecs: Value =
            serde_json::from_str(include_str!("../resources/document-detection.json")).unwrap();
        for name in codecs["encodings"].as_object().unwrap().keys() {
            assert!(
                crate::document_codecs::canonical(name).is_some(),
                "missing pinned codec {name}"
            );
        }
        let source: Value = serde_json::from_str(include_str!(
            "../resources/document-detection-properties.json"
        ))
        .unwrap();
        let mut digest = Sha256::new();
        for code in 0..0x110000 {
            let info = info(code);
            digest.update(info.flags.to_le_bytes());
            digest.update((info.range as u16).to_le_bytes());
        }
        assert_eq!(
            format!("{:x}", digest.finalize()),
            source["properties_sha256"]
        );
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/document-detection-chaos.json"
        ))
        .unwrap();
        for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let raw = decompress(&case["codepoints"]);
            let text: Vec<u32> = raw
                .chunks_exact(4)
                .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
                .collect();
            for check in case["results"].as_array().unwrap() {
                let result = mess_ratio(&text, check["threshold"].as_f64().unwrap());
                if let Some(expected) = check["expected"].get("ok") {
                    assert_eq!(
                        result.unwrap(),
                        expected.as_f64().unwrap(),
                        "chaos case {i}: {check}"
                    );
                } else {
                    assert!(result.is_err(), "chaos case {i}: {check}");
                }
            }
        }
    }
    #[test]
    fn pinned_language_coherence() {
        for source in [
            include_str!("../tests/fixtures/document-detection-coherence-0.json"),
            include_str!("../tests/fixtures/document-detection-coherence-1.json"),
            include_str!("../tests/fixtures/document-detection-coherence-2.json"),
        ] {
            let fixture: Value = serde_json::from_str(source).unwrap();
            for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
                let raw = decompress(&case["codepoints"]);
                let text: Vec<u32> = raw
                    .chunks_exact(4)
                    .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
                    .collect();
                assert_eq!(
                    json!(alpha_layers(&text)),
                    case["layers"],
                    "alpha layers {i}"
                );
                for check in case["checks"].as_array().unwrap() {
                    let result = coherence_ratio(
                        &text,
                        check["threshold"].as_f64().unwrap(),
                        check["inclusion"].as_str(),
                    )
                    .unwrap();
                    assert_eq!(
                        json!(result),
                        check["expected"],
                        "coherence case {i}: {check}"
                    );
                }
            }
            for check in fixture["merges"].as_array().unwrap() {
                let chunks: Vec<Coherence> =
                    serde_json::from_value(check["input"].clone()).unwrap();
                assert_eq!(
                    json!(merge_coherence(&chunks)),
                    check["expected"],
                    "merge: {check}"
                );
            }
        }
    }
}
