//! End-to-end run of the engine on a real folder:
//! scan → match → days → align → contact sheet.
//!
//! ```text
//! cargo run --release -p face-engine --example scan -- <folder> <reference> \
//!     [--out DIR] [--cache DIR] [--align N|all] [--resolution 1080p] \
//!     [--threads N] [--rescan] [--tsv FILE] [--backdrop extended|dimmed|blurred|black]
//! ```
//!
//! `FT_DUMP_FRAMES=1` also copies every aligned master to `<out>/frames/`
//! (for side-by-side and crossfade checks).
//!
//! Models are read from `FT_MODELS_DIR` or `<repo>/models`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use face_engine::align::{RenderSettings, RenderTarget, Resolution};
use face_engine::days::{DayCandidate, DayDecisions, group_days, timeline};
use face_engine::frames::{FingerprintInputs, render_fingerprint};
use face_engine::image::{Filter, RgbImage};
use face_engine::matching::MatchStatus;
use face_engine::reference::{AspectPreset, default_crop};
use face_engine::scan::{ScanEvent, ScanOptions};
use face_engine::warp::BackdropMode;
use face_engine::{
    AlignItem, AlignJob, AlignSpec, CancelToken, Engine, EngineConfig, decode, encode,
};

struct Args {
    folder: PathBuf,
    reference: PathBuf,
    out: PathBuf,
    cache: PathBuf,
    align: Option<usize>,
    resolution: Resolution,
    threads: Option<usize>,
    rescan: bool,
    tsv: Option<PathBuf>,
    backdrop: BackdropMode,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let usage = "usage: scan <folder> <reference> [--out DIR] [--cache DIR] [--align N|all] \
                 [--resolution source|2160p|1080p|720p] [--threads N] [--rescan] [--tsv FILE] \
                 [--backdrop extended|dimmed|blurred|black]";
    let folder = it.next().ok_or(usage)?.into();
    let reference = it.next().ok_or(usage)?.into();
    let tmp = std::env::temp_dir().join("face-engine-example");
    let mut a = Args {
        folder,
        reference,
        out: tmp.join("out"),
        cache: tmp.join("cache"),
        align: Some(48),
        resolution: Resolution::P1080,
        threads: None,
        rescan: false,
        tsv: None,
        backdrop: BackdropMode::default(),
    };
    while let Some(flag) = it.next() {
        let mut val = || it.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--out" => a.out = val()?.into(),
            "--cache" => a.cache = val()?.into(),
            "--align" => {
                let v = val()?;
                a.align = if v == "all" {
                    None
                } else {
                    Some(v.parse().map_err(|e| format!("{e}"))?)
                };
            }
            "--resolution" => {
                a.resolution =
                    serde_json::from_str(&format!("\"{}\"", val()?)).map_err(|e| e.to_string())?;
            }
            "--threads" => a.threads = Some(val()?.parse().map_err(|e| format!("{e}"))?),
            "--rescan" => a.rescan = true,
            "--tsv" => a.tsv = Some(val()?.into()),
            "--backdrop" => {
                a.backdrop =
                    serde_json::from_str(&format!("\"{}\"", val()?)).map_err(|e| e.to_string())?;
            }
            other => return Err(format!("unknown flag {other}\n{usage}")),
        }
    }
    Ok(a)
}

