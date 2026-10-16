//! CPython-compatible decoding used by text detection.
//! Detection and the remaining stateful codecs are staged separately.
use anyhow::{Result, anyhow, bail};
use base64::Engine;
use serde_json::Value;
use std::{collections::HashMap, io::Read, sync::LazyLock};

// Finite codecs are exported from the pinned CPython incremental decoders.
// Each row has a three-byte final transition and 256 five-byte transitions:
// next state (u16), output string (u16), and strict-mode failure (u8).
const ROW_BYTES: usize = 3 + 256 * 5;
pub(crate) struct Decoder {
    rows: Vec<u8>,
    strings: Vec<String>,
}
pub(super) fn decompress(parts: &Value) -> Vec<u8> {
    let encoded = parts
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect::<String>();
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(compressed.as_slice())
        .read_to_end(&mut raw)
        .unwrap();
    raw
}
fn word(raw: &[u8], offset: usize) -> usize {
    u16::from_le_bytes([raw[offset], raw[offset + 1]]) as usize
}
impl Decoder {
    pub(crate) fn load(resource: &Value) -> Self {
        let raw = decompress(&resource["data"]);
        assert_eq!(&raw[..4], b"DCD1");
        let states = word(&raw, 4);
        let count = word(&raw, 6);
        assert_eq!(states as u64, resource["states"].as_u64().unwrap());
        assert_eq!(count as u64, resource["strings"].as_u64().unwrap());
        let rows_end = 8 + states * ROW_BYTES;
        let mut offset = rows_end;
        let mut strings = Vec::with_capacity(count);
        for _ in 0..count {
            let length = word(&raw, offset);
            offset += 2;
            strings.push(String::from_utf8(raw[offset..offset + length].to_vec()).unwrap());
            offset += length;
        }
        assert_eq!(offset, raw.len());
        Self {
            rows: raw[8..rows_end].to_vec(),
            strings,
        }
    }
    pub(crate) fn decode(&self, raw: &[u8], ignore: bool) -> Result<String> {
        let mut state = 0;
        let mut output = String::with_capacity(raw.len());
        for byte in raw {
            let offset = state * ROW_BYTES + 3 + *byte as usize * 5;
            if !ignore && self.rows[offset + 4] != 0 {
                bail!("Invalid encoded document text.");
            }
            output.push_str(&self.strings[word(&self.rows, offset + 2)]);
            state = word(&self.rows, offset);
        }
        let offset = state * ROW_BYTES;
        if !ignore && self.rows[offset + 2] != 0 {
            bail!("Invalid encoded document text.");
        }
        output.push_str(&self.strings[word(&self.rows, offset)]);
        Ok(output)
    }
}

struct Gb18030 {
    pairs: Vec<u32>,
    ranges: Vec<[u32; 3]>,
}
fn pair_table(resource: &Value) -> Vec<u32> {
    let raw = decompress(&resource["pairs"]);
    assert_eq!(raw.len(), 128 * 256 * 4);
    raw.chunks_exact(4)
        .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
        .collect()
}
impl Gb18030 {
    fn load(resource: &Value) -> Self {
        Self {
            pairs: pair_table(resource),
            ranges: serde_json::from_value(resource["ranges"].clone()).unwrap(),
        }
    }
    fn decode(&self, mut raw: &[u8], ignore: bool) -> Result<String> {
        let mut output = String::with_capacity(raw.len());
        while let Some(&first) = raw.first() {
            if first < 128 {
                output.push(first as char);
                raw = &raw[1..];
                continue;
            }
            // CPython waits for four bytes after *any* non-ASCII lead followed
            // by a digit, then checks whether the lead byte is in range.
            let four = raw.get(1).is_some_and(u8::is_ascii_digit);
            let width = if four { 4 } else { 2 };
            if raw.len() < width {
                if !ignore {
                    bail!("Invalid encoded document text.");
                }
                break;
            }
            let character = if four {
                if (0x81..=0xfe).contains(&first)
                    && (0x81..=0xfe).contains(&raw[2])
                    && raw[3].is_ascii_digit()
                {
                    let index = (((u32::from(first) - 129) * 10 + u32::from(raw[1]) - 48) * 126
                        + u32::from(raw[2])
                        - 129)
                        * 10
                        + u32::from(raw[3])
                        - 48;
                    let pos = self.ranges.partition_point(|range| range[1] <= index);
                    self.ranges
                        .get(pos)
                        .filter(|range| range[0] <= index)
                        .and_then(|range| char::from_u32(range[2] + index - range[0]))
                } else {
                    None
                }
            } else {
                char::from_u32(self.pairs[(first as usize - 128) * 256 + raw[1] as usize])
            };
            if let Some(character) = character {
                output.push(character);
                raw = &raw[width..];
            } else if ignore {
                raw = &raw[1..];
            } else {
                bail!("Invalid encoded document text.");
            }
        }
        Ok(output)
    }
}

