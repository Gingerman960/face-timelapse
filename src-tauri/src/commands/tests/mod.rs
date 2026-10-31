//! Command-layer flow tests on the fake engine: reference → folder → scan →
//! review → days → align → frames → export images/video, plus validation,
//! busy rule, persistence and reset.
//!
//! Split by area: `reference_days` (reference, matching, adding photos,
//! validation), `flows` (review → days → align → export, reset), `exports`
//! (where exports may write, crash/quit safety).

use std::sync::Arc;

use super::{app, days, export, folder, frames, reference, review};
use crate::ipc::{
    AlignEvent, AspectPreset, BackdropMode, CacheScope, ErrorKind, ExportImagesEvent,
    ExportVideoEvent, FrameAdjust, FramesStatus, ImageExportSettings, ImageFormat, LookSettings,
    MatchStatus, NormalizeMode, PhotoQuery, Rect, RenderSettings, Resolution, ReviewDecision,
};
use crate::session::model::default_video;
use crate::testutil::TestCore;

fn scanned() -> TestCore {
    let t = TestCore::new();
    t.setup();
    t.scan();
    t
}

fn id_of(t: &TestCore, name: &str) -> String {
    review::photos(&t.core, &PhotoQuery { statuses: None })
        .expect("photos")
        .into_iter()
        .find(|p| p.file_name.contains(name))
        .map(|p| p.id)
        .expect("photo")
}

fn small_render(t: &TestCore) {
    t.core.session.write().p.render = RenderSettings {
        resolution: Resolution::P720,
        backdrop: BackdropMode::Black,
        refine_landmarks: false,
    };
}

mod exports;
mod flows;
mod models_missing;
mod reference_days;
