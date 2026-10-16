//! Stateful ISO-2022 decoding with mappings frozen from CPython 3.12.
use crate::document_codecs::decompress;
use anyhow::{Result, bail};
use serde_json::Value;
use std::{collections::HashMap, sync::LazyLock};

#[derive(Debug)]
pub struct InternalCodecError;
impl std::fmt::Display for InternalCodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Internal text codec error.")
    }
}
impl std::error::Error for InternalCodecError {}

struct Mapping {
    width: usize,
    values: Vec<Option<String>>,
}
struct Codec {
    designations: HashMap<u8, String>,
    g2: HashMap<u8, Vec<Option<String>>>,
}
struct Tables {
    aliases: HashMap<String, String>,
    codecs: HashMap<String, Codec>,
    mappings: HashMap<String, Mapping>,
}
static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let source: Value =
        serde_json::from_str(include_str!("../resources/document-codecs-iso2022.json")).unwrap();
    let mappings = source["mappings"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| {
            let width = value["width"].as_u64().unwrap() as usize;
            let raw = decompress(&value["data"]);
            assert_eq!(raw.len(), 96 * if width == 2 { 256 } else { 1 } * 8);
            let values = raw
                .chunks_exact(8)
                .map(|pair| {
                    let first = u32::from_le_bytes(pair[..4].try_into().unwrap());
                    let second = u32::from_le_bytes(pair[4..].try_into().unwrap());
                    char::from_u32(first).map(|first| {
                        let mut output = first.to_string();
                        if let Some(second) = char::from_u32(second) {
                            output.push(second);
                        }
                        output
                    })
                })
                .collect();
            (key.clone(), Mapping { width, values })
        })
        .collect();
    let codecs = source["codecs"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                Codec {
                    designations: serde_json::from_value(value["designations"].clone()).unwrap(),
                    g2: value
                        .get("g2")
                        .map(|value| serde_json::from_value(value.clone()).unwrap())
                        .unwrap_or_default(),
                },
            )
        })
        .collect();
    Tables {
        aliases: serde_json::from_value(source["aliases"].clone()).unwrap(),
        codecs,
        mappings,
    }
});

pub fn canonical(normalized: &str) -> Option<&'static str> {
    TABLES.aliases.get(normalized).map(String::as_str)
}
fn escape_end(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte == b'@'
}

// Success gives consumed bytes, designation slot, and charset. An error gives
// exactly the number of bytes CPython's ignore handler discards.
fn designation(raw: &[u8], extended: bool) -> std::result::Result<(usize, usize, u8), usize> {
    let mut i = 1;
    let mut length = 0;
    while i < 16 {
        if i >= raw.len() {
            return Err(raw.len());
        }
        if escape_end(raw[i]) {
            length = i + 1;
            break;
        }
        if extended && raw.get(i..i + 2) == Some(b"&@") {
            i += 2;
        }
        i += 1;
    }
    let (slot, mark) = match length {
        0 => return Err(1),
        3 => match raw[1] {
            b'$' => (0, raw[2] | 128),
            b'(' => (0, raw[2]),
            b')' => (1, raw[2]),
            b'.' => (2, raw[2]),
            _ => return Err(length),
        },
        4 if raw[1] == b'$' && matches!(raw[2], b'(' | b')') => {
            (usize::from(raw[2] == b')'), raw[3] | 128)
        }
        6 if extended && &raw[3..6] == b"\x1b$B" => (0, b'B' | 128),
        _ => return Err(length),
    };
    Ok((length, slot, mark))
}