fn models_dir() -> PathBuf {
    std::env::var_os("FT_MODELS_DIR").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models"),
        PathBuf::from,
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args()?;
    std::fs::create_dir_all(&args.out)?;
    let t0 = Instant::now();
    let mut cfg = EngineConfig::new(models_dir(), &args.cache);
    cfg.threads = args.threads;
    let engine = Engine::new(cfg)?;
    println!(
        "engine: {} threads, fingerprint {}, loaded in {:?}",
        engine.threads(),
        engine.fingerprint(),
        t0.elapsed()
    );

    // Reference: whole image, free aspect (legacy default).
    let t = Instant::now();
    let reference = engine.load_reference(&args.reference, 0.0)?;
    let crop = default_crop(reference.size(), AspectPreset::Free);
    let det = engine
        .detect_reference(&reference, crop)?
        .ok_or("no face in the reference photo")?;
    println!(
        "reference: {}x{}, face conf {:.3}, auto-rotation {:?}°, in {:?}",
        reference.size().width,
        reference.size().height,
        det.confidence,
        reference
            .auto_rotation_deg()
            .map(|a| (a * 100.0).round() / 100.0),
        t.elapsed()
    );

    // Scan.
    let seen = AtomicUsize::new(0);
    let sink = |e: ScanEvent| {
        if let ScanEvent::Progress {
            counts,
            photos_per_second,
            ..
        } = e
            && seen.fetch_add(1, Ordering::Relaxed) % 500 == 499
        {
            println!(
                "  {}/{} ({:.0} photos/s)",
                counts.done, counts.total, photos_per_second
            );
        }
    };
    let options = ScanOptions {
        rescan_all: args.rescan,
        ..ScanOptions::default()
    };
    let t = Instant::now();
    let report = engine.scan(
        &args.folder,
        &det.embedding,
        options,
        &sink,
        &CancelToken::new(),
    )?;
    let secs = t.elapsed().as_secs_f64();
    let c = report.counts;
    let with_face = report
        .photos
        .iter()
        .filter(|p| !p.analysis.faces().is_empty())
        .count();
    println!(
        "scan: {} photos in {secs:.2}s = {:.1} photos/s (analyzed {}, cached {}, unsupported {})",
        report.photos.len(),
        report.photos.len() as f64 / secs,
        c.analyzed,
        c.from_cache,
        report.unsupported.len()
    );
    println!(
        "  detection rate {:.2}% | confirmed {} uncertain {} rejected {} noFace {} failed {}",
        100.0 * with_face as f64 / report.photos.len().max(1) as f64,
        c.confirmed,
        c.uncertain,
        c.rejected,
        c.no_face,
        c.failed
    );
    if let Some(tsv) = &args.tsv {
        let mut s = String::from("relPath\tstatus\tcosine\tscore\tfaces\ttakenAt\tdateSource\n");
        for p in &report.photos {
            let m = p.matched;
            s.push_str(&format!(
                "{}\t{:?}\t{:.4}\t{:.4}\t{}\t{}\t{:?}\n",
                p.entry.rel_path,
                p.status,
                m.map_or(f64::NAN, |m| m.cosine),
                m.map_or(0.0, |m| m.score),
                p.analysis.faces().len(),
                p.analysis.taken_at,
                p.analysis.date_source
            ));
        }
        std::fs::write(tsv, s)?;
    }

    // Days: confirmed photos, best match per day.
    let photos: Vec<_> = report
        .photos
        .iter()
        .filter(|p| p.status == MatchStatus::Confirmed)
        .collect();
    let candidates: Vec<DayCandidate> = photos
        .iter()
        .map(|p| DayCandidate {
            id: p.id.clone(),
            rel_path: p.entry.rel_path.clone(),
            taken_at: p.analysis.taken_at,
            score: p.matched.map_or(0.0, |m| m.score),
        })
        .collect();
    let groups = group_days(&candidates, &DayDecisions::default());
    let line = timeline(&groups);
    println!(
        "days: {} (from {} confirmed photos)",
        line.len(),
        candidates.len()
    );

    // Align an evenly spaced selection (or everything).
    let n = args.align.unwrap_or(line.len()).min(line.len());
    let picks: Vec<_> = (0..n).map(|i| &line[i * line.len() / n.max(1)]).collect();
    let out_size = args
        .resolution
        .output_size(crop.width as u32, crop.height as u32)
        .ok_or("empty crop")?;
    let target = RenderTarget::from_crop_anchors(&det.anchors, out_size);
    let settings = RenderSettings {
        resolution: args.resolution,
        backdrop: args.backdrop,
        ..RenderSettings::default()
    };
    let fingerprint = render_fingerprint(&FingerprintInputs {
        engine: &engine.fingerprint(),
        reference_path: &args.reference.to_string_lossy(),
        reference_version: "example",
        rotation_deg: 0.0,
        crop,
        aspect: "free",
        anchors: det.anchors,
        output: out_size,
        settings,
    });
    let by_id: std::collections::HashMap<&str, _> =
        photos.iter().map(|p| (p.id.as_str(), *p)).collect();
    let items: Vec<AlignItem> = picks
        .iter()
        .filter_map(|(day, id)| {
            let p = by_id.get(id.as_str())?;
            let face = p.analysis.faces().get(p.matched?.face_index)?.clone();
            Some(AlignItem {
                photo_id: id.clone(),
                photo_version: p.version.clone(),
                source: p.entry.path.clone(),
                face,
                day: *day,
                adjust: Default::default(),
            })
        })
        .collect();
    let job = AlignJob {
        items,
        spec: AlignSpec {
            target,
            settings,
            fingerprint,
        },
    };
    let t = Instant::now();
    let aligned = engine.align(&job, &|_| {}, &CancelToken::new())?;
    let secs = t.elapsed().as_secs_f64();
    let rendered = aligned.frames.iter().filter(|f| !f.reused).count();
    let mut residuals: Vec<f64> = aligned.frames.iter().map(|f| f.residual_px).collect();
    residuals.sort_by(f64::total_cmp);
    let pct = |p: f64| {
        residuals
            .get(((residuals.len().max(1) - 1) as f64 * p) as usize)
            .copied()
            .unwrap_or(0.0)
    };
    println!(
        "align: {} frames ({} rendered, {} reused, {} failed) {}x{} in {secs:.2}s = {:.1} frames/s",
        aligned.frames.len(),
        rendered,
        aligned.frames.len() - rendered,
        aligned.failures.len(),
        out_size.width,
        out_size.height,
        rendered as f64 / secs
    );
    println!(
        "  residual px: median {:.2}, p90 {:.2}, max {:.2}",
        pct(0.5),
        pct(0.9),
        pct(1.0)
    );
    for f in &aligned.failures {
        println!("  failed {}: {}", f.photo_id, f.message);
    }

    // Outputs: a few full frames + a contact sheet.
    for f in aligned
        .frames
        .iter()
        .step_by((aligned.frames.len() / 6).max(1))
        .take(6)
    {
        std::fs::copy(
            &f.master,
            args.out
                .join(format!("aligned_{}.jpg", f.day.format("%Y%m%d"))),
        )?;
    }
    if std::env::var_os("FT_DUMP_FRAMES").is_some() {
        let dir = args.out.join("frames");
        std::fs::create_dir_all(&dir)?;
        for (i, f) in aligned.frames.iter().enumerate() {
            std::fs::copy(
                &f.master,
                dir.join(format!("{i:02}_{}.jpg", f.day.format("%Y%m%d"))),
            )?;
        }
    }
    // At most 48 evenly spaced frames on the sheet; the mean uses up to 600.
    let spaced = |max: usize| -> Vec<PathBuf> {
        let n = aligned.frames.len();
        let k = n.min(max);
        (0..k)
            .map(|i| aligned.frames[i * n / k.max(1)].master.clone())
            .collect()
    };
    let sheet = contact_sheet(&spaced(48), 8, 200)?;
    std::fs::write(
        args.out.join("contact_sheet.jpg"),
        encode::jpeg(&sheet, 88)?,
    )?;
    let overlay = mean_image(&spaced(600), 640)?;
    std::fs::write(
        args.out.join("mean_of_frames.jpg"),
        encode::jpeg(&overlay, 90)?,
    )?;
    println!(
        "outputs in {} (total {:?})",
        args.out.display(),
        t0.elapsed()
    );
    Ok(())
}

