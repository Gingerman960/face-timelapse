//! Contract drift guard (ARCHITECTURE.md §7.6).
//!
//! 1. `src/ipc.rs` must be the verbatim §7.4 block of ARCHITECTURE.md, and
//!    `ui/src/ipc/contract.ts` the verbatim §7.3 block.
//! 2. `ui/src/ipc/contract.samples.json` holds one realistic sample per
//!    contract type (every event variant and enum value included). Each sample
//!    must deserialize into its Rust type and re-serialize to identical JSON.
//! 3. The samples built here from Rust values must equal the JSON file, so a
//!    Rust-side change without a sample update fails.
//!
//! 4. The app event names in `src/ipc.rs` equal those in `ui/src/ipc/events.ts`.
//!
//! The TypeScript twin (`ui/src/ipc/contract.samples.test.ts`, run by the
//! UI's Vitest) checks the same JSON against `contract.ts` with `satisfies`.
//! Regenerate both sample files after an accepted contract change with
//! `FT_WRITE_CONTRACT_SAMPLES=1 cargo test -p facetimelapse --test contract`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use facetimelapse_lib::ipc::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[path = "contract/enums.rs"]
mod enums;
#[path = "contract/samples.rs"]
mod samples;
use samples::{error, samples, v};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Where the shared fixtures live: `ui/src/ipc/` once the UI owns them
/// (§7.6), else `src-tauri/tests/contract/` (single source either way).
fn fixture(name: &str) -> PathBuf {
    let ui = root().join("../ui/src/ipc").join(name);
    if ui.is_file() {
        ui
    } else {
        root().join("tests/contract").join(name)
    }
}

fn samples_file() -> PathBuf {
    fixture("contract.samples.json")
}

/// Typed round trip: JSON → Rust → JSON must be identical.
fn check<T: Serialize + DeserializeOwned>(name: &str, sample: &Value) -> Result<(), String> {
    let typed: T = serde_json::from_value(sample.clone())
        .map_err(|e| format!("{name}: does not deserialize: {e}"))?;
    let back =
        serde_json::to_value(&typed).map_err(|e| format!("{name}: does not serialize: {e}"))?;
    if &back == sample {
        Ok(())
    } else {
        Err(format!(
            "{name}: round trip differs\n  sample: {sample}\n  rust:   {back}"
        ))
    }
}

