//! macOS settings the app and the command line both read.

/// Whether macOS lets an app post notifications, from the output of
/// `defaults read com.apple.ncprefs apps`: the app's entry has `flags`, and
/// bit 25 is "Allow Notifications". None when the app has no entry yet (it
/// never posted), or the text can't be read.
pub fn notifications_allowed(ncprefs_apps: &str, bundle_id: &str) -> Option<bool> {
    let needle = format!("\"bundle-id\" = \"{bundle_id}\";");
    let at = ncprefs_apps.find(&needle)?;
    // Keys are sorted, so `flags` follows `bundle-id` within the same entry.
    let rest = &ncprefs_apps[at + needle.len()..];
    let end = rest.find("\"bundle-id\"").unwrap_or(rest.len());
    let flags =
        rest[..end].lines().find_map(|l| l.trim().strip_prefix("flags = ")?.strip_suffix(';')?.parse::<u64>().ok())?;
    Some(flags & (1 << 25) != 0)
}

/// [`notifications_allowed`] for this Mac, read with `defaults`.
pub fn notifications_allowed_here(bundle_id: &str) -> Option<bool> {
    let out = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "com.apple.ncprefs", "apps"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    notifications_allowed(&String::from_utf8_lossy(&out.stdout), bundle_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"(
        {
        auth = 7;
        "bundle-id" = "com.example.other";
        flags = 41943575;
    },
        {
        auth = 7;
        "bundle-id" = "io.github.dan-build.agentstat";
        "content_visibility" = 0;
        flags = 8396814;
        grouping = 0;
        src =         (
                        {
            }
        );
    }
)"#;

    #[test]
    fn reads_the_allow_bit_of_the_right_app() {
        assert_eq!(notifications_allowed(SAMPLE, "io.github.dan-build.agentstat"), Some(false));
        assert_eq!(notifications_allowed(SAMPLE, "com.example.other"), Some(true));
        let on = SAMPLE.replace("8396814", "41951246");
        assert_eq!(notifications_allowed(&on, "io.github.dan-build.agentstat"), Some(true));
        assert_eq!(notifications_allowed(SAMPLE, "com.example.missing"), None);
    }
}