struct EucKr {
    pairs: Vec<u32>,
    selectors: [Vec<u8>; 3],
}
impl EucKr {
    fn load(resource: &Value) -> Self {
        Self {
            pairs: pair_table(resource),
            selectors: serde_json::from_value(resource["selectors"].clone()).unwrap(),
        }
    }
    fn decode(&self, mut raw: &[u8], ignore: bool) -> Result<String> {
        let mut output = String::with_capacity(raw.len());
        while let Some(&first) = raw.first() {
            if first < 128 {
                output.push(first as char);
                raw = &raw[1..];
                continue;
            }
            let compose = raw.starts_with(&[0xa4, 0xd4]);
            let width = if compose { 8 } else { 2 };
            if raw.len() < width {
                if !ignore {
                    bail!("Invalid encoded document text.");
                }
                break;
            }
            let character = if compose {
                [2, 4, 6]
                    .iter()
                    .all(|&i| raw[i] == 0xa4)
                    .then(|| {
                        let mut value = 0;
                        for (selector, byte, multiplier) in [
                            (&self.selectors[0], raw[3], 588),
                            (&self.selectors[1], raw[5], 28),
                            (&self.selectors[2], raw[7], 1),
                        ] {
                            value += selector.iter().position(|v| *v == byte)? as u32 * multiplier;
                        }
                        char::from_u32(0xac00 + value)
                    })
                    .flatten()
            } else {
                char::from_u32(self.pairs[(first as usize - 128) * 256 + raw[1] as usize])
            };
            if let Some(character) = character {
                output.push(character);
                raw = &raw[width..];
            } else if ignore {
                raw = &raw[1..];
            } else {
                bail!("Invalid encoded document text.");
            }
        }
        Ok(output)
    }
}