/// Sample key → typed round-trip check.
fn check_sample(key: &str, sample: &Value) -> Result<(), String> {
    let ty = key.split('_').next().unwrap_or(key);
    match ty {
        "Point" => check::<Point>(key, sample),
        "Size" => check::<Size>(key, sample),
        "Rect" => check::<Rect>(key, sample),
        "IpcError" => check::<IpcError>(key, sample),
        "AppInfo" => check::<AppInfo>(key, sample),
        "FaceGeometry" => check::<FaceGeometry>(key, sample),
        "ReferenceImage" => check::<ReferenceImage>(key, sample),
        "ReferenceDetection" => check::<ReferenceDetection>(key, sample),
        "ReferenceState" => check::<ReferenceState>(key, sample),
        "FolderInfo" => check::<FolderInfo>(key, sample),
        "ClearCacheResult" => check::<ClearCacheResult>(key, sample),
        "PhotoSummary" => check::<PhotoSummary>(key, sample),
        "PhotoDetail" => check::<PhotoDetail>(key, sample),
        "PhotoQuery" => check::<PhotoQuery>(key, sample),
        "LibraryCounts" => check::<LibraryCounts>(key, sample),
        "ActiveJob" => check::<ActiveJob>(key, sample),
        "JobStarted" => check::<JobStarted>(key, sample),
        "JobFailed" => check::<JobFailed>(key, sample),
        "JobCancelled" => check::<JobCancelled>(key, sample),
        "ScanRecent" => check::<ScanRecent>(key, sample),
        "ScanProgress" => check::<ScanProgress>(key, sample),
        "ScanSummary" => check::<ScanSummary>(key, sample),
        "ScanEvent" => check::<ScanEvent>(key, sample),
        "DayGroup" => check::<DayGroup>(key, sample),
        "DaysPatch" => check::<DaysPatch>(key, sample),
        "RenderSettings" => check::<RenderSettings>(key, sample),
        "AlignRecent" => check::<AlignRecent>(key, sample),
        "AlignProgress" => check::<AlignProgress>(key, sample),
        "AlignFailure" => check::<AlignFailure>(key, sample),
        "AlignSummary" => check::<AlignSummary>(key, sample),
        "AlignEvent" => check::<AlignEvent>(key, sample),
        "FrameAdjust" => check::<FrameAdjust>(key, sample),
        "LookDelta" => check::<LookDelta>(key, sample),
        "FrameSummary" => check::<FrameSummary>(key, sample),
        "LookSettings" => check::<LookSettings>(key, sample),
        "FramesView" => check::<FramesView>(key, sample),
        "ImageExportSettings" => check::<ImageExportSettings>(key, sample),
        "ExportProgress" => check::<ExportProgress>(key, sample),
        "ExportImagesSummary" => check::<ExportImagesSummary>(key, sample),
        "ExportImagesEvent" => check::<ExportImagesEvent>(key, sample),
        "Crossfade" => check::<Crossfade>(key, sample),
        "CaptionOptions" => check::<CaptionOptions>(key, sample),
        "VideoSettings" => check::<VideoSettings>(key, sample),
        "VideoProgress" => check::<VideoProgress>(key, sample),
        "VideoSummary" => check::<VideoSummary>(key, sample),
        "ExportVideoEvent" => check::<ExportVideoEvent>(key, sample),
        "ScanInfo" => check::<ScanInfo>(key, sample),
        "FramesInfo" => check::<FramesInfo>(key, sample),
        "Recents" => check::<Recents>(key, sample),
        "SessionSnapshot" => check::<SessionSnapshot>(key, sample),
        "ErrorKind" => check::<Vec<ErrorKind>>(key, sample),
        "Platform" => check::<Vec<Platform>>(key, sample),
        "AspectPreset" => check::<Vec<AspectPreset>>(key, sample),
        "CacheScope" => check::<Vec<CacheScope>>(key, sample),
        "MatchStatus" => check::<Vec<MatchStatus>>(key, sample),
        "ReviewDecision" => check::<Vec<ReviewDecision>>(key, sample),
        "DateSource" => check::<Vec<DateSource>>(key, sample),
        "JobKind" => check::<Vec<JobKind>>(key, sample),
        "ScanRecentStatus" => check::<Vec<ScanRecentStatus>>(key, sample),
        "Resolution" => check::<Vec<Resolution>>(key, sample),
        "BackdropMode" => check::<Vec<BackdropMode>>(key, sample),
        "FramesStatus" => check::<Vec<FramesStatus>>(key, sample),
        "NormalizeMode" => check::<Vec<NormalizeMode>>(key, sample),
        "ImageFormat" => check::<Vec<ImageFormat>>(key, sample),
        "Pace" => check::<Vec<Pace>>(key, sample),
        "VideoQuality" => check::<Vec<VideoQuality>>(key, sample),
        "Easing" => check::<Vec<Easing>>(key, sample),
        "CaptionPosition" => check::<Vec<CaptionPosition>>(key, sample),
        "ScanStatus" => check::<Vec<ScanStatus>>(key, sample),
        other => Err(format!("{key}: no Rust type registered for {other}")),
    }
}

/// TypeScript type of a sample key (`ScanEvent_started` → `C.ScanEvent`, `X_all` → `C.X[]`).
fn ts_type(key: &str) -> String {
    let ty = key.split('_').next().unwrap_or(key);
    let base = match ty {
        "ScanRecentStatus" => "C.ScanRecent['status']".to_owned(),
        other => format!("C.{other}"),
    };
    if key.ends_with("_all") {
        format!("{base}[]")
    } else {
        base
    }
}

/// `contract.samples.ts`: every sample as a literal checked with `satisfies`.
fn ts_samples(built: &BTreeMap<&'static str, Value>) -> String {
    let mut out = String::from(
        "// GENERATED by `FT_WRITE_CONTRACT_SAMPLES=1 cargo test -p facetimelapse --test contract`.\n\
         // Do not edit: change ARCHITECTURE.md §7.3/§7.4, both contract files, then regenerate.\n\
         // `satisfies` makes tsc reject missing, extra or mistyped fields (§7.6).\n\
         import type * as C from './contract'\n\nexport const samples = {\n",
    );
    for (key, value) in built {
        let literal = serde_json::to_string(value).expect("json");
        out.push_str(&format!("  {key}: {literal} satisfies {},\n", ts_type(key)));
    }
    out.push_str("}\n");
    out
}

#[test]
fn typescript_fixture_is_current() {
    let built = samples();
    let path = fixture("contract.samples.ts");
    let expected = ts_samples(&built);
    if std::env::var_os("FT_WRITE_CONTRACT_SAMPLES").is_some() {
        std::fs::write(&path, &expected).expect("write ts samples");
    }
    let actual = std::fs::read_to_string(&path).expect("contract.samples.ts");
    assert!(
        actual == expected,
        "{} is stale; regenerate with FT_WRITE_CONTRACT_SAMPLES=1",
        path.display()
    );
}

