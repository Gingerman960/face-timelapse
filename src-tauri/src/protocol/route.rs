//! `ftimg` request parsing and validation (ARCHITECTURE.md §6, §13).
//!
//! Only ids (never paths) are accepted: `photoId` must be `^[0-9a-f]{16}$`,
//! widths are rounded up to the route's buckets, only `GET` is allowed. No
//! segment of the request ever reaches the filesystem.

use crate::ids;
use crate::ipc::{
    ALIGNED_WIDTHS, ImageRoute, PREVIEW_WIDTHS, REFERENCE_FRAME_WIDTHS, REFERENCE_WIDTHS,
    THUMB_WIDTHS,
};

/// Why a request was refused (maps to an HTTP status).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteError {
    /// 400: malformed `w`.
    BadRequest,
    /// 404: unknown route or malformed id.
    NotFound,
    /// 405: not `GET`.
    MethodNotAllowed,
}

impl RouteError {
    #[must_use]
    pub fn status(self) -> u16 {
        match self {
            Self::BadRequest => 400,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
        }
    }
}

/// Smallest bucket ≥ `w`, or the largest bucket.
#[must_use]
pub fn bucket(w: u32, buckets: &[u32]) -> u32 {
    buckets
        .iter()
        .copied()
        .find(|&b| b >= w)
        .unwrap_or_else(|| buckets.last().copied().unwrap_or(w))
}

struct Query {
    w: Option<String>,
    v: Option<String>,
}

fn parse_query(query: Option<&str>) -> Query {
    let mut q = Query { w: None, v: None };
    for pair in query
        .unwrap_or_default()
        .split('&')
        .filter(|p| !p.is_empty())
    {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "w" => q.w = Some(v.to_owned()),
            "v" => q.v = Some(v.to_owned()),
            _ => {}
        }
    }
    q
}

fn width(raw: Option<&str>, buckets: &[u32]) -> Result<Option<u32>, RouteError> {
    match raw {
        None => Ok(None),
        Some(s) if !s.is_empty() && s.len() <= 6 && s.bytes().all(|b| b.is_ascii_digit()) => {
            let w: u32 = s.parse().map_err(|_| RouteError::BadRequest)?;
            Ok(Some(bucket(w, buckets)))
        }
        Some(_) => Err(RouteError::BadRequest),
    }
}

fn required_width(raw: Option<&str>, buckets: &[u32]) -> Result<u32, RouteError> {
    width(raw, buckets)?.ok_or(RouteError::BadRequest)
}