pub fn decode(name: &str, mut raw: &[u8], ignore: bool) -> Result<String> {
    let codec = &TABLES.codecs[name];
    let no_shift = name != "iso2022_kr";
    let use_g2 = name == "iso2022_jp_2";
    let mut slots = [b'B'; 3];
    let mut shifted = false;
    let mut passthrough = false;
    let mut output = String::with_capacity(raw.len());
    while let Some(&first) = raw.first() {
        if passthrough {
            output.push(first as char);
            raw = &raw[1..];
            passthrough = !escape_end(first);
            continue;
        }
        // The loop resolves one token; failed tokens retain charset state.
        let mut invalid = false;
        let consumed = if first == 0x1b {
            if raw.len() < 2 {
                invalid = true;
                raw.len()
            } else if matches!(raw[1], b'(' | b')' | b'$' | b'.' | b'&') {
                match designation(raw, no_shift) {
                    Ok((length, slot, mark)) => {
                        if (slot != 2 || use_g2)
                            && (mark == b'B' || codec.designations.contains_key(&mark))
                        {
                            slots[slot] = mark;
                        } else {
                            invalid = true;
                        }
                        length
                    }
                    Err(skip) => {
                        invalid = true;
                        skip
                    }
                }
            } else if use_g2 && raw[1] == b'N' {
                if raw.len() < 3 {
                    invalid = true;
                    raw.len()
                } else {
                    // Selecting another legal charset into G2 reaches the
                    // pinned codec's internal error, even in ignore mode.
                    let Some(table) = codec.g2.get(&slots[2]) else {
                        return Err(InternalCodecError.into());
                    };
                    if let Some(text) = &table[raw[2] as usize] {
                        output.push_str(text);
                    } else {
                        invalid = true;
                    }
                    3
                }
            } else {
                output.push('\x1b');
                passthrough = true;
                1
            }
        } else if !no_shift && matches!(first, 0x0e | 0x0f) {
            shifted = first == 0x0e;
            1
        } else if first == b'\n' {
            shifted = false;
            output.push('\n');
            1
        } else if first < 32 {
            output.push(first as char);
            1
        } else if first >= 128 {
            invalid = true;
            1
        } else {
            let mark = slots[usize::from(shifted)];
            if mark == b'B' {
                output.push(first as char);
                1
            } else {
                let mapping = &TABLES.mappings[&codec.designations[&mark]];
                if raw.len() < mapping.width {
                    invalid = true;
                    raw.len()
                } else {
                    let index = if mapping.width == 2 {
                        (first as usize - 32) * 256 + raw[1] as usize
                    } else {
                        first as usize - 32
                    };
                    if let Some(text) = &mapping.values[index] {
                        output.push_str(text);
                    } else {
                        invalid = true;
                    }
                    mapping.width
                }
            }
        };
        if invalid && !ignore {
            bail!("Invalid encoded document text.");
        }
        raw = &raw[consumed..];
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    #[test]
    fn pinned_cpython_iso2022_decoding() {
        for source in [
            include_str!("../tests/fixtures/document-codecs-iso2022_jp.json"),
            include_str!("../tests/fixtures/document-codecs-iso2022_jp_1.json"),
            include_str!("../tests/fixtures/document-codecs-iso2022_jp_2.json"),
            include_str!("../tests/fixtures/document-codecs-iso2022_jp_2004.json"),
            include_str!("../tests/fixtures/document-codecs-iso2022_jp_3.json"),
            include_str!("../tests/fixtures/document-codecs-iso2022_jp_ext.json"),
            include_str!("../tests/fixtures/document-codecs-iso2022_kr.json"),
        ] {
            crate::document_codecs::tests::check_fixture(source);
            let fixture: Value = serde_json::from_str(source).unwrap();
            let name = fixture["encoding"].as_str().unwrap();
            for sweep in fixture["prefix_pairs"].as_array().unwrap() {
                let mut digest = Sha256::new();
                let mut raw = base64::engine::general_purpose::STANDARD
                    .decode(sweep["prefix"].as_str().unwrap())
                    .unwrap();
                let end = raw.len();
                raw.extend([0, 0]);
                for n in 0..=u16::MAX {
                    raw[end..].copy_from_slice(&n.to_be_bytes());
                    match decode(name, &raw, sweep["ignore"].as_bool().unwrap()) {
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
                    sweep["sha256"],
                    "{name}: {sweep}"
                );
            }
        }
    }
}
