//! Pinned UTF-7 decoding. Code points retain Python's isolated surrogates so the
//! detector and nested NV-Ingest JSON can handle them without replacement.
use anyhow::{Result, bail};

fn digit(byte: u8) -> Option<u32> {
    Some(match byte {
        b'A'..=b'Z' => u32::from(byte - b'A'),
        b'a'..=b'z' => u32::from(byte - b'a' + 26),
        b'0'..=b'9' => u32::from(byte - b'0' + 52),
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    })
}

pub fn decode(raw: &[u8], ignore: bool) -> Result<Vec<u32>> {
    let mut output = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let byte = raw[i];
        i += 1;
        if byte != b'+' {
            if byte < 128 {
                output.push(u32::from(byte));
            } else if !ignore {
                bail!("Invalid encoded document text.");
            }
            continue;
        }
        if raw.get(i) == Some(&b'-') {
            output.push(u32::from(b'+'));
            i += 1;
            continue;
        }
        if raw.get(i).is_some_and(|&byte| digit(byte).is_none()) {
            if !ignore {
                bail!("Invalid encoded document text.");
            }
            i += 1;
            continue;
        }
        let mut buffer = 0_u32;
        let mut bits = 0;
        let mut high = None;
        while let Some(value) = raw.get(i).and_then(|&byte| digit(byte)) {
            i += 1;
            buffer = (buffer << 6) | value;
            bits += 6;
            if bits < 16 {
                continue;
            }
            bits -= 16;
            let value = buffer >> bits;
            buffer &= (1 << bits) - 1;
            if let Some(previous) = high.take() {
                if (0xdc00..=0xdfff).contains(&value) {
                    output.push(0x10000 + (previous - 0xd800) * 1024 + value - 0xdc00);
                    continue;
                }
                output.push(previous);
            }
            if (0xd800..=0xdbff).contains(&value) {
                high = Some(value);
            } else {
                output.push(value);
            }
        }
        let invalid_bits = bits >= 6 || (bits > 0 && buffer != 0);
        if i == raw.len() {
            if !ignore && (invalid_bits || high.is_some()) {
                bail!("Invalid encoded document text.");
            }
            break;
        }
        if invalid_bits {
            if !ignore {
                bail!("Invalid encoded document text.");
            }
            // The terminating byte belongs to this malformed shift sequence.
            i += 1;
            continue;
        }
        if raw[i] < 128
            && let Some(high) = high
        {
            output.push(high);
        }
        // An explicit '-' terminator is consumed; other terminators are read
        // by the ordinary direct-byte/error path on the next iteration.
        if raw[i] == b'-' {
            i += 1;
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    fn digest_result(digest: &mut Sha256, result: Result<Vec<u32>>) {
        match result {
            Ok(values) => {
                digest.update([1]);
                digest.update((values.len() as u32).to_le_bytes());
                for value in values {
                    digest.update(value.to_le_bytes());
                }
            }
            Err(_) => digest.update([0]),
        }
    }
    #[test]
    fn pinned_cpython_utf7_decoding() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/document-codecs-utf7.json"))
                .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let raw = base64::engine::general_purpose::STANDARD
                .decode(case["data"].as_str().unwrap())
                .unwrap();
            let actual =
                crate::document_codecs::codepoints("utf7", &raw, case["ignore"].as_bool().unwrap());
            if let Some(expected) = case["expected"].get("ok") {
                assert_eq!(json!(actual.unwrap()), *expected, "UTF-7 case {i}: {case}");
            } else {
                assert!(actual.is_err(), "UTF-7 case {i}: {case}");
            }
        }
        for sweep in fixture["pairs"].as_array().unwrap() {
            let prefix = base64::engine::general_purpose::STANDARD
                .decode(sweep["prefix"].as_str().unwrap())
                .unwrap();
            let suffix = base64::engine::general_purpose::STANDARD
                .decode(sweep["suffix"].as_str().unwrap())
                .unwrap();
            let mut digest = Sha256::new();
            for n in 0..=u16::MAX {
                let mut raw = prefix.clone();
                raw.extend(n.to_be_bytes());
                raw.extend_from_slice(&suffix);
                digest_result(
                    &mut digest,
                    decode(&raw, sweep["ignore"].as_bool().unwrap()),
                );
            }
            assert_eq!(
                format!("{:x}", digest.finalize()),
                sweep["sha256"],
                "UTF-7 pairs: {sweep}"
            );
        }
        for sweep in fixture["bmp"].as_array().unwrap() {
            let mut digest = Sha256::new();
            for n in 0..=u16::MAX {
                let encoded =
                    base64::engine::general_purpose::STANDARD_NO_PAD.encode(n.to_be_bytes());
                let raw = format!("+{encoded}-");
                digest_result(
                    &mut digest,
                    decode(raw.as_bytes(), sweep["ignore"].as_bool().unwrap()),
                );
            }
            assert_eq!(
                format!("{:x}", digest.finalize()),
                sweep["sha256"],
                "UTF-7 BMP: {sweep}"
            );
        }
    }
}
