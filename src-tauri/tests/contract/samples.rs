//! Realistic Rust-built samples for every contract type (see `../contract.rs`).

use std::collections::BTreeMap;

use facetimelapse_lib::ipc::*;
use serde::Serialize;
use serde_json::Value;

const ID: &str = "0123456789abcdef";
const ID2: &str = "fedcba9876543210";

fn anchors() -> Vec<Point> {
    vec![
        Point { x: 0.38, y: 0.42 },
        Point { x: 0.62, y: 0.42 },
        Point { x: 0.5, y: 0.55 },
        Point { x: 0.41, y: 0.68 },
        Point { x: 0.59, y: 0.68 },
    ]
}

fn face_box() -> Rect {
    Rect {
        x: 0.3,
        y: 0.25,
        width: 0.4,
        height: 0.5,
    }
}

fn reference_state() -> ReferenceState {
    ReferenceState {
        image: ReferenceImage {
            path: "/Users/me/Pictures/reference/IMG_20140815_142326.jpg".into(),
            file_name: "IMG_20140815_142326.jpg".into(),
            rotation_deg: -1.5,
            auto_rotation_deg: Some(-1.25),
            size: Size {
                width: 3264,
                height: 2448,
            },
            face: Some(FaceGeometry {
                bounds: face_box(),
                anchors: anchors(),
                confidence: 0.98,
            }),
            version: "3f9a1c0b77d2".into(),
        },
        crop: Rect {
            x: 408.0,
            y: 0.0,
            width: 2448.0,
            height: 2448.0,
        },
        aspect: AspectPreset::Square,
        detection: Some(ReferenceDetection {
            anchors: anchors(),
            face_box: face_box(),
            confidence: 0.97,
        }),
        version: "a81c55e0d913".into(),
    }
}

fn folder() -> FolderInfo {
    FolderInfo {
        path: "/Users/me/Pictures/selfies".into(),
        name: "selfies".into(),
        image_count: 3593,
        analyzed_count: 3590,
        unsupported_count: 3,
    }
}

fn photo_summary() -> PhotoSummary {
    PhotoSummary {
        id: ID.into(),
        file_name: "IMG_20140815_142326.jpg".into(),
        rel_path: "2014/IMG_20140815_142326.jpg".into(),
        taken_at: "2014-08-15T14:23:26".into(),
        date_source: DateSource::Exif,
        time_known: true,
        day_key: "2014-08-15".into(),
        score: 0.87,
        status: MatchStatus::Confirmed,
        review: ReviewDecision::Pending,
        included: true,
        size: Size {
            width: 3264,
            height: 2448,
        },
        version: "9c2e41aa".into(),
        face_box: Some(face_box()),
    }
}

fn counts() -> LibraryCounts {
    LibraryCounts {
        total: 3590,
        confirmed: 3402,
        uncertain: 61,
        rejected: 87,
        no_face: 35,
        failed: 5,
        review_pending: 12,
        included: 3451,
        days: 3012,
        active_days: 3004,
    }
}

fn scan_summary() -> ScanSummary {
    ScanSummary {
        job_id: "job-1".into(),
        total: 3593,
        from_cache: 3400,
        analyzed: 193,
        confirmed: 3402,
        uncertain: 61,
        rejected: 87,
        no_face: 35,
        failed: 5,
        duration_ms: 2310,
    }
}

fn render() -> RenderSettings {
    RenderSettings {
        resolution: Resolution::P1080,
        backdrop: BackdropMode::Extended,
        refine_landmarks: true,
    }
}

fn look() -> LookSettings {
    LookSettings {
        normalize: NormalizeMode::ExposureAndColor,
        strength: 0.7,
    }
}

fn adjust() -> FrameAdjust {
    FrameAdjust {
        dx: 0.01,
        dy: -0.02,
        scale: 1.05,
        rotation_deg: 0.5,
    }
}

fn frame() -> FrameSummary {
    FrameSummary {
        photo_id: ID.into(),
        day_key: "2014-08-15".into(),
        taken_at: "2014-08-15T14:23:26".into(),
        time_known: true,
        version: "5d0c9e8b1a2f".into(),
        residual_px: 1.75,
        adjust: adjust(),
        look_delta: Some(LookDelta {
            exposure_ev: 0.25,
            color_shift: 1.5,
        }),
    }
}