/// The fenced `lang` block under the `### {section}` heading of ARCHITECTURE.md.
fn architecture_block(section: &str, lang: &str) -> String {
    let doc = std::fs::read_to_string(root().join("../docs/rewrite/ARCHITECTURE.md"))
        .expect("ARCHITECTURE.md");
    let start = doc
        .find(&format!("### {section}"))
        .expect("section heading");
    let fence = format!("```{lang}\n");
    let block_start = doc[start..].find(&fence).expect("code block") + start + fence.len();
    let block_end = doc[block_start..].find("\n```").expect("block end") + block_start;
    doc[block_start..=block_end].to_owned()
}

#[test]
fn ipc_rs_is_verbatim_architecture_7_4() {
    let actual = std::fs::read_to_string(root().join("src/ipc.rs")).expect("ipc.rs");
    assert!(
        actual == architecture_block("7.4", "rust"),
        "src/ipc.rs drifted from ARCHITECTURE.md §7.4 — copy the block verbatim (doc first, then both contract files)"
    );
}

#[test]
fn contract_ts_is_verbatim_architecture_7_3() {
    let path = root().join("../ui/src/ipc/contract.ts");
    let Ok(actual) = std::fs::read_to_string(&path) else {
        eprintln!("skipped: {} not present", path.display());
        return;
    };
    assert!(
        actual == architecture_block("7.3", "ts"),
        "ui/src/ipc/contract.ts drifted from ARCHITECTURE.md §7.3 — copy the block verbatim (doc first, then both contract files)"
    );
}

#[test]
fn samples_round_trip_through_rust_types() {
    let built = samples();
    let path = samples_file();
    if std::env::var_os("FT_WRITE_CONTRACT_SAMPLES").is_some() {
        let text = serde_json::to_string_pretty(&built).expect("json") + "\n";
        std::fs::write(&path, text).expect("write samples");
    }
    let file: BTreeMap<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("samples file"))
            .expect("samples json");
    let mut errors = Vec::new();
    for (key, sample) in &file {
        if let Err(e) = check_sample(key, sample) {
            errors.push(e);
        }
    }
    for (key, sample) in &built {
        match file.get(*key) {
            Some(s) if s == sample => {}
            Some(s) => errors.push(format!("{key}: JSON sample differs from the Rust-built sample\n  json: {s}\n  rust: {sample}")),
            None => errors.push(format!("{key}: missing from {}", path.display())),
        }
    }
    for key in file.keys() {
        if !built.contains_key(key.as_str()) {
            errors.push(format!("{key}: in the JSON but not built in Rust"));
        }
    }
    assert!(errors.is_empty(), "contract drift:\n{}", errors.join("\n"));
}

#[test]
fn app_event_names_match_ui_events_ts() {
    assert_eq!(SESSION_CHANGED_EVENT, "session-changed");
    assert_eq!(MODELS_CHANGED_EVENT, "models-changed");
    assert_eq!(SHOW_KEYS_EVENT, "show-keys");
    let path = root().join("../ui/src/ipc/events.ts");
    let Ok(events_ts) = std::fs::read_to_string(&path) else {
        eprintln!("skipped: {} not present", path.display());
        return;
    };
    for (name, value) in [
        ("SESSION_CHANGED_EVENT", SESSION_CHANGED_EVENT),
        ("MODELS_CHANGED_EVENT", MODELS_CHANGED_EVENT),
        ("SHOW_KEYS_EVENT", SHOW_KEYS_EVENT),
    ] {
        let line = format!("export const {name} = '{value}'\n");
        assert!(
            events_ts.contains(&line),
            "ui/src/ipc/events.ts lacks `{}`",
            line.trim()
        );
    }
}

#[test]
fn image_protocol_constants() {
    assert_eq!(IMAGE_SCHEME, "ftimg");
    assert_eq!(THUMB_WIDTHS, [160, 320, 640, 1280, 2048]);
    assert_eq!(ALIGNED_WIDTHS, [160, 320, 640, 1280]);
    assert_eq!(REFERENCE_WIDTHS, [320, 640, 1280, 2048]);
    assert_eq!(REFERENCE_FRAME_WIDTHS, [160, 320, 640, 1280]);
    assert_eq!(PREVIEW_WIDTHS, [640, 1280]);
    assert_eq!((SCORE_CONFIRMED, SCORE_UNCERTAIN), (0.6, 0.4));
    // Errors reject as exactly {kind, message}.
    assert_eq!(v(error()).as_object().map(|o| o.len()), Some(2));
    assert_eq!(
        json!({"kind": "busy", "message": "x"}),
        v(IpcError::new(ErrorKind::Busy, "x"))
    );
}