struct Tables {
    single: HashMap<String, Vec<Option<char>>>,
    multi: HashMap<String, Decoder>,
    gb18030: Gb18030,
    euc_kr: EucKr,
    aliases: HashMap<String, String>,
}
static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let resource: Value =
        serde_json::from_str(include_str!("../resources/document-codecs.json")).unwrap();
    let gb_resource: Value =
        serde_json::from_str(include_str!("../resources/document-codecs-gb18030.json")).unwrap();
    let kr_resource: Value =
        serde_json::from_str(include_str!("../resources/document-codecs-euc-kr.json")).unwrap();
    let u7_resource: Value =
        serde_json::from_str(include_str!("../resources/document-codecs-utf7.json")).unwrap();
    let mut tables = Tables {
        single: resource["single_byte"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, values)| {
                (
                    name.clone(),
                    values
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().and_then(|n| char::from_u32(n as u32)))
                        .collect(),
                )
            })
            .collect(),
        multi: HashMap::new(),
        gb18030: Gb18030::load(&gb_resource),
        euc_kr: EucKr::load(&kr_resource),
        aliases: serde_json::from_value(resource["aliases"].clone()).unwrap(),
    };
    for resource in [&gb_resource, &kr_resource, &u7_resource] {
        tables.aliases.extend(
            serde_json::from_value::<HashMap<String, String>>(resource["aliases"].clone()).unwrap(),
        );
    }
    for source in [
        include_str!("../resources/document-codecs-chinese.json"),
        include_str!("../resources/document-codecs-japanese.json"),
        include_str!("../resources/document-codecs-japanese-extended.json"),
        include_str!("../resources/document-codecs-other.json"),
    ] {
        let resource: Value = serde_json::from_str(source).unwrap();
        tables.aliases.extend(
            serde_json::from_value::<HashMap<String, String>>(resource["aliases"].clone()).unwrap(),
        );
        tables.multi.extend(
            resource["codecs"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(name, value)| (name.clone(), Decoder::load(value))),
        );
    }
    tables
});
pub fn canonical(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase().replace('-', "_");
    if let Some(name) = crate::document_iso2022::canonical(&name) {
        return Some(name);
    }
    TABLES.aliases.get(&name).map(String::as_str)
}
pub fn decode(name: &str, mut raw: &[u8], ignore: bool) -> Result<String> {
    let name = canonical(name).ok_or_else(|| anyhow!("Unsupported text encoding."))?;
    let invalid = || anyhow!("Invalid encoded document text.");
    if name == "utf_7" {
        return crate::document_utf7::decode(raw, ignore)?
            .into_iter()
            .map(|value| char::from_u32(value).ok_or_else(invalid))
            .collect();
    }
    if name.starts_with("iso2022_") {
        return crate::document_iso2022::decode(name, raw, ignore);
    }
    if name == "gb18030" {
        return TABLES.gb18030.decode(raw, ignore);
    }
    if name == "euc_kr" {
        return TABLES.euc_kr.decode(raw, ignore);
    }
    if let Some(decoder) = TABLES.multi.get(name) {
        return decoder.decode(raw, ignore);
    }
    if let Some(table) = TABLES.single.get(name) {
        let mut text = String::with_capacity(raw.len());
        for byte in raw {
            match table[*byte as usize] {
                Some(character) => text.push(character),
                None if ignore => {}
                None => return Err(invalid()),
            }
        }
        return Ok(text);
    }
    if matches!(name, "utf_8" | "utf_8_sig") {
        if name == "utf_8_sig" && raw.starts_with(&[0xef, 0xbb, 0xbf]) {
            raw = &raw[3..];
        }
        if !ignore {
            return String::from_utf8(raw.to_vec()).map_err(|_| invalid());
        }
        let mut text = String::new();
        while !raw.is_empty() {
            match std::str::from_utf8(raw) {
                Ok(valid) => {
                    text.push_str(valid);
                    break;
                }
                Err(error) => {
                    text.push_str(std::str::from_utf8(&raw[..error.valid_up_to()]).unwrap());
                    let Some(skip) = error.error_len() else {
                        break;
                    };
                    raw = &raw[error.valid_up_to() + skip..];
                }
            }
        }
        return Ok(text);
    }
    let utf16 = name.starts_with("utf_16");
    let mut little = !name.ends_with("_be");
    if name == "utf_16" {
        if raw.starts_with(&[0xff, 0xfe]) {
            raw = &raw[2..];
        } else if raw.starts_with(&[0xfe, 0xff]) {
            little = false;
            raw = &raw[2..];
        }
    } else if name == "utf_32" {
        if raw.starts_with(&[0xff, 0xfe, 0, 0]) {
            raw = &raw[4..];
        } else if raw.starts_with(&[0, 0, 0xfe, 0xff]) {
            little = false;
            raw = &raw[4..];
        }
    }
    let width = if utf16 { 2 } else { 4 };
    if !ignore && !raw.len().is_multiple_of(width) {
        return Err(invalid());
    }
    let mut text = String::new();
    if utf16 {
        let words = raw.chunks_exact(2).map(|pair| {
            let pair = [pair[0], pair[1]];
            if little {
                u16::from_le_bytes(pair)
            } else {
                u16::from_be_bytes(pair)
            }
        });
        for character in char::decode_utf16(words) {
            match character {
                Ok(character) => text.push(character),
                Err(_) if ignore => {}
                Err(_) => return Err(invalid()),
            }
        }
    } else if name.starts_with("utf_32") {
        for word in raw.chunks_exact(4) {
            let word = [word[0], word[1], word[2], word[3]];
            let value = if little {
                u32::from_le_bytes(word)
            } else {
                u32::from_be_bytes(word)
            };
            match char::from_u32(value) {
                Some(character) => text.push(character),
                None if ignore => {}
                None => return Err(invalid()),
            }
        }
    } else {
        bail!("Unsupported text encoding.");
    }
    Ok(text)
}

