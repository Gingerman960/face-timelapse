//! macOS window details Tauri does not expose, without `unsafe`.
//!
//! The open animation: AppKit grows a document window from about 90 % of
//! its size when it is first shown. If that happens while the session is
//! locked or the display asleep, the animation never completes and the
//! window stays drawn at 1296 × 811 inside its 1440 × 900 frame (QA #14).
//! The main window therefore opens without it.

use objc2_app_kit::NSWindowAnimationBehavior;

/// A window whose AppKit animation behaviour can be set (`NSWindow` in
/// `lib.rs`; a recorder in tests).
pub(crate) trait Animated {
    fn set_animation_behavior(&self, behavior: NSWindowAnimationBehavior);
}

/// Switches off the open animation of `windows`; returns how many.
pub(crate) fn without_open_animation<'a, W: Animated + 'a>(
    windows: impl IntoIterator<Item = &'a W>,
) -> usize {
    windows
        .into_iter()
        .map(|w| w.set_animation_behavior(NSWindowAnimationBehavior::None))
        .count()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[derive(Default)]
    struct Recorder(Cell<Option<NSWindowAnimationBehavior>>);

    impl Animated for Recorder {
        fn set_animation_behavior(&self, behavior: NSWindowAnimationBehavior) {
            self.0.set(Some(behavior));
        }
    }

    #[test]
    fn every_window_opens_without_the_zoom_animation() {
        let windows = [Recorder::default(), Recorder::default()];
        assert_eq!(without_open_animation(&windows), 2);
        for w in &windows {
            assert_eq!(w.0.get(), Some(NSWindowAnimationBehavior::None));
        }
    }
}