/// Tiles frames into a grid of `cols` columns, `cell` px wide.
fn contact_sheet(paths: &[PathBuf], cols: usize, cell: u32) -> face_engine::Result<RgbImage> {
    let tiles: Vec<RgbImage> = paths
        .iter()
        .map(|p| {
            decode::decode_file(p, decode::DecodeTarget::MinLongEdge(cell))?
                .image
                .fit_within(cell, Filter::Bilinear)
        })
        .collect::<face_engine::Result<_>>()?;
    let th = tiles.iter().map(RgbImage::height).max().unwrap_or(1);
    let rows = tiles.len().div_ceil(cols).max(1);
    let (w, h) = (cell as usize * cols, th as usize * rows);
    let mut data = vec![20u8; w * h * 3];
    for (i, t) in tiles.iter().enumerate() {
        let (x0, y0) = ((i % cols) * cell as usize, (i / cols) * th as usize);
        for y in 0..t.height() as usize {
            let src = &t.as_raw()[y * t.stride()..(y + 1) * t.stride()];
            let dst = ((y0 + y) * w + x0) * 3;
            data[dst..dst + src.len()].copy_from_slice(src);
        }
    }
    RgbImage::from_raw(w as u32, h as u32, data)
}

/// Pixel-wise mean of all frames (sharp eyes/nose/mouth ⇒ good alignment).
fn mean_image(paths: &[PathBuf], width: u32) -> face_engine::Result<RgbImage> {
    let mut acc: Vec<f64> = Vec::new();
    let mut size = (0, 0);
    for p in paths {
        let img = decode::decode_file(p, decode::DecodeTarget::MinLongEdge(width))?
            .image
            .fit_within(width, Filter::Bilinear)?;
        if acc.is_empty() {
            acc = vec![0.0; img.as_raw().len()];
            size = (img.width(), img.height());
        }
        if (img.width(), img.height()) == size {
            acc.iter_mut()
                .zip(img.as_raw())
                .for_each(|(a, v)| *a += f64::from(*v));
        }
    }
    let n = paths.len().max(1) as f64;
    RgbImage::from_raw(
        size.0,
        size.1,
        acc.iter().map(|v| (v / n).round() as u8).collect(),
    )
}
