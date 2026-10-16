//! Float ranking order compatible with CPython 3.12's list.sort(reverse=True).
//! Adapted from CPython v3.12.3 Objects/listobject.c; see notices/cpython.txt.
//! NaN comparisons are not a total order, so Rust's standard sort may panic.

type Rank = (usize, f64);

fn gallop(key: f64, values: &[Rank], hint: usize, right: bool) -> usize {
    let before = |index: usize| {
        if right {
            key.partial_cmp(&values[index].1) != Some(std::cmp::Ordering::Less)
        } else {
            values[index].1 < key
        }
    };
    let (mut previous, mut step) = (0usize, 1usize);
    let (mut low, mut high);
    if before(hint) {
        let maximum = values.len() - hint;
        while step < maximum && before(hint + step) {
            previous = step;
            step = step.saturating_mul(2).saturating_add(1);
        }
        low = hint + previous + 1;
        high = hint + step.min(maximum);
    } else {
        let maximum = hint + 1;
        while step < maximum && !before(hint - step) {
            previous = step;
            step = step.saturating_mul(2).saturating_add(1);
        }
        low = hint + 1 - step.min(maximum);
        high = hint - previous;
    }
    while low < high {
        let middle = low + (high - low) / 2;
        if before(middle) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

fn merge_low(a: &[Rank], b: &[Rank], threshold: &mut usize) -> Vec<Rank> {
    let mut output = Vec::with_capacity(a.len() + b.len());
    output.push(b[0]);
    let (mut i, mut j) = (0, 1);
    let mut minimum = *threshold;
    'merge: while a.len() - i > 1 && j < b.len() {
        let (mut acount, mut bcount) = (0, 0);
        loop {
            if b[j].1 < a[i].1 {
                output.push(b[j]);
                j += 1;
                bcount += 1;
                acount = 0;
                if j == b.len() {
                    break 'merge;
                }
                if bcount >= minimum {
                    break;
                }
            } else {
                output.push(a[i]);
                i += 1;
                acount += 1;
                bcount = 0;
                if a.len() - i == 1 {
                    break 'merge;
                }
                if acount >= minimum {
                    break;
                }
            }
        }
        minimum += 1;
        loop {
            minimum = minimum.saturating_sub(1).max(1);
            *threshold = minimum;
            acount = gallop(b[j].1, &a[i..], 0, true);
            output.extend_from_slice(&a[i..i + acount]);
            i += acount;
            if a.len() - i <= 1 {
                break 'merge;
            }
            output.push(b[j]);
            j += 1;
            if j == b.len() {
                break 'merge;
            }
            bcount = gallop(a[i].1, &b[j..], 0, false);
            output.extend_from_slice(&b[j..j + bcount]);
            j += bcount;
            if j == b.len() {
                break 'merge;
            }
            output.push(a[i]);
            i += 1;
            if a.len() - i == 1 {
                break 'merge;
            }
            if acount < 7 && bcount < 7 {
                break;
            }
        }
        minimum += 1;
        *threshold = minimum;
    }
    if a.len() - i == 1 {
        output.extend_from_slice(&b[j..]);
        output.push(a[i]);
    } else {
        output.extend_from_slice(&a[i..]);
        output.extend_from_slice(&b[j..]);
    }
    output
}

fn merge_high(a: &[Rank], b: &[Rank], threshold: &mut usize) -> Vec<Rank> {
    let mut output = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (a.len() - 1, b.len());
    output.push(a[i]);
    let mut minimum = *threshold;
    'merge: while i > 0 && j > 1 {
        let (mut acount, mut bcount) = (0, 0);
        loop {
            if b[j - 1].1 < a[i - 1].1 {
                i -= 1;
                output.push(a[i]);
                acount += 1;
                bcount = 0;
                if i == 0 {
                    break 'merge;
                }
                if acount >= minimum {
                    break;
                }
            } else {
                j -= 1;
                output.push(b[j]);
                bcount += 1;
                acount = 0;
                if j == 1 {
                    break 'merge;
                }
                if bcount >= minimum {
                    break;
                }
            }
        }
        minimum += 1;
        loop {
            minimum = minimum.saturating_sub(1).max(1);
            *threshold = minimum;
            acount = i - gallop(b[j - 1].1, &a[..i], i - 1, true);
            output.extend(a[i - acount..i].iter().rev().copied());
            i -= acount;
            if i == 0 {
                break 'merge;
            }
            j -= 1;
            output.push(b[j]);
            if j == 1 {
                break 'merge;
            }
            bcount = j - gallop(a[i - 1].1, &b[..j], j - 1, false);
            output.extend(b[j - bcount..j].iter().rev().copied());
            j -= bcount;
            if j <= 1 {
                break 'merge;
            }
            i -= 1;
            output.push(a[i]);
            if i == 0 {
                break 'merge;
            }
            if acount < 7 && bcount < 7 {
                break;
            }
        }
        minimum += 1;
        *threshold = minimum;
    }
    if j == 1 {
        output.extend(a[..i].iter().rev().copied());
        output.push(b[0]);
    } else {
        output.extend(b[..j].iter().rev().copied());
        output.extend(a[..i].iter().rev().copied());
    }
    output.reverse();
    output
}

