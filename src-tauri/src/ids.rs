//! Validation of the ids and versions that reach the shell from outside
//! (protocol URLs, command arguments). The ids themselves are computed by the
//! engine (`face_engine::walk::{photo_id, photo_version, folder_key}`).

/// `^[0-9a-f]{16}$`.
#[must_use]
pub fn is_photo_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Lowercase hex of any length ≥ 1 (versions in protocol URLs).
#[must_use]
pub fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_ids_pass_validation() {
        let a = face_engine::walk::photo_id(std::path::Path::new("/photos/IMG_1.jpg"));
        assert!(is_photo_id(&a), "{a}");
        assert!(is_hex(&face_engine::walk::photo_version(10, 5)));
    }

    #[test]
    fn id_validation_rejects_traversal_and_case() {
        for bad in [
            "",
            "0123456789ABCDEF",
            "../../etc/passwd",
            "0123456789abcde",
            "0123456789abcdeg",
            "0123456789abcdef0",
        ] {
            assert!(!is_photo_id(bad), "{bad}");
        }
        assert!(is_hex("deadbeef"));
        assert!(!is_hex("DEAD"));
        assert!(!is_hex(""));
    }
}