/// Parses `method` + URI path/query into an [`ImageRoute`].
///
/// # Errors
/// [`RouteError`] for anything outside the grammar.
pub fn parse(method: &str, path: &str, query: Option<&str>) -> Result<ImageRoute, RouteError> {
    if method != "GET" {
        return Err(RouteError::MethodNotAllowed);
    }
    let q = parse_query(query);
    let version = q.v.filter(|v| ids::is_hex(v));
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match segments.as_slice() {
        ["thumb", id] if ids::is_photo_id(id) => Ok(ImageRoute::Thumb {
            photo_id: (*id).to_owned(),
            width: required_width(q.w.as_deref(), &THUMB_WIDTHS)?,
            version,
        }),
        ["aligned", id] if ids::is_photo_id(id) => Ok(ImageRoute::Aligned {
            photo_id: (*id).to_owned(),
            width: width(q.w.as_deref(), &ALIGNED_WIDTHS)?,
            version,
        }),
        ["preview", id] if ids::is_photo_id(id) => Ok(ImageRoute::Preview {
            photo_id: (*id).to_owned(),
            width: required_width(q.w.as_deref(), &PREVIEW_WIDTHS)?,
            version,
        }),
        ["reference"] => Ok(ImageRoute::Reference {
            width: required_width(q.w.as_deref(), &REFERENCE_WIDTHS)?,
            version,
        }),
        ["reference", "frame"] => Ok(ImageRoute::ReferenceFrame {
            width: required_width(q.w.as_deref(), &REFERENCE_FRAME_WIDTHS)?,
            version,
        }),
        _ => Err(RouteError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef";

    #[test]
    fn buckets_round_up_and_cap() {
        assert_eq!(bucket(0, &THUMB_WIDTHS), 160);
        assert_eq!(bucket(161, &THUMB_WIDTHS), 320);
        assert_eq!(bucket(320, &THUMB_WIDTHS), 320);
        assert_eq!(bucket(9999, &THUMB_WIDTHS), 2048);
        assert_eq!(bucket(1281, &ALIGNED_WIDTHS), 1280);
    }

    #[test]
    fn parses_every_route() {
        assert_eq!(
            parse("GET", &format!("/thumb/{ID}"), Some("w=300&v=deadbeef")),
            Ok(ImageRoute::Thumb {
                photo_id: ID.into(),
                width: 320,
                version: Some("deadbeef".into())
            })
        );
        assert_eq!(
            parse("GET", &format!("/aligned/{ID}"), Some("v=ab")),
            Ok(ImageRoute::Aligned {
                photo_id: ID.into(),
                width: None,
                version: Some("ab".into())
            })
        );
        assert_eq!(
            parse("GET", &format!("/aligned/{ID}"), Some("w=700&x=1")),
            Ok(ImageRoute::Aligned {
                photo_id: ID.into(),
                width: Some(1280),
                version: None
            })
        );
        assert_eq!(
            parse("GET", "/reference", Some("v=aa&w=10")),
            Ok(ImageRoute::Reference {
                width: 320,
                version: Some("aa".into())
            })
        );
        assert_eq!(
            parse("GET", &format!("/preview/{ID}"), Some("w=700&v=abc")),
            Ok(ImageRoute::Preview {
                photo_id: ID.into(),
                width: 1280,
                version: Some("abc".into())
            })
        );
        assert_eq!(
            parse("GET", &format!("/preview/{ID}"), Some("w=1")),
            Ok(ImageRoute::Preview {
                photo_id: ID.into(),
                width: 640,
                version: None
            })
        );
        assert_eq!(
            parse("GET", &format!("/preview/{ID}"), None),
            Err(RouteError::BadRequest),
            "w required"
        );
        assert_eq!(
            parse("GET", "/preview/../etc/passwd", Some("w=640")),
            Err(RouteError::NotFound)
        );
        assert_eq!(
            parse("GET", "/reference/frame", Some("w=1280")),
            Ok(ImageRoute::ReferenceFrame {
                width: 1280,
                version: None
            })
        );
    }

    #[test]
    fn rejects_bad_ids_widths_methods_and_traversal() {
        for path in [
            "/thumb/../../etc/passwd",
            "/thumb/..%2F..%2Fetc%2Fpasswd",
            "/thumb/0123456789ABCDEF",
            "/thumb/0123456789abcde",
            "/thumb/0123456789abcdef/extra",
            "/aligned//etc/passwd",
            "/aligned/%2e%2e",
            "/etc/passwd",
            "/",
            "",
            "/reference/frame/x",
            "/Users/someone/photo.jpg",
        ] {
            assert_eq!(
                parse("GET", path, Some("w=320")),
                Err(RouteError::NotFound),
                "{path}"
            );
        }
        for w in ["w=abc", "w=-1", "w=", "w=1e3", "w=99999999999", "w=320.5"] {
            assert_eq!(
                parse("GET", &format!("/thumb/{ID}"), Some(w)),
                Err(RouteError::BadRequest),
                "{w}"
            );
        }
        assert_eq!(
            parse("GET", &format!("/thumb/{ID}"), None),
            Err(RouteError::BadRequest)
        );
        assert_eq!(
            parse("GET", "/reference", None),
            Err(RouteError::BadRequest)
        );
        for m in ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"] {
            assert_eq!(
                parse(m, &format!("/thumb/{ID}"), Some("w=320")),
                Err(RouteError::MethodNotAllowed)
            );
        }
        // Non-hex versions are ignored (served uncached), not errors.
        assert_eq!(
            parse("GET", &format!("/thumb/{ID}"), Some("w=320&v=../x")),
            Ok(ImageRoute::Thumb {
                photo_id: ID.into(),
                width: 320,
                version: None
            })
        );
        assert_eq!(
            [
                RouteError::BadRequest,
                RouteError::NotFound,
                RouteError::MethodNotAllowed
            ]
            .map(RouteError::status),
            [400, 404, 405]
        );
    }
}
