/* Prototype behaviour. Not production code: phase 2 rebuilds this in React.
   URL params: ?screen=days&state=dragging&theme=light&sheet=open&sheetstate=encoding&shot=1 */
(function () {
  "use strict";

  const P = window.FTPhotos;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const params = new URLSearchParams(location.search);
  const DAY = 86400000;
  const START = Date.UTC(2012, 8, 1);
  const SPAN = Math.round((Date.UTC(2022, 7, 31) - START) / DAY) + 1;
  const fmt = new Intl.NumberFormat("en-US");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const SCREENS = {
    setup: ["ready", "empty", "dragover", "detecting", "noface"],
    scan: ["running", "cancel", "done"],
    review: ["default", "compare", "done"],
    days: ["default", "dragging"],
    timelapse: ["default", "onion", "aligning"],
  };
  const SHEET_STATES = ["sheet", "encoding", "done"];

  // Sidebar ledger per screen/state: [status, text] for each stage.
  const LEDGER = {
    "setup:empty": { setup: ["current", "Not set yet"], scan: ["locked", "Waiting for setup"], review: ["locked", "After the scan"], days: ["locked", "After the scan"], timelapse: ["locked", "After the days"] },
    "setup:ready": { setup: ["done", "3:4 · eyes level"], scan: ["ready", "Ready · 3,593 photos"], review: ["locked", "After the scan"], days: ["locked", "After the scan"], timelapse: ["locked", "After the days"] },
    "scan:running": { setup: ["done", "3:4 · eyes level"], scan: ["running", "62% · 36 s left"], review: ["locked", "27 unsure so far"], days: ["locked", "After the scan"], timelapse: ["locked", "After the days"] },
    "scan:done": { setup: ["done", "3:4 · eyes level"], scan: ["done", "3,529 matched"], review: ["attention", "41 to look at"], days: ["ready", "3,529 days"], timelapse: ["locked", "After the days"] },
    "review": { setup: ["done", "3:4 · eyes level"], scan: ["done", "3,529 matched"], review: ["attention", "29 of 41 left"], days: ["ready", "3,529 days"], timelapse: ["locked", "After the days"] },
    "review:done": { setup: ["done", "3:4 · eyes level"], scan: ["done", "3,529 matched"], review: ["done", "29 kept · 12 left out"], days: ["ready", "3,547 days"], timelapse: ["locked", "After the days"] },
    "days": { setup: ["done", "3:4 · eyes level"], scan: ["done", "3,529 matched"], review: ["done", "29 kept · 12 left out"], days: ["done", "3,547 days chosen"], timelapse: ["ready", "3 days to re-align"] },
    "timelapse:aligning": { setup: ["done", "3:4 · eyes level"], scan: ["done", "3,529 matched"], review: ["done", "29 kept · 12 left out"], days: ["done", "3,547 days chosen"], timelapse: ["running", "Aligning · 1 min 40 s"] },
    "timelapse": { setup: ["done", "3:4 · eyes level"], scan: ["done", "3,529 matched"], review: ["done", "29 kept · 12 left out"], days: ["done", "3,547 days chosen"], timelapse: ["done", "1:58 at 30 fps"] },
  };

  LEDGER["setup:dragover"] = LEDGER["setup:empty"];
  LEDGER["setup:detecting"] = { ...LEDGER["setup:ready"], setup: ["current", "Finding your face…"], scan: ["locked", "Needs a reference face"] };
  LEDGER["setup:noface"] = { ...LEDGER["setup:ready"], setup: ["attention", "No face in the crop"], scan: ["locked", "Needs a face in the crop"] };
  LEDGER["scan:cancel"] = LEDGER["scan:running"];

  const S = {
    screen: SCREENS[params.get("screen")] ? params.get("screen") : (location.hash.slice(1) in SCREENS ? location.hash.slice(1) : "setup"),
    state: params.get("state"),
    sheet: params.get("sheet") === "open",
    sheetState: SHEET_STATES.includes(params.get("sheetstate")) ? params.get("sheetstate") : "sheet",
  };
  if (!SCREENS[S.screen].includes(S.state)) S.state = SCREENS[S.screen][0];

  if (params.get("shot") === "1") document.documentElement.classList.add("shot");
  const theme = params.get("theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

  /* ── helpers ─────────────────────────────────────────────── */
  const dateAt = (i) => new Date(START + i * DAY);
  const iso = (d) => d.toISOString().slice(0, 10);
  const dayIndex = (isoDate) => Math.round((Date.parse(isoDate + "T00:00:00Z") - START) / DAY);
  const present = new Map(P.days.map((d) => [d.date, d.n]));
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const img = (src, alt = "") => { const i = new Image(); i.decoding = "async"; i.src = src; i.alt = alt; return i; };
  const markSvg = (id, cls = "mark") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

  function hydrate(root = document) {
    $$("img[data-photo]", root).forEach((el) => {
      const [kind, key] = el.dataset.photo.split(":");
      const src = P.url(kind, key);
      if (src && el.getAttribute("src") !== src) el.src = src;
    });
  }

  /* ── state + routing ─────────────────────────────────────── */
  function apply() {
    const b = document.body;
    b.dataset.screen = S.screen;
    b.dataset.state = S.state;
    b.dataset.sheet = S.sheet ? "open" : "closed";
    const jobs = [];
    if (S.screen === "scan" && S.state !== "done") jobs.push("scan");
    if (S.screen === "timelapse" && S.state === "aligning") jobs.push("align");
    if (S.sheet && S.sheetState === "encoding") jobs.push("export");
    b.dataset.jobs = jobs.join(" ");

    $$("[data-show-state]").forEach((el) => {
      const inSheet = !!el.closest(".sheet");
      const current = inSheet ? S.sheetState : S.state;
      el.hidden = !el.dataset.showState.split(" ").includes(current);
    });

    const ledger = LEDGER[`${S.screen}:${S.state}`] || LEDGER[S.screen] || LEDGER["timelapse"];
    $$(".stage").forEach((a) => {
      const id = a.dataset.go;
      const [status, text] = ledger[id] || ["ready", ""];
      a.dataset.status = status;
      const st = $(".stage-status", a);
      st.innerHTML = (status === "attention" ? '<b class="dot-safelight" aria-hidden="true"></b>' : "") + text;
      const oldMeter = $(".stage-meter", a);
      if (oldMeter) oldMeter.remove();
      const prog = { scan: S.screen === "scan" && S.state !== "done" ? 0.62 : null, timelapse: S.screen === "timelapse" && S.state === "aligning" ? 0.34 : (S.sheet && S.sheetState === "encoding" ? 0.34 : null) }[id];
      if (prog != null) a.insertAdjacentHTML("beforeend", `<span class="stage-meter" role="progressbar" aria-label="${id === "scan" ? "Scan" : "Job"} progress" aria-valuenow="${Math.round(prog * 100)}" aria-valuemin="0" aria-valuemax="100"><i style="--p:${prog}"></i></span>`);
      if (id === "timelapse" && S.sheet && S.sheetState === "encoding") { a.dataset.status = "running"; st.textContent = "Encoding · 52 s left"; }
      if (id === S.screen) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      if (status === "locked") a.setAttribute("aria-disabled", "true"); else a.removeAttribute("aria-disabled");
    });

    const empty = S.screen === "setup" && (S.state === "empty" || S.state === "dragover");
    $(".project-meta strong").textContent = empty ? "New timelapse" : "everyday photos";
    $(".project-meta .meta").textContent = empty ? "No photos yet" : "3,593 photos · 2012–22";
    $(".project-ref").style.visibility = empty ? "hidden" : "";
    const onionChip = $("#t-onion");
    if (onionChip) onionChip.setAttribute("aria-pressed", String(S.state === "onion"));
    $("#proto-screen").value = S.screen;
    fillStates();
    $("#proto-state").value = S.sheet ? `sheet:${S.sheetState}` : S.state;
    $("#proto-theme").value = document.documentElement.dataset.theme || "";

    render();
  }

  function go(screen, state) {
    S.screen = screen;
    S.state = state || SCREENS[screen][0];
    S.sheet = false;
    apply();
  }

  /* ── Scan: contact strips ────────────────────────────────── */
  function renderScan() {
    const host = $("#scan-sheet");
    const per = matchMedia("(max-width: 1180px)").matches ? 7 : 10;
    const done = S.state === "done";
    const read = done ? 3529 : 2174;
    const strips = 9;
    const first = Math.max(0, read - (strips - 1) * per - (read % per || per));
    let html = "";
    let n = first;
    for (let s = 0; s < strips; s++) {
      html += `<div class="strip" style="--n:${per}">`;
      for (let c = 0; c < per; c++, n++) {
        const isNew = !done && n >= read - 4 && n < read;
        if (n >= read) {
          const reading = !done && n === read;
          html += `<div class="frame-cell ${reading ? "reading develop" : "unexposed"}" ${reading ? 'style="--d:200ms"' : ""}>${reading ? `<img src="${P.url("thumb", n)}" alt="">` : ""}</div>`;
          continue;
        }
        const day = P.days[Math.min(n, P.days.length - 1)].date;
        const unsure = (n * 7919) % 53 === 0;
        html += `<div class="frame-cell${unsure ? " unsure" : ""}${isNew ? " develop" : ""}" ${isNew ? `style="--d:${(n - read + 4) * 90}ms"` : ""}>` +
          `<span class="edge" aria-hidden="true"><b>▸ ${String(n + 1).padStart(4, "0")}</b>  ${day.replace(/-/g, "·")}</span>` +
          `<img src="${P.url("thumb", n)}" alt="" loading="lazy">` +
          (unsure ? '<span class="q" role="img" aria-label="Unsure match"><svg class="icon"><use href="#i-question"/></svg></span>' : "") + `</div>`;
      }
      html += `</div>`;
    }
    host.innerHTML = html;
    host.scrollTop = host.scrollHeight;
  }

  /* ── Review queue ────────────────────────────────────────── */
  const reviewDecisions = Array.from({ length: 41 }, (_, i) => (i < 11 ? ((i * 5) % 4 === 1 ? "out" : "kept") : "pending"));
  let reviewIdx = 11;
  function renderReview() {
    const q = $("#review-queue");
    const dates = Array.from({ length: 41 }, (_, i) => iso(dateAt(Math.round((i + 0.5) * (SPAN / 41)))));
    let html = `<span class="q-count mono-meta">${reviewIdx + 1} / 41</span><div class="q-strip">`;
    reviewDecisions.forEach((d, i) => {
      const cls = i === reviewIdx ? "current" : d;
      const mark = d === "kept" ? `<span class="tick">${markSvg("mark-tick")}</span>` : d === "out" ? markSvg("mark-strike") : "";
      html += `<button class="q-item ${cls}" role="option" aria-selected="${i === reviewIdx}" aria-label="${d === "pending" ? "Not decided" : d === "kept" ? "Kept" : "Left out"}, ${dates[i]}"><span class="edge" aria-hidden="true">▸ ${String(i + 1).padStart(2, "0")}</span><img src="${P.url("face", dates[i])}" alt="">${mark}</button>`;
    });
    html += `</div>`;
    q.innerHTML = html;
  }
  function undoDecision() {
    if (reviewIdx === 0) return;
    reviewIdx -= 1;
    reviewDecisions[reviewIdx] = "pending";
    renderReview();
  }
  function decide(kind) {
    if (reviewIdx >= 41) return;
    reviewDecisions[reviewIdx] = kind;
    reviewIdx = Math.min(40, reviewIdx + 1);
    renderReview();
  }

  /* ── Days: year of faces ─────────────────────────────────── */
  let selectedDay = "2014-05-02";
  const ALT_DAYS = new Set(["2014-05-02", "2014-02-11", "2014-09-27", "2014-12-31"]);
  const MINE_DAYS = new Set(["2014-03-14", "2014-07-22", "2014-11-05"]);
  const EXCLUDED_DAYS = new Set(["2014-06-18"]);
  function renderDays() {
    const year = 2014;
    const grid = $("#year-grid");
    let html = "";
    let have = 0, empty = 0;
    for (let m = 0; m < 12; m++) {
      const first = new Date(Date.UTC(year, m, 1));
      const daysIn = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
      const lead = (first.getUTCDay() + 6) % 7; // Monday first
      let cells = "", mHave = 0;
      for (let p = 0; p < lead; p++) cells += `<span class="day pad" aria-hidden="true"></span>`;
      for (let d = 1; d <= daysIn; d++) {
        const key = `${year}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const has = present.has(key);
        const label = `${WEEKDAYS[new Date(key + "T00:00:00Z").getUTCDay()]} ${d} ${MONTHS_LONG[m]}`;
        if (!has) { empty++; cells += `<button class="day empty" role="gridcell" aria-label="${label}, no photo" data-day="${key}">${d}</button>`; continue; }
        have++; mHave++;
        const cls = ["day", ALT_DAYS.has(key) || present.get(key) > 1 ? "has-alts" : "", MINE_DAYS.has(key) ? "mine" : "", EXCLUDED_DAYS.has(key) ? "excluded" : ""].join(" ");
        const sel = key === selectedDay;
        cells += `<button class="${cls}" role="gridcell" aria-selected="${sel}" aria-label="${label}" data-day="${key}" tabindex="${sel ? 0 : -1}"><img src="${P.url("face", key)}" alt="" loading="lazy">${sel ? markSvg("mark-loop") : ""}</button>`;
      }
      html += `<section class="month" aria-label="${MONTHS_LONG[m]} ${year}"><header class="month-head"><span class="label-caps">${MONTHS_LONG[m]}</span><span class="mono-meta">${mHave}/${daysIn}</span></header>` +
        `<div class="wd" aria-hidden="true">${["M", "T", "W", "T", "F", "S", "S"].map((x) => `<span>${x}</span>`).join("")}</div>` +
        `<div class="month-days" role="row">${cells}</div></section>`;
    }
    grid.innerHTML = html;
    $(".year-head .mono-meta").textContent = `${have} of 365 days · ${ALT_DAYS.size} with alternates · ${empty} empty`;

    const d = new Date(selectedDay + "T00:00:00Z");
    $("#day-weekday").textContent = WEEKDAYS[d.getUTCDay()];
    $(".day-date").textContent = `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    let nb = "";
    for (let k = -3; k <= 3; k++) {
      const nd = iso(new Date(d.getTime() + k * DAY));
      nb += `<div><img class="${k === 0 ? "now" : ""}" src="${P.url("face", nd)}" alt="${nd}"><span aria-hidden="true">${new Date(nd + "T00:00:00Z").getUTCDate()}</span></div>`;
    }
    $("#neighbours").innerHTML = nb;

    if (S.state === "dragging") {
      const src = $(`.day[data-day="2014-05-02"]`), dst = $(`.day[data-day="2014-05-03"]`);
      src && src.classList.add("drag-source");
      if (dst) {
        dst.classList.add("drop-target");
        const host = $(".days-canvas").getBoundingClientRect(), r = dst.getBoundingClientRect();
        const ghost = $(".drag-ghost");
        ghost.style.left = `${r.left - host.left + r.width * 0.55 + $(".days-canvas").scrollLeft}px`;
        ghost.style.top = `${r.top - host.top + r.height * 0.45 + $(".days-canvas").scrollTop}px`;
      }
    }
  }

  /* ── Timelapse: player + filmstrip ───────────────────────── */
  const seq = P.sequence ? P.sequence() : [];
  let playing = false, seqIdx = Math.max(0, seq.findIndex((f) => f.date >= P.current.date)), raf = 0, last = 0;
  function setCaption(dateStr, frameNo) {
    const d = new Date(dateStr + "T00:00:00Z");
    $("#cap-weekday").textContent = WEEKDAYS[d.getUTCDay()];
    $("#cap-date").textContent = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    $("#cap-year").textContent = d.getUTCFullYear();
    $("#cap-frame").textContent = `${String(frameNo).padStart(4, "0")} / ${fmt.format(P.frameCount)}`;
    $("#cap-dayn").textContent = `${fmt.format(dayIndex(dateStr) + 1)} since start`;
    const secs = (frameNo - 1) / 30;
    $("#tc-now").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${(secs % 60).toFixed(1).padStart(4, "0")}`;
    $("#player-img").alt = `Frame for ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    drawRibbon(dateStr);
  }
  function renderPlayer() {
    setCaption(P.current.date, P.current.frame);
    const strip = $("#filmstrip");
    const aligning = S.state === "aligning";
    let html = "";
    for (let k = -9; k <= 9; k++) {
      const fi = P.current.frame + k;
      const pending = aligning && k > 4;
      html += `<div class="film${k === 0 ? " now" : ""}${pending ? " pending" : ""}${aligning && (k === 3 || k === 4) ? " develop" : ""}" role="option" aria-selected="${k === 0}">` +
        `<span class="edge" aria-hidden="true">▸ ${String(fi).padStart(4, "0")}</span>` + (pending ? "" : `<img src="${P.url("al", fi)}" alt="">`) + `</div>`;
    }
    strip.innerHTML = html;
  }
  function tick(t) {
    if (!playing) return;
    if (t - last > 1000 / (P.playFps || 6)) {
      last = t;
      seqIdx = (seqIdx + 1) % seq.length;
      const f = seq[seqIdx];
      $("#player-img").src = f.url;
      setCaption(f.date, f.frame);
    }
    raf = requestAnimationFrame(tick);
  }
  function togglePlay() {
    if (!seq.length) return;
    playing = !playing;
    const b = $("#btn-play");
    b.setAttribute("aria-label", playing ? "Pause" : "Play");
    $("use", b).setAttribute("href", playing ? "#i-pause" : "#i-play");
    if (playing) { seq.forEach((f) => img(f.url)); raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf);
  }

  /* ── Ribbon: decade + focus year on canvas ───────────────── */
  function drawRibbon(focusDate) {
    const focusCv = $("#ribbon-focus"), decCv = $("#ribbon-decade");
    if (!focusCv.offsetParent) return;
    const dpr = window.devicePixelRatio || 1;
    const col = { on: cssVar("--text-2"), strong: cssVar("--text-1"), off: cssVar("--line"), mark: cssVar("--mark"), faint: cssVar("--line"), safelight: cssVar("--safelight") };
    let focusYear = 2014, cursor = null, exposedUntil = Infinity, selected = null;
    if (S.screen === "timelapse") { cursor = dayIndex(focusDate || P.current.date); focusYear = dateAt(cursor).getUTCFullYear(); }
    if (S.screen === "days") { selected = dayIndex(selectedDay); focusYear = 2014; }
    if (S.screen === "scan") { exposedUntil = S.state === "done" ? Infinity : dayIndex("2018-06-11"); focusYear = 2018; }
    $("#ribbon-focus-label").textContent = focusYear;

    // Focus year: one tick per day.
    const fw = focusCv.clientWidth, fh = 34;
    focusCv.width = fw * dpr; focusCv.height = fh * dpr;
    const fc = focusCv.getContext("2d"); fc.scale(dpr, dpr);
    const y0 = Date.UTC(focusYear, 0, 1), daysInYear = (Date.UTC(focusYear + 1, 0, 1) - y0) / DAY;
    const step = fw / daysInYear;
    for (let i = 0; i < daysInYear; i++) {
      const key = iso(new Date(y0 + i * DAY));
      const gi = dayIndex(key);
      const x = Math.round(i * step * 2) / 2;
      const w = Math.max(1, step - (step > 2.4 ? 1 : 0.4));
      if (gi > exposedUntil) { fc.fillStyle = col.faint; fc.globalAlpha = 0.6; fc.fillRect(x, fh - 4, w, 2); fc.globalAlpha = 1; continue; }
      if (!present.has(key)) { fc.fillStyle = col.off; fc.fillRect(x, fh - 6, w, 4); continue; }
      const isMine = MINE_DAYS.has(key) && S.screen === "days";
      fc.fillStyle = isMine ? col.mark : col.on;
      fc.fillRect(x, 8, w, fh - 10);
      if (gi === selected || gi === cursor) { fc.fillStyle = col.strong; fc.fillRect(x - 0.5, 0, Math.max(2, w + 1), fh); }
    }
    if (S.screen === "scan" && exposedUntil !== Infinity) {
      const xi = (exposedUntil - dayIndex(`${focusYear}-01-01`)) * step;
      fc.fillStyle = col.strong; fc.fillRect(xi, 0, 1.5, fh);
    }

    // Decade: binned coverage, focus-year bracket, playhead.
    const dw = decCv.clientWidth, dh = 18;
    decCv.width = dw * dpr; decCv.height = dh * dpr;
    const dc = decCv.getContext("2d"); dc.scale(dpr, dpr);
    const per = SPAN / dw;
    for (let x = 0; x < dw; x++) {
      let hit = 0, tot = 0;
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) { tot++; if (present.has(iso(dateAt(i)))) hit++; }
      const gi = Math.floor(x * per);
      dc.globalAlpha = gi > exposedUntil ? 0.18 : 0.35 + 0.65 * (tot ? hit / tot : 0);
      dc.fillStyle = gi > exposedUntil ? col.off : col.on;
      dc.fillRect(x, 4, 1, dh - 8);
    }
    dc.globalAlpha = 1;
    const fx0 = dayIndex(`${focusYear}-01-01`) / per, fx1 = dayIndex(`${focusYear}-12-31`) / per;
    dc.strokeStyle = col.strong; dc.lineWidth = 1;
    dc.strokeRect(Math.max(0.5, fx0) + 0.5, 0.5, fx1 - fx0, dh - 1);
    const mk = cursor ?? selected;
    if (mk != null) { dc.fillStyle = col.strong; dc.fillRect(mk / per - 1, 0, 2, dh); }

    const years = $("#ribbon-years");
    if (!years.childElementCount) {
      years.innerHTML = Array.from({ length: 10 }, (_, k) => 2013 + k).map((y) => `<span style="left:${(dayIndex(`${y}-01-01`) / SPAN) * 100}%">${y}</span>`).join("");
    }
  }

  /* ── render per screen ───────────────────────────────────── */
  function render() {
    hydrate();
    if (S.screen === "scan") renderScan();
    if (S.screen === "review") renderReview();
    if (S.screen === "days") renderDays();
    if (S.screen === "timelapse") renderPlayer();
    requestAnimationFrame(() => drawRibbon());
  }

  /* ── prototype controls ──────────────────────────────────── */
  function fillStates() {
    const sel = $("#proto-state");
    const opts = SCREENS[S.screen].map((s) => `<option value="${s}">${s}</option>`);
    if (S.screen === "timelapse") SHEET_STATES.forEach((s) => opts.push(`<option value="sheet:${s}">export · ${s}</option>`));
    sel.innerHTML = opts.join("");
  }
  $("#proto-screen").innerHTML = Object.keys(SCREENS).map((s) => `<option value="${s}">${s}</option>`).join("");
  $("#proto-screen").addEventListener("change", (e) => go(e.target.value));
  $("#proto-state").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v.startsWith("sheet:")) { S.sheet = true; S.sheetState = v.slice(6); } else { S.sheet = false; S.state = v; }
    apply();
  });
  $("#proto-theme").addEventListener("change", (e) => {
    if (e.target.value) document.documentElement.dataset.theme = e.target.value; else delete document.documentElement.dataset.theme;
    drawRibbon();
  });

  /* ── interactions ────────────────────────────────────────── */
  document.addEventListener("click", (e) => {
    const stage = e.target.closest(".stage");
    if (stage) { e.preventDefault(); if (stage.dataset.status !== "locked") go(stage.dataset.go); return; }
    const act = e.target.closest("[data-action]");
    if (act) {
      const a = act.dataset.action;
      if (a === "open-export") { S.sheet = true; S.sheetState = "sheet"; apply(); }
      if (a === "close-export") { S.sheet = false; apply(); }
      if (a === "stop-scan") { S.state = "cancel"; apply(); }
      return;
    }
    if (e.target.closest("#btn-play")) { togglePlay(); return; }
    const day = e.target.closest(".day[data-day]:not(.empty)");
    if (day) { selectedDay = day.dataset.day; renderDays(); drawRibbon(); return; }
    if (e.target.closest(".btn-decide.keep")) decide("kept");
    if (e.target.closest(".btn-decide.reject")) decide("out");
    const t = e.target.closest(".chip.toggle, .linked");
    if (t) {
      t.setAttribute("aria-pressed", t.getAttribute("aria-pressed") === "true" ? "false" : "true");
      if (t.id === "t-onion") { S.state = t.getAttribute("aria-pressed") === "true" ? "onion" : "default"; apply(); }
    }
    const radio = e.target.closest('[role="radio"]');
    if (radio && radio.parentElement) {
      $$('[role="radio"]', radio.parentElement).forEach((r) => r.setAttribute("aria-checked", String(r === radio)));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.sheet) { S.sheet = false; apply(); return; }
    if ((e.metaKey || e.ctrlKey) && /^[1-5]$/.test(e.key)) { e.preventDefault(); go(Object.keys(SCREENS)[+e.key - 1]); return; }
    if (S.screen === "timelapse" && !S.sheet && (e.key === "e" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e"))) { e.preventDefault(); S.sheet = true; S.sheetState = "sheet"; apply(); return; }
    if (S.screen === "review" && S.state !== "done") {
      if (e.key === "y" || e.key === "ArrowRight" || e.key === "Enter") decide("kept");
      if (e.key === "n" || e.key === "ArrowLeft" || e.key === "Backspace") decide("out");
      if (e.key === "u" || ((e.metaKey || e.ctrlKey) && e.key === "z")) undoDecision();
      if (e.key === " " && !e.repeat) { e.preventDefault(); S.state = "compare"; apply(); }
    }
    if (S.screen === "timelapse" && e.key === " " && !S.sheet) { e.preventDefault(); togglePlay(); }
    if (S.screen === "timelapse" && e.key === "o") { S.state = S.state === "onion" ? "default" : "onion"; $("#t-onion").setAttribute("aria-pressed", String(S.state === "onion")); apply(); }
  });
  document.addEventListener("keyup", (e) => {
    if (S.screen === "review" && e.key === " " && S.state === "compare") { S.state = "default"; apply(); }
  });
  window.addEventListener("resize", () => { if (S.screen !== "setup" && S.screen !== "review") drawRibbon(); });

  if (S.sheet) document.body.dataset.sheet = "open";
  if (params.get("sheet") === "open") S.sheet = true;
  apply();
})();