fn video() -> VideoSettings {
    VideoSettings {
        pace: Pace::Fps { fps: 10.0 },
        resolution: Resolution::Source,
        quality: VideoQuality::High,
        crossfade: Crossfade {
            frames: 2,
            easing: Easing::EaseInOut,
        },
        caption: Some(CaptionOptions {
            position: CaptionPosition::BottomLeft,
            size: 0.045,
            format: "%b %-d, %Y".into(),
        }),
        hold_first_secs: 0.0,
        hold_last_secs: 1.0,
    }
}

pub fn error() -> IpcError {
    IpcError::new(
        ErrorKind::NoFaceInReference,
        "No face found inside the crop. Widen the crop or pick another reference photo.",
    )
}

pub fn v<T: Serialize>(x: T) -> Value {
    serde_json::to_value(x).expect("serialize sample")
}

/// Every sample, built from Rust values.
pub fn samples() -> BTreeMap<&'static str, Value> {
    let mut m = BTreeMap::new();
    let mut put = |k: &'static str, val: Value| {
        assert!(m.insert(k, val).is_none(), "duplicate sample {k}");
    };
    put("Point", v(Point { x: 0.5, y: 0.25 }));
    put(
        "Size",
        v(Size {
            width: 1920,
            height: 1080,
        }),
    );
    put("Rect", v(face_box()));
    put("IpcError", v(error()));
    let app_info = AppInfo {
        version: "2.0.0".into(),
        platform: Platform::Macos,
        image_base_url: "ftimg://localhost/".into(),
        models_ready: true,
        models_error: None,
        parallelism: 15,
        data_dir: "/Users/me/Library/Application Support/io.github.gingerman960.facetimelapse"
            .into(),
        cache_dir: "/Users/me/Library/Caches/io.github.gingerman960.facetimelapse/v1".into(),
    };
    put("AppInfo", v(&app_info));
    put(
        "AppInfo_modelsFailed",
        v(AppInfo {
            models_ready: false,
            models_error: Some(
                "The face models couldn't be loaded. Reinstall FaceTimelapse.".into(),
            ),
            ..app_info
        }),
    );
    put(
        "FaceGeometry",
        v(FaceGeometry {
            bounds: face_box(),
            anchors: anchors(),
            confidence: 0.98,
        }),
    );
    put("ReferenceImage", v(reference_state().image));
    put("ReferenceDetection", v(reference_state().detection));
    put("ReferenceState", v(reference_state()));
    put(
        "ReferenceState_noFace",
        v(ReferenceState {
            detection: None,
            image: ReferenceImage {
                face: None,
                auto_rotation_deg: None,
                ..reference_state().image
            },
            ..reference_state()
        }),
    );
    put("FolderInfo", v(folder()));
    put(
        "ClearCacheResult",
        v(ClearCacheResult {
            removed_entries: 3590,
            freed_bytes: 3_145_728,
        }),
    );
    put("PhotoSummary", v(photo_summary()));
    let no_face = PhotoSummary {
        score: 0.0,
        status: MatchStatus::NoFace,
        included: false,
        face_box: None,
        date_source: DateSource::Filename,
        file_name: "IMG_20220827.jpg".into(),
        rel_path: "2022/IMG_20220827.jpg".into(),
        taken_at: "2022-08-27T00:00:00".into(),
        day_key: "2022-08-27".into(),
        time_known: false,
        ..photo_summary()
    };
    put("PhotoSummary_noFace", v(&no_face));
    put(
        "PhotoDetail",
        v(PhotoDetail {
            summary: photo_summary(),
            path: "/Users/me/Pictures/selfies/2014/IMG_20140815_142326.jpg".into(),
            faces: vec![FaceGeometry {
                bounds: face_box(),
                anchors: anchors(),
                confidence: 0.98,
            }],
            matched_face: Some(0),
            raw_similarity: Some(0.71),
            preview_version: Some("3fa85f64c2b1".into()),
        }),
    );
    put(
        "PhotoDetail_noFace",
        v(PhotoDetail {
            path: "/Users/me/Pictures/selfies/2022/IMG_20220827.jpg".into(),
            summary: no_face,
            faces: Vec::new(),
            matched_face: None,
            raw_similarity: None,
            preview_version: None,
        }),
    );
    put(
        "PhotoQuery",
        v(PhotoQuery {
            statuses: Some(vec![MatchStatus::Uncertain, MatchStatus::Rejected]),
        }),
    );
    put("PhotoQuery_unfiltered", v(PhotoQuery { statuses: None }));
    put("LibraryCounts", v(counts()));
    put(
        "ActiveJob",
        v(ActiveJob {
            job_id: "job-2".into(),
            kind: JobKind::Align,
        }),
    );
    put(
        "JobStarted",
        v(JobStarted {
            job_id: "job-1".into(),
            total: 3593,
        }),
    );
    put(
        "JobFailed",
        v(JobFailed {
            job_id: "job-1".into(),
            error: error(),
        }),
    );
    put(
        "JobCancelled",
        v(JobCancelled {
            job_id: "job-1".into(),
            done: 1204,
        }),
    );
    let scan_recent = vec![
        ScanRecent {
            id: ID.into(),
            version: "9c2e41aa".into(),
            day_key: "2014-08-15".into(),
            status: ScanRecentStatus::Confirmed,
        },
        ScanRecent {
            id: ID2.into(),
            version: "1b7d02ff".into(),
            day_key: "2014-08-16".into(),
            status: ScanRecentStatus::Uncertain,
        },
    ];
    let scan_progress = ScanProgress {
        job_id: "job-1".into(),
        done: 3500,
        total: 3593,
        from_cache: 3400,
        analyzed: 100,
        confirmed: 3320,
        uncertain: 58,
        rejected: 85,
        no_face: 33,
        failed: 4,
        current_file: Some("IMG_20220827.jpg".into()),
        photos_per_second: 121.5,
        eta_ms: Some(765),
        recent: scan_recent.clone(),
    };
    put("ScanRecent", v(&scan_recent[0]));
    put("ScanProgress", v(&scan_progress));
    put("ScanSummary", v(scan_summary()));
    put(
        "ScanEvent_started",
        v(ScanEvent::Started(JobStarted {
            job_id: "job-1".into(),
            total: 3593,
        })),
    );
    put("ScanEvent_progress", v(ScanEvent::Progress(scan_progress)));
    put("ScanEvent_finished", v(ScanEvent::Finished(scan_summary())));
    put(
        "ScanEvent_failed",
        v(ScanEvent::Failed(JobFailed {
            job_id: "job-1".into(),
            error: IpcError::new(
                ErrorKind::ModelUnavailable,
                "The face models couldn't be loaded. Reinstall FaceTimelapse.",
            ),
        })),
    );
    put(
        "ScanEvent_cancelled",
        v(ScanEvent::Cancelled(JobCancelled {
            job_id: "job-1".into(),
            done: 1800,
        })),
    );
    let day = DayGroup {
        day_key: "2014-08-15".into(),
        photo_ids: vec![ID.into(), ID2.into()],
        selected_id: ID2.into(),
        auto_selected_id: ID.into(),
        manual_selection: true,
        excluded: false,
    };
    put("DayGroup", v(&day));
    put(
        "DaysPatch",
        v(DaysPatch {
            upserted: vec![day],
            removed: vec!["2014-08-16".into()],
        }),
    );
    put("RenderSettings", v(render()));
    let align_recent = vec![AlignRecent {
        id: ID.into(),
        version: "5d0c9e8b1a2f".into(),
        day_key: "2014-08-15".into(),
    }];
    let align_progress = AlignProgress {
        job_id: "job-2".into(),
        done: 1500,
        total: 3004,
        reused: 1200,
        failed: 2,
        current_photo_id: Some(ID.into()),
        frames_per_second: 64.5,
        eta_ms: Some(23_300),
        recent: align_recent.clone(),
    };
    let align_failure = AlignFailure {
        photo_id: ID2.into(),
        error: IpcError::new(ErrorKind::DecodeFailed, "Couldn't read IMG_2014.jpg."),
    };
    let align_summary = AlignSummary {
        job_id: "job-2".into(),
        total: 3004,
        rendered: 1802,
        reused: 1200,
        failed: vec![align_failure.clone()],
        output_size: Size {
            width: 1080,
            height: 1080,
        },
        duration_ms: 28_140,
    };
    put("AlignRecent", v(&align_recent[0]));
    put("AlignProgress", v(&align_progress));
    put("AlignFailure", v(&align_failure));
    put("AlignSummary", v(&align_summary));
    put(
        "AlignEvent_started",
        v(AlignEvent::Started(JobStarted {
            job_id: "job-2".into(),
            total: 3004,
        })),
    );
    put(
        "AlignEvent_progress",
        v(AlignEvent::Progress(align_progress)),
    );
    put(
        "AlignEvent_finished",
        v(AlignEvent::Finished(align_summary)),
    );
    put(
        "AlignEvent_failed",
        v(AlignEvent::Failed(JobFailed {
            job_id: "job-2".into(),
            error: IpcError::new(
                ErrorKind::NoFaceInReference,
                "No face found inside the crop. Widen the crop or pick another reference photo.",
            ),
        })),
    );
    put(
        "AlignEvent_cancelled",
        v(AlignEvent::Cancelled(JobCancelled {
            job_id: "job-2".into(),
            done: 1204,
        })),
    );
    put("FrameAdjust", v(adjust()));
    put(
        "LookDelta",
        v(LookDelta {
            exposure_ev: 0.25,
            color_shift: 1.5,
        }),
    );
    put("FrameSummary", v(frame()));
    put(
        "FrameSummary_lookOff",
        v(FrameSummary {
            look_delta: None,
            adjust: FrameAdjust {
                dx: 0.0,
                dy: 0.0,
                scale: 1.0,
                rotation_deg: 0.0,
            },
            ..frame()
        }),
    );
    put("LookSettings", v(look()));
    put(
        "FramesView",
        v(FramesView {
            status: FramesStatus::Partial,
            output_size: Some(Size {
                width: 1080,
                height: 1080,
            }),
            render: render(),
            look: look(),
            reference_anchors: Some(anchors()),
            frames: vec![frame()],
        }),
    );
    put(
        "FramesView_empty",
        v(FramesView {
            status: FramesStatus::Missing,
            output_size: None,
            render: render(),
            look: LookSettings {
                normalize: NormalizeMode::Off,
                strength: 0.7,
            },
            reference_anchors: None,
            frames: vec![],
        }),
    );
    let export = ImageExportSettings {
        format: ImageFormat::Jpeg,
        jpeg_quality: 92,
        overwrite: false,
    };
    put("ImageExportSettings", v(export));
    let export_progress = ExportProgress {
        job_id: "job-3".into(),
        done: 120,
        total: 3004,
        current_file: Some("20140815.jpg".into()),
        eta_ms: Some(48_000),
    };
    let export_summary = ExportImagesSummary {
        job_id: "job-3".into(),
        dir: "/Users/me/Desktop/aligned".into(),
        written: 3004,
        renamed: 2,
        duration_ms: 51_000,
    };
    put("ExportProgress", v(&export_progress));
    put("ExportImagesSummary", v(&export_summary));
    put(
        "ExportImagesEvent_started",
        v(ExportImagesEvent::Started(JobStarted {
            job_id: "job-3".into(),
            total: 3004,
        })),
    );
    put(
        "ExportImagesEvent_progress",
        v(ExportImagesEvent::Progress(export_progress)),
    );
    put(
        "ExportImagesEvent_finished",
        v(ExportImagesEvent::Finished(export_summary)),
    );
    put(
        "ExportImagesEvent_failed",
        v(ExportImagesEvent::Failed(JobFailed {
            job_id: "job-3".into(),
            error: IpcError::new(
                ErrorKind::DiskFull,
                "The disk is full. Free some space and try again.",
            ),
        })),
    );
    put(
        "ExportImagesEvent_cancelled",
        v(ExportImagesEvent::Cancelled(JobCancelled {
            job_id: "job-3".into(),
            done: 120,
        })),
    );
    put(
        "Crossfade",
        v(Crossfade {
            frames: 2,
            easing: Easing::EaseInOut,
        }),
    );
    put("CaptionOptions", v(video().caption));
    put("VideoSettings", v(video()));
    put(
        "VideoSettings_duration",
        v(VideoSettings {
            pace: Pace::Duration { seconds: 60.0 },
            quality: VideoQuality::Bitrate { kbps: 12_000 },
            caption: None,
            resolution: Resolution::P2160,
            ..video()
        }),
    );
    let video_progress = VideoProgress {
        job_id: "job-4".into(),
        frames_done: 1500,
        frames_total: 3007,
        encode_fps: 88.5,
        eta_ms: Some(17_000),
    };
    let video_summary = VideoSummary {
        job_id: "job-4".into(),
        path: "/Users/me/Movies/FaceTimelapse 2012–2022.mp4".into(),
        frames: 3007,
        duration_secs: 300.7,
        bytes: 412_345_678,
        elapsed_ms: 34_000,
    };
    put("VideoProgress", v(&video_progress));
    put("VideoSummary", v(&video_summary));
    put(
        "ExportVideoEvent_started",
        v(ExportVideoEvent::Started(JobStarted {
            job_id: "job-4".into(),
            total: 3007,
        })),
    );
    put(
        "ExportVideoEvent_progress",
        v(ExportVideoEvent::Progress(video_progress)),
    );
    put(
        "ExportVideoEvent_finished",
        v(ExportVideoEvent::Finished(video_summary)),
    );
    put(
        "ExportVideoEvent_failed",
        v(ExportVideoEvent::Failed(JobFailed {
            job_id: "job-4".into(),
            error: IpcError::new(
                ErrorKind::EncodeFailed,
                "The video couldn't be encoded. Try a lower resolution or quality.",
            ),
        })),
    );
    put(
        "ExportVideoEvent_cancelled",
        v(ExportVideoEvent::Cancelled(JobCancelled {
            job_id: "job-4".into(),
            done: 1500,
        })),
    );
    let scan_info = ScanInfo {
        status: ScanStatus::Complete,
        last_summary: Some(scan_summary()),
        scanned_at: Some("2026-10-24T10:00:00".into()),
    };
    let frames_info = FramesInfo {
        status: FramesStatus::Complete,
        count: 3004,
        expected: 3004,
        output_size: Some(Size {
            width: 1080,
            height: 1080,
        }),
    };
    let recents = Recents {
        references: vec!["/Users/me/Pictures/reference/IMG_20140815_142326.jpg".into()],
        folders: vec!["/Users/me/Pictures/selfies".into()],
    };
    put("ScanInfo", v(&scan_info));
    put("FramesInfo", v(frames_info));
    put("Recents", v(&recents));
    put(
        "SessionSnapshot",
        v(SessionSnapshot {
            reference: Some(reference_state()),
            folder: Some(folder()),
            scan: scan_info,
            counts: counts(),
            render: render(),
            look: look(),
            frames: frames_info,
            image_export: export,
            video: video(),
            active_job: Some(ActiveJob {
                job_id: "job-4".into(),
                kind: JobKind::ExportVideo,
            }),
            recents,
        }),
    );
    put(
        "SessionSnapshot_empty",
        v(SessionSnapshot {
            reference: None,
            folder: None,
            scan: ScanInfo {
                status: ScanStatus::Missing,
                last_summary: None,
                scanned_at: None,
            },
            counts: LibraryCounts::default(),
            render: render(),
            look: LookSettings {
                normalize: NormalizeMode::Off,
                strength: 0.7,
            },
            frames: FramesInfo {
                status: FramesStatus::Missing,
                count: 0,
                expected: 0,
                output_size: None,
            },
            image_export: ImageExportSettings {
                format: ImageFormat::Png,
                jpeg_quality: 95,
                overwrite: false,
            },
            video: VideoSettings {
                crossfade: Crossfade {
                    frames: 0,
                    easing: Easing::EaseInOut,
                },
                caption: None,
                ..video()
            },
            active_job: None,
            recents: Recents::default(),
        }),
    );
    super::enums::put_all(&mut put);
    m
}
