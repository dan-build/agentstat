//! Number helpers that match JavaScript exactly, so messages and scores are
//! identical to the TypeScript library's.

/// `Math.round`: halves round toward +∞.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// An integer-valued number as JavaScript prints it in a template (`-0` → "0").
pub fn js_int(x: f64) -> String {
    let r = js_round(x);
    if r == 0.0 { "0".into() } else { format!("{r}") }
}

/// `Number.prototype.toFixed`: rounds the exact value, halves away from zero
/// (Rust's formatting rounds exact halves to even, so ties are fixed up).
pub fn to_fixed(x: f64, digits: usize) -> String {
    // JavaScript prints -0 as 0.
    let x = if x == 0.0 { 0.0 } else { x };
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let s = format!("{:.*}", digits, x);
    // An exact tie has exactly digits+1 fractional digits, ending in 5.
    let long = format!("{:.*}", digits + 40, x.abs());
    let frac = long.split('.').nth(1).unwrap_or("");
    let tie = frac.len() > digits && &frac[digits..digits + 1] == "5" && frac[digits + 1..].bytes().all(|b| b == b'0');
    if !tie {
        return s;
    }
    let down = format!("{:.*}", digits, truncate(x.abs(), digits));
    let rounded_down = s.trim_start_matches('-') == down;
    if !rounded_down {
        return s;
    }
    let up = increment(&down);
    if x < 0.0 { format!("-{up}") } else { up }
}

fn truncate(x: f64, digits: usize) -> f64 {
    let s = format!("{:.*}", digits + 40, x);
    let (int, frac) = s.split_once('.').unwrap_or((&s, ""));
    format!("{int}.{}", &frac[..digits.min(frac.len())]).parse().unwrap_or(x)
}

/// Add one unit in the last place of a decimal string ("2.49" → "2.50").
fn increment(s: &str) -> String {
    let mut b = s.as_bytes().to_vec();
    let mut i = b.len();
    loop {
        if i == 0 {
            b.insert(0, b'1');
            break;
        }
        i -= 1;
        match b[i] {
            b'.' => continue,
            b'9' => b[i] = b'0',
            d => {
                b[i] = d + 1;
                break;
            }
        }
    }
    String::from_utf8(b).unwrap_or_default()
}

/// Mean of a slice, summed left to right (0 for empty).
pub fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() { 0.0 } else { xs.iter().sum::<f64>() / xs.len() as f64 }
}

/// The q-quantile (0–1), linearly interpolated; 0 for empty.
pub fn quantile(values: &[f64], q: f64) -> f64 {
    let n = values.len();
    if n == 0 {
        return 0.0;
    }
    let mut s = values.to_vec();
    s.sort_by(f64::total_cmp);
    let pos = q.clamp(0.0, 1.0) * (n - 1) as f64;
    let lo = pos.floor() as usize;
    s[lo] + (s[(lo + 1).min(n - 1)] - s[lo]) * (pos - lo as f64)
}

/// `clamp` from `src/core/constants.ts`: max(lo, min(hi, v)).
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    lo.max(hi.min(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_like_javascript() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_int(-0.2), "0");
        assert_eq!(js_int(12.0), "12");
    }

    #[test]
    fn to_fixed_like_javascript() {
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00"); // 1.005 is just below the tie in binary
        assert_eq!(to_fixed(9.95, 1), "9.9"); // likewise
        assert_eq!(to_fixed(3.0, 1), "3.0");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(99.5, 0), "100");
        assert_eq!(to_fixed(12.34, 0), "12");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
    }

    #[test]
    fn quantile_interpolates() {
        assert_eq!(quantile(&[], 0.5), 0.0);
        assert_eq!(quantile(&[3.0, 1.0, 2.0], 0.5), 2.0);
        assert!((quantile(&[1.0, 2.0, 3.0, 4.0], 0.95) - 3.85).abs() < 1e-12);
    }
}
