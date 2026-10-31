//! Webview navigation policy (ARCHITECTURE.md §13): the window only ever
//! shows the bundled UI. Any other navigation (an injected
//! `location = 'https://…?' + data`, a dropped link, a `data:` URL) and every
//! new-window request are refused, so nothing can be exfiltrated by
//! navigating and no foreign page ever gets the app's IPC or `ftimg` access.

use tauri::Url;

/// Dev server origin used by `tauri dev` (debug builds only).
const DEV_ORIGIN: (&str, &str, u16) = ("http", "localhost", 1420);

/// True for URLs of the app's own UI: `tauri://localhost` (macOS, Linux),
/// `http(s)://tauri.localhost` (Windows), `about:blank`, and in debug builds
/// the dev server.
#[must_use]
pub fn is_app_url(url: &Url) -> bool {
    let host = url.host_str();
    match url.scheme() {
        "tauri" => host == Some("localhost"),
        "http" | "https" if host == Some("tauri.localhost") => url.port().is_none(),
        "about" => url.path() == "blank",
        scheme => {
            cfg!(debug_assertions)
                && scheme == DEV_ORIGIN.0
                && host == Some(DEV_ORIGIN.1)
                && url.port() == Some(DEV_ORIGIN.2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("url")
    }

    #[test]
    fn only_the_bundled_ui_may_be_shown() {
        for ok in [
            "tauri://localhost",
            "tauri://localhost/index.html#/review",
            "http://tauri.localhost/",
            "https://tauri.localhost/assets/app.js",
            "about:blank",
        ] {
            assert!(is_app_url(&url(ok)), "{ok}");
        }
        for bad in [
            "https://evil.example/?d=secret",
            "http://tauri.localhost.evil.example/",
            "http://tauri.localhost:8080/",
            "tauri://evil",
            "ftimg://localhost/thumb/0123456789abcdef?w=320",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/hosts",
            "javascript:alert(1)",
            "about:srcdoc",
            "http://localhost:1421/",
        ] {
            assert!(!is_app_url(&url(bad)), "{bad}");
        }
        assert_eq!(
            is_app_url(&url("http://localhost:1420/")),
            cfg!(debug_assertions),
            "dev server only in debug builds"
        );
    }
}
