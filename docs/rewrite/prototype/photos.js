/* Photo source for the committed prototype.
   Everything here is SYNTHETIC: stand-in portraits drawn as SVG and a
   generated day coverage. No personal photos are referenced from git.
   A local-only copy outside the repo swaps this file for one that maps the
   same keys to real, already-aligned thumbnails. Keep the API identical:

     FTPhotos.url(kind, key)  kind: "al" (aligned 3:4) | "alL" (large aligned)
                              | "face" (square face crop) | "thumb" (original 4:3)
                              | "ref" (reference original)
     FTPhotos.days            [{ date: "YYYY-MM-DD", n: photosThatDay }]
     FTPhotos.frameCount      number of aligned frames in the timelapse
*/
(function () {
  "use strict";

  const START = Date.UTC(2012, 8, 1);
  const END = Date.UTC(2022, 7, 31);
  const DAY = 86400000;

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return ((s >>> 0) % 100000) / 100000;
    };
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // Rooms the subject lived in, as wall colours (stand-in content, not UI).
  const ROOMS = ["#b4744a", "#6f8250", "#8d939b", "#c7b597", "#3f3b49", "#a7623f", "#d0c9bc", "#56677a"];
  const SHIRTS = ["#2f3a4a", "#d9d4c8", "#6b4a3a", "#3e5a44", "#9a9c9e", "#1f2226", "#b9a27a"];

  function portrait(key, w, h, opts) {
    const r = rng(hash(key));
    const room = ROOMS[Math.floor(r() * ROOMS.length)];
    const shirt = SHIRTS[Math.floor(r() * SHIRTS.length)];
    const age = opts.age == null ? r() : opts.age;           // 0..1 across the decade
    const ev = (r() - 0.5) * 0.5;                             // exposure wobble
    const skinL = Math.round(62 + ev * 30);
    const skin = `hsl(${22 + Math.round(r() * 6)} ${38 + Math.round(r() * 8)}% ${skinL}%)`;
    const hair = `hsl(26 ${30 + Math.round(r() * 10)}% ${14 + Math.round(r() * 8)}%)`;
    const jitter = opts.aligned ? 0 : 1;
    const cx = w * (0.5 + jitter * (r() - 0.5) * 0.18);
    const cy = h * (opts.cy || 0.42) + jitter * (r() - 0.5) * h * 0.08;
    const s = (opts.scale || 1) * (1 + jitter * (r() - 0.5) * 0.25);
    const hr = Math.min(w, h) * 0.2 * s;                      // head radius x
    const beard = age > 0.62 ? Math.min(1, (age - 0.62) / 0.25) : 0;
    const light = 0.18 + r() * 0.25;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<defs><radialGradient id="l" cx="${30 + r() * 40}%" cy="20%" r="80%"><stop offset="0" stop-color="#fff" stop-opacity="${light}"/><stop offset="1" stop-color="#000" stop-opacity="${0.35 - ev * 0.4}"/></radialGradient>` +
      `<radialGradient id="f" cx="45%" cy="38%" r="65%"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></radialGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="${room}"/>` +
      `<rect x="${w * 0.08}" y="0" width="${w * 0.05}" height="${h}" fill="#000" opacity=".06"/>` +
      `<ellipse cx="${cx}" cy="${cy + hr * 3.05}" rx="${hr * 2.4}" ry="${hr * 1.55}" fill="${shirt}"/>` +
      `<rect x="${cx - hr * 0.42}" y="${cy + hr * 0.9}" width="${hr * 0.84}" height="${hr * 0.9}" fill="${skin}"/>` +
      `<ellipse cx="${cx}" cy="${cy}" rx="${hr}" ry="${hr * 1.3}" fill="${skin}"/>` +
      `<ellipse cx="${cx}" cy="${cy}" rx="${hr}" ry="${hr * 1.3}" fill="url(#f)"/>` +
      `<path d="M${cx - hr * 1.04},${cy - hr * 0.2} C${cx - hr * 1.1},${cy - hr * 1.55} ${cx + hr * 1.1},${cy - hr * 1.6} ${cx + hr * 1.04},${cy - hr * 0.2} C${cx + hr * 0.7},${cy - hr * 0.95} ${cx - hr * 0.7},${cy - hr * 0.95} ${cx - hr * 1.04},${cy - hr * 0.2}Z" fill="${hair}"/>` +
      (beard ? `<path d="M${cx - hr * 0.95},${cy + hr * 0.25} C${cx - hr * 0.9},${cy + hr * 1.5} ${cx + hr * 0.9},${cy + hr * 1.5} ${cx + hr * 0.95},${cy + hr * 0.25} C${cx + hr * 0.5},${cy + hr * 0.75} ${cx - hr * 0.5},${cy + hr * 0.75} ${cx - hr * 0.95},${cy + hr * 0.25}Z" fill="${hair}" opacity="${0.35 + beard * 0.6}"/>` : "") +
      `<g fill="#000" opacity=".28"><ellipse cx="${cx - hr * 0.38}" cy="${cy - hr * 0.08}" rx="${hr * 0.13}" ry="${hr * 0.07}"/><ellipse cx="${cx + hr * 0.38}" cy="${cy - hr * 0.08}" rx="${hr * 0.13}" ry="${hr * 0.07}"/></g>` +
      `<rect width="${w}" height="${h}" fill="url(#l)"/>` +
      `</svg>`;
  }

  const cache = new Map();
  function svgUrl(key, w, h, opts) {
    const k = `${key}|${w}x${h}`;
    if (!cache.has(k)) cache.set(k, "data:image/svg+xml;utf8," + encodeURIComponent(portrait(key, w, h, opts)));
    return cache.get(k);
  }

  // Synthetic coverage: almost every day, a few gaps, rare multi-photo days.
  const days = [];
  {
    const r = rng(20120901);
    let gap = 0;
    for (let t = START; t <= END; t += DAY) {
      const d = new Date(t);
      const date = d.toISOString().slice(0, 10);
      if (gap > 0) { gap--; continue; }
      if (r() < 0.006) { gap = 1 + Math.floor(r() * 4); continue; }
      days.push({ date, n: r() < 0.012 ? 2 + Math.floor(r() * 2) : 1 });
    }
  }
  const frameCount = 3547;

  function ageOf(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (m) return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - START) / (END - START);
    if (typeof key === "number") return key / frameCount;
    return null;
  }

  function url(kind, key) {
    const named = { ref: 0.24, current: 0.2, prev: 0.2, review: 0.48, enc: 0.34, alt0: 0.17, alt1: 0.17, alt2: 0.17 };
    const age = key in named ? named[key] : ageOf(key);
    const id = `${kind}:${key === "prev" ? "current" : key}`;
    switch (kind) {
      case "al": return svgUrl(id, 240, 320, { aligned: true, age, cy: 0.43 });
      case "alL": return svgUrl(id + (key === "prev" ? "~" : ""), 480, 640, { aligned: true, age, cy: 0.43 });
      case "face": return svgUrl(id, 120, 120, { aligned: true, age, cy: 0.46, scale: 1.45 });
      case "thumb": return svgUrl(id, 240, 180, { aligned: false, age, cy: 0.44 });
      case "ref": return svgUrl("ref", 1600, 1184, { aligned: true, age: 0.24, cy: 0.42, scale: 1.25 });
      default: return "";
    }
  }

  // Frame shown in the player for screenshots, and a coarse playback sequence.
  const current = { date: "2014-08-14", frame: 812 };
  function sequence() {
    const out = [];
    const n = 60;
    for (let k = 0; k < n; k++) {
      const i = Math.round((k / (n - 1)) * (days.length - 1));
      out.push({ url: url("alL", Math.round((i / days.length) * frameCount)), date: days[i].date, frame: Math.round((i / days.length) * frameCount) + 1 });
    }
    return out;
  }

  window.FTPhotos = { url, days, frameCount, current, sequence, playFps: 8, synthetic: true };
})();