struct Run {
    start: usize,
    length: usize,
    power: usize,
}

fn merge(values: &mut [Rank], runs: &mut Vec<Run>, index: usize, threshold: &mut usize) {
    let a = runs[index].start;
    let mut na = runs[index].length;
    let b = runs[index + 1].start;
    let mut nb = runs[index + 1].length;
    runs[index].length += nb;
    runs.remove(index + 1);
    let skip = gallop(values[b].1, &values[a..a + na], 0, true);
    let a = a + skip;
    na -= skip;
    if na == 0 {
        return;
    }
    nb = gallop(values[a + na - 1].1, &values[b..b + nb], nb - 1, false);
    if nb == 0 {
        return;
    }
    let output = if na <= nb {
        merge_low(&values[a..a + na], &values[b..b + nb], threshold)
    } else {
        merge_high(&values[a..a + na], &values[b..b + nb], threshold)
    };
    values[a..b + nb].copy_from_slice(&output);
}

fn power(start: usize, first: usize, second: usize, total: usize) -> usize {
    let mut a = 2 * start as u128 + first as u128;
    let mut b = a + first as u128 + second as u128;
    let total = total as u128;
    let mut depth = 0;
    loop {
        depth += 1;
        if a >= total {
            a -= total;
            b -= total;
        } else if b >= total {
            return depth;
        }
        a *= 2;
        b *= 2;
    }
}

pub fn sort(values: &mut [Rank]) {
    if !values.iter().any(|value| value.1.is_nan()) {
        values.sort_by(|a, b| b.1.partial_cmp(&a.1).expect("non-NaN ranking"));
        return;
    }
    let (mut minimum, mut remainder) = (values.len(), 0);
    while minimum >= 64 {
        remainder |= minimum & 1;
        minimum >>= 1;
    }
    minimum += remainder;
    values.reverse();
    let (mut start, mut threshold) = (0, 7);
    let mut runs: Vec<Run> = Vec::new();
    while start < values.len() {
        let mut length = (values.len() - start).min(2);
        let descending = length == 2 && values[start + 1].1 < values[start].1;
        while start + length < values.len()
            && (values[start + length].1 < values[start + length - 1].1) == descending
        {
            length += 1;
        }
        if descending {
            values[start..start + length].reverse();
        }
        let forced = minimum.min(values.len() - start).max(length);
        for next in start + length..start + forced {
            let pivot = values[next];
            let (mut low, mut high) = (start, next);
            while low < high {
                let middle = low + (high - low) / 2;
                if pivot.1 < values[middle].1 {
                    high = middle;
                } else {
                    low = middle + 1;
                }
            }
            values.copy_within(low..next, low + 1);
            values[low] = pivot;
        }
        length = forced;
        if let Some(last) = runs.last() {
            let depth = power(last.start, last.length, length, values.len());
            while runs.len() > 1 && runs[runs.len() - 2].power > depth {
                let index = runs.len() - 2;
                merge(values, &mut runs, index, &mut threshold);
            }
            runs.last_mut().unwrap().power = depth;
        }
        runs.push(Run {
            start,
            length,
            power: 0,
        });
        start += length;
    }
    while runs.len() > 1 {
        let mut index = runs.len() - 2;
        if index > 0 && runs[index - 1].length < runs[index + 1].length {
            index -= 1;
        }
        merge(values, &mut runs, index, &mut threshold);
    }
    values.reverse();
}

#[cfg(test)]
mod tests {
    #[test]
    fn retained_rank_order() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/reranker-order.json")).unwrap();
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let mut values = case["scores"]
                .as_str()
                .unwrap()
                .split(',')
                .map(|value| value.parse::<f64>().unwrap())
                .enumerate()
                .collect::<Vec<_>>();
            super::sort(&mut values);
            let order = values
                .iter()
                .map(|(index, _)| index.to_string())
                .collect::<Vec<_>>()
                .join(",");
            assert_eq!(
                order,
                case["order"].as_str().unwrap(),
                "retained ranking {index}"
            );
        }
    }
}