/// Preserve non-scalar code points accepted by the pinned UTF-7 codec. Callers
/// that compare detector candidates or serialize nested JSON must use this
/// representation instead of replacing isolated surrogates with another char.
pub fn codepoints(name: &str, raw: &[u8], ignore: bool) -> Result<Vec<u32>> {
    if canonical(name) == Some("utf_7") {
        return crate::document_utf7::decode(raw, ignore);
    }
    Ok(decode(name, raw, ignore)?.chars().map(u32::from).collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    pub(crate) fn expand(value: &mut Value) {
        if let Some(parts) = value.get("$string_parts").and_then(Value::as_array) {
            *value = json!(
                parts
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<String>()
            );
        } else {
            match value {
                Value::Array(values) => values.iter_mut().for_each(expand),
                Value::Object(values) => values.values_mut().for_each(expand),
                _ => {}
            }
        }
    }
    pub(crate) fn check_fixture(source: &str) {
        let mut fixture: Value = serde_json::from_str(source).unwrap();
        expand(&mut fixture);
        for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let raw = base64::engine::general_purpose::STANDARD
                .decode(case["data"].as_str().unwrap())
                .unwrap();
            let actual = decode(
                case["encoding"].as_str().unwrap(),
                &raw,
                case["ignore"].as_bool().unwrap(),
            );
            if let Some(expected) = case["expected"].get("ok") {
                assert_eq!(
                    json!(actual.unwrap()),
                    *expected,
                    "decoding case {i}: {case}"
                );
            } else {
                assert!(actual.is_err(), "decoding case {i}: {case}");
            }
        }
        if let Some(pairs) = fixture["pairs"].as_array() {
            for pair in pairs {
                let name = pair["encoding"].as_str().unwrap();
                let ignore = pair["ignore"].as_bool().unwrap();
                let mut digest = Sha256::new();
                for n in 0..=u16::MAX {
                    match decode(name, &n.to_be_bytes(), ignore) {
                        Ok(text) => {
                            digest.update([1]);
                            digest.update((text.len() as u32).to_le_bytes());
                            digest.update(text.as_bytes());
                        }
                        Err(_) => digest.update([0]),
                    }
                }
                assert_eq!(
                    format!("{:x}", digest.finalize()),
                    pair["sha256"],
                    "byte pairs {name}, ignore={ignore}"
                );
            }
        }
    }
    #[test]
    fn pinned_cpython_decoding() {
        check_fixture(include_str!("../tests/fixtures/document-codecs.json"));
        assert_eq!(decode("UTF-16", &[0xff, 0xfe, 65, 0], false).unwrap(), "A");
        assert_eq!(decode("Windows-1252", &[0x80], false).unwrap(), "€");
        assert!(decode("unknown", b"", false).is_err());
    }
    #[test]
    fn pinned_cpython_multibyte_decoding() {
        for source in [
            include_str!("../tests/fixtures/document-codecs-chinese.json"),
            include_str!("../tests/fixtures/document-codecs-japanese.json"),
            include_str!("../tests/fixtures/document-codecs-japanese-extended.json"),
            include_str!("../tests/fixtures/document-codecs-other.json"),
        ] {
            check_fixture(source);
        }
        assert_eq!(
            decode("SJIS", &[0x93, 0xfa, 0x96, 0x7b], false).unwrap(),
            "日本"
        );
    }
    #[test]
    fn pinned_cpython_gb18030_decoding() {
        let source = include_str!("../tests/fixtures/document-codecs-gb18030.json");
        check_fixture(source);
        let fixture: Value = serde_json::from_str(source).unwrap();
        for sweep in fixture["four_byte"].as_array().unwrap() {
            let mut digest = Sha256::new();
            for first in 0x81..=0xfe {
                for second in b'0'..=b'9' {
                    for third in 0x81..=0xfe {
                        for fourth in b'0'..=b'9' {
                            match decode(
                                "gb18030",
                                &[first, second, third, fourth],
                                sweep["ignore"].as_bool().unwrap(),
                            ) {
                                Ok(text) => {
                                    digest.update([1]);
                                    digest.update((text.len() as u32).to_le_bytes());
                                    digest.update(text.as_bytes());
                                }
                                Err(_) => digest.update([0]),
                            }
                        }
                    }
                }
            }
            assert_eq!(
                format!("{:x}", digest.finalize()),
                sweep["sha256"],
                "four-byte GB18030: {sweep}"
            );
        }
    }
    #[test]
    fn pinned_cpython_euc_kr_decoding() {
        let source = include_str!("../tests/fixtures/document-codecs-euc-kr.json");
        check_fixture(source);
        let fixture: Value = serde_json::from_str(source).unwrap();
        let seed = base64::engine::general_purpose::STANDARD
            .decode(fixture["mutation_seed"].as_str().unwrap())
            .unwrap();
        for sweep in fixture["mutations"].as_array().unwrap() {
            let mut digest = Sha256::new();
            for position in 0..8 {
                for value in 0..=u8::MAX {
                    let mut raw = seed.clone();
                    raw[position] = value;
                    match decode("euc_kr", &raw, sweep["ignore"].as_bool().unwrap()) {
                        Ok(text) => {
                            digest.update([1]);
                            digest.update((text.len() as u32).to_le_bytes());
                            digest.update(text.as_bytes());
                        }
                        Err(_) => digest.update([0]),
                    }
                }
            }
            assert_eq!(
                format!("{:x}", digest.finalize()),
                sweep["sha256"],
                "EUC-KR composition: {sweep}"
            );
        }
    }
}
