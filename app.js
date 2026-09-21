// YT LOOPER — YouTube IFrame Player API で A-B ループと速度調整をするだけのアプリ

const $ = (s) => document.querySelector(s);
const STORAGE_KEY = "ytlooper:v1";
const DEFAULT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const state = {
  player: null,
  apiReady: false,
  ready: false,        // 動画がキューされてプレーヤーが操作可能
  videoId: null,
  title: "",
  duration: 0,
  a: 0,
  b: 0,
  loop: false,
  rate: 1,
  rates: DEFAULT_RATES,
  dragging: null,      // "a" | "b" | "seek"
  loupe: { start: 0, end: 4, frozen: false }, // ルーペ帯の表示範囲（秒）
  pendingId: null,     // API 準備前に読み込み要求された ID
  playing: false,      // 直前の状態が再生中か（BUFFERING では更新しない）
  zoom: 1,             // 動画の拡大率
  panX: 0, panY: 0,    // 拡大時の表示位置（px）
};

const el = {
  form: $("#loadForm"),
  input: $("#urlInput"),
  video: $(".video"),
  timeline: $("#timeline"),
  track: $("#track"),
  region: $("#region"),
  head: $("#head"),
  bubble: $("#bubble"),
  loupe: $("#loupe"),
  loupeTrack: $("#loupeTrack"),
  loupeTicks: $("#loupeTicks"),
  loupeRegion: $("#loupeRegion"),
  loupeHead: $("#loupeHead"),
  loupeBubble: $("#loupeBubble"),
  loupeA: $("#loupeA"),
  loupeB: $("#loupeB"),
  curTime: $("#curTime"),
  durTime: $("#durTime"),
  timeA: $("#timeA"),
  timeB: $("#timeB"),
  setA: $("#setA"),
  setB: $("#setB"),
  toA: $("#toA"),
  playPause: $("#playPause"),
  loopToggle: $("#loopToggle"),
  rateLabel: $("#rateLabel"),
  rateLabel2: $("#rateLabel2"),
  rateDown: $("#rateDown"),
  rateUp: $("#rateUp"),
  theaterBtn: $("#theaterBtn"),
  fullBtn: $("#fullBtn"),
  corner: $("#corner"),
  rates: $("#rates"),
  knob: $("#speedKnob"),
  knobBody: $("#knobBody"),
  knobTicks: $("#knobTicks"),
  loopLed: $("#loopLed"),
  saveLoop: $("#saveLoop"),
  savedList: $("#savedList"),
  recentWrap: $("#recentWrap"),
  recentList: $("#recentList"),
  toast: $("#toast"),
  searchPanel: $("#searchPanel"),
  searchList: $("#searchList"),
  searchStatus: $("#searchStatus"),
  searchSetup: $("#searchSetup"),
  searchClose: $("#searchClose"),
  keyForm: $("#keyForm"),
  apiKeyInput: $("#apiKeyInput"),
  apiKeyInput2: $("#apiKeyInput2"),
  apiKeyClear: $("#apiKeyClear"),
  shield: $("#shield"),
  shieldMsg: $("#shieldMsg"),
  hidePaused: $("#hidePaused"),
  countIn: $("#countIn"),
  showCaptions: $("#showCaptions"),
  app: $(".app"),
  screenBody: $("#screenBody"),
  zoomIn: $("#zoomIn"),
  zoomOut: $("#zoomOut"),
  zoomReset: $("#zoomReset"),
  zoomLabel: $("#zoomLabel"),
};

// ---------- ユーティリティ ----------

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 1800);
}

// URL・ID・共有テキストから動画IDと開始秒を取り出す
function parseVideo(text) {
  text = (text || "").trim();
  if (/^[\w-]{11}$/.test(text)) return { id: text, start: 0 };
  let url;
  try { url = new URL(text); } catch { return null; }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let id = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host.endsWith("youtube.com") || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[2];
    }
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = url.searchParams.get("t") || url.searchParams.get("start") || "0";
  const tm = String(t).match(/^(?:(\d+)h)?(?:(\d+)m)?(\d+)s?$/);
  const start = tm ? (+tm[1] || 0) * 3600 + (+tm[2] || 0) * 60 + (+tm[3] || 0) : 0;
  return { id, start };
}

// "1:23.4" "83.4" "1m23s" などを秒に変換。読めなければ null
function parseTime(text) {
  text = (text || "").trim().replace(/[：]/g, ":").replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!text) return null;
  let m;
  if ((m = text.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/))) return +m[1] * 60 + +m[2];
  if ((m = text.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/))) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  if ((m = text.match(/^(?:(\d+)m)?(\d+(?:\.\d+)?)s?$/))) return (+m[1] || 0) * 60 + +m[2];
  return null;
}

// ---------- 保存 ----------

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { videos: {}, recent: [] }; }
  catch { return { videos: {}, recent: [] }; }
}
function saveStore(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch {}
}
function videoEntry(store, id) {
  return (store.videos[id] ||= { title: "", loops: [] });
}
const HISTORY_MAX = 30;
function rememberRecent(id, title) {
  const store = loadStore();
  const v = videoEntry(store, id);
  v.title = title || v.title;
  v.lastOpened = Date.now();
  store.recent = [id, ...store.recent.filter((x) => x !== id)].slice(0, HISTORY_MAX);
  saveStore(store);
  renderRecent();
}

// ---------- 描画 ----------

function pct(sec) {
  return state.duration ? clamp(sec / state.duration, 0, 1) * 100 : 0;
}

function renderMarkers() {
  const a = pct(state.a), b = pct(state.b);
  // 長い動画で短い区間を切ると帯が消えるので、見た目の最小幅と
  // ハンドル同士の最小間隔を確保する（値そのものは変えない）
  // ミニマップ：A–B の帯だけを実位置に置く（つまみはルーペ帯側）
  const w = el.track.clientWidth || 1;
  const regionW = Math.max((b - a) / 100 * w, 3);
  el.region.style.left = a + "%";
  el.region.style.width = regionW + "px";
  el.timeA.disabled = el.timeB.disabled = !state.ready;
  if (document.activeElement !== el.timeA) el.timeA.value = state.ready ? fmt(state.a) : "";
  if (document.activeElement !== el.timeB) el.timeB.value = state.ready ? fmt(state.b) : "";
  // 保存済み区間のハイライト
  const loops = state.videoId ? videoEntry(loadStore(), state.videoId).loops : [];
  el.savedList.querySelectorAll("li").forEach((li, i) => {
    const lp = loops[i];
    li.classList.toggle("active", !!lp && Math.abs(lp.a - state.a) < 0.05 && Math.abs(lp.b - state.b) < 0.05);
  });
  el.durTime.textContent = fmt(state.duration);
  renderLoupe();
}

function renderHead(t) {
  el.head.style.left = pct(t) + "%";
  el.curTime.textContent = fmt(t);
  renderLoupeHead(t);
}

function renderLoop() {
  el.loopToggle.setAttribute("aria-pressed", String(state.loop));
  el.loopLed.classList.toggle("on", state.loop);
  el.timeline.classList.toggle("looping", state.loop);
}

// ノブの回転範囲（左端 -135° 〜 右端 +135°）
const KNOB_SWEEP = 270;
function rateAngle(i) {
  const n = state.rates.length;
  return n > 1 ? -KNOB_SWEEP / 2 + (KNOB_SWEEP / (n - 1)) * i : 0;
}

function renderRates() {
  el.rates.innerHTML = "";
  el.knobTicks.innerHTML = "";
  state.rates.forEach((r, i) => {
    const deg = rateAngle(i);
    const rad = (deg - 90) * Math.PI / 180; // 0° を上向きに
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = r + "×";
    b.style.setProperty("--x", (50 + 47 * Math.cos(rad)) + "%");
    b.style.setProperty("--y", (50 + 47 * Math.sin(rad)) + "%");
    b.setAttribute("aria-pressed", String(r === state.rate));
    b.addEventListener("click", () => setRate(r));
    el.rates.appendChild(b);
    // ノブ外周の目盛り
    const t = document.createElementNS("http://www.w3.org/2000/svg", "line");
    t.setAttribute("x1", 100 + 88 * Math.cos(rad)); t.setAttribute("y1", 100 + 88 * Math.sin(rad));
    t.setAttribute("x2", 100 + 98 * Math.cos(rad)); t.setAttribute("y2", 100 + 98 * Math.sin(rad));
    if (r === state.rate) t.classList.add("on");
    el.knobTicks.appendChild(t);
  });
  const idx = Math.max(0, state.rates.indexOf(state.rate));
  el.knobBody.style.setProperty("--angle", rateAngle(idx) + "deg");
  el.knob.setAttribute("aria-valuenow", state.rate);
  el.knob.setAttribute("aria-valuetext", state.rate + "×");
  el.rateLabel.textContent = state.rate.toFixed(2);
  el.rateLabel2.textContent = state.rate.toFixed(2);
  el.rateDown.disabled = idx <= 0;
  el.rateUp.disabled = idx >= state.rates.length - 1;
}

function renderSaved() {
  const store = loadStore();
  const loops = state.videoId ? videoEntry(store, state.videoId).loops : [];
  el.savedList.innerHTML = "";
  loops.forEach((lp, i) => {
    const li = document.createElement("li");
    if (Math.abs(lp.a - state.a) < 0.05 && Math.abs(lp.b - state.b) < 0.05) li.classList.add("active");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1).padStart(3, "0");
    const load = document.createElement("button");
    load.type = "button";
    load.className = "load";
    load.innerHTML = `<span class="name"></span><span class="range"></span><span class="rate"></span>`;
    load.querySelector(".name").textContent = lp.name;
    load.querySelector(".range").textContent = `${fmt(lp.a)} → ${fmt(lp.b)}`;
    load.querySelector(".rate").textContent = lp.rate ? lp.rate + "×" : "";
    load.addEventListener("click", () => {
      state.a = lp.a; state.b = lp.b;
      renderMarkers();
      if (lp.rate) setRate(lp.rate);
      seek(state.a);
      if (!state.loop) toggleLoop(true);
      play();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "×";
    del.setAttribute("aria-label", `${lp.name} を削除`);
    del.addEventListener("click", () => {
      const s = loadStore();
      videoEntry(s, state.videoId).loops.splice(i, 1);
      saveStore(s);
      renderSaved();
    });
    li.append(num, load, del);
    el.savedList.appendChild(li);
  });
}

function renderRecent() {
  const store = loadStore();
  const ids = store.recent;
  el.recentWrap.hidden = ids.length === 0;
  el.recentList.innerHTML = "";
  for (const id of ids) {
    const v = store.videos[id] || {};
    const li = document.createElement("li");
    if (id === state.videoId) li.classList.add("active");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "open";
    open.innerHTML = `<img alt="" loading="lazy"><span class="meta"><span class="title"></span><span class="sub"></span></span>`;
    open.querySelector("img").src = `https://i.ytimg.com/vi/${id}/default.jpg`;
    open.querySelector(".title").textContent = v.title || id;
    const n = v.loops?.length || 0;
    open.querySelector(".sub").textContent = (n ? `区間 ${n} 件` : "区間なし") + (v.lastOpened ? ` · ${fmtDate(v.lastOpened)}` : "");
    open.addEventListener("click", () => { if (id !== state.videoId) loadVideo(id, 0); });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "×";
    del.setAttribute("aria-label", "履歴から削除");
    del.addEventListener("click", () => {
      const st = loadStore();
      st.recent = st.recent.filter((x) => x !== id);
      // 保存した区間がない動画はデータも消す
      if (!(st.videos[id]?.loops?.length)) delete st.videos[id];
      saveStore(st);
      renderRecent();
    });
    li.append(open, del);
    el.recentList.appendChild(li);
  }
}

function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "今日";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "昨日";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------- ルーペ帯：A–B の前後を横幅いっぱいに拡大 ----------

const LOUPE_MIN_SPAN = 3; // 最低でも 3 秒分は見せる
let loupeTickKey = "";

function fitLoupe() {
  if (state.loupe.frozen || !state.ready) return;
  const len = Math.max(0, state.b - state.a);
  const pad = Math.max(0.5, len * 0.3);
  let start = state.a - pad, end = state.b + pad;
  if (end - start < LOUPE_MIN_SPAN) {
    const mid = (state.a + state.b) / 2;
    start = mid - LOUPE_MIN_SPAN / 2; end = mid + LOUPE_MIN_SPAN / 2;
  }
  const span = end - start;
  if (start < 0) { start = 0; end = Math.min(state.duration, span); }
  if (end > state.duration) { end = state.duration; start = Math.max(0, end - span); }
  state.loupe.start = start; state.loupe.end = end;
}

function loupePct(t) {
  const { start, end } = state.loupe;
  return end > start ? clamp((t - start) / (end - start), 0, 1) * 100 : 0;
}
function loupeTimeAt(clientX) {
  const r = el.loupeTrack.getBoundingClientRect();
  const { start, end } = state.loupe;
  return start + clamp((clientX - r.left) / r.width, 0, 1) * (end - start);
}

function renderLoupe() {
  if (!state.ready) { el.loupe.classList.add("empty"); return; }
  el.loupe.classList.remove("empty");
  fitLoupe();
  const a = loupePct(state.a), b = loupePct(state.b);
  el.loupeRegion.style.left = a + "%";
  el.loupeRegion.style.width = Math.max(0, b - a) + "%";
  el.loupeA.style.left = a + "%";
  el.loupeB.style.left = b + "%";
  el.loupeA.setAttribute("aria-valuetext", fmt(state.a));
  el.loupeB.setAttribute("aria-valuetext", fmt(state.b));
  renderLoupeTicks();
}

// 目盛り：表示範囲の長さで刻みを変える
function renderLoupeTicks() {
  const { start, end } = state.loupe;
  const span = end - start;
  const [major, minor] = span <= 4 ? [0.5, 0.1] : span <= 10 ? [1, 0.5] : span <= 30 ? [5, 1] : [10, 5];
  const key = `${start.toFixed(2)}|${end.toFixed(2)}|${el.loupeTrack.clientWidth}`;
  if (key === loupeTickKey) return;
  loupeTickKey = key;
  el.loupeTicks.innerHTML = "";
  const first = Math.ceil(start / minor) * minor;
  const decimals = major < 1 ? 1 : 0;
  for (let t = first; t <= end + 1e-6; t = Math.round((t + minor) * 1000) / 1000) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const el2 = document.createElement("span");
    el2.className = "tick" + (isMajor ? " major" : "");
    el2.style.left = loupePct(t) + "%";
    if (isMajor) {
      const m = Math.floor(t / 60), s = t - m * 60;
      el2.dataset.label = `${m}:${s < 10 ? "0" : ""}${s.toFixed(decimals)}`;
    }
    el.loupeTicks.appendChild(el2);
  }
}

function renderLoupeHead(t) {
  const { start, end } = state.loupe;
  const inside = t >= start && t <= end;
  el.loupeHead.style.display = inside ? "" : "none";
  if (inside) el.loupeHead.style.left = loupePct(t) + "%";
}

function showLoupeBubble(which, t) {
  el.loupeBubble.textContent = fmt(t);
  el.loupeBubble.style.left = loupePct(t) + "%";
  el.loupeBubble.className = "tl-bubble show" + (which === "a" || which === "b" ? " " + which : "");
}

// ドラッグ：ハンドルは A/B を動かす、空いた所は頭出し。ドラッグ中は範囲を固定する
{
  let drag = null; // { which, offset }
  el.loupeTrack.addEventListener("pointerdown", (e) => {
    if (!state.ready) return;
    e.preventDefault();
    const handle = e.target.closest(".loupe-handle");
    const t = loupeTimeAt(e.clientX);
    state.loupe.frozen = true;
    if (handle) {
      drag = { which: handle.dataset.marker, offset: state[handle.dataset.marker] - t };
      showLoupeBubble(drag.which, state[drag.which]);
    } else {
      drag = { which: "seek", offset: 0 };
      state.dragging = "seek"; // メイン側の tick で再生位置を上書きしないように
      renderHead(t);
      showLoupeBubble("seek", t);
    }
    try { el.loupeTrack.setPointerCapture(e.pointerId); } catch {}
  });
  el.loupeTrack.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const t = loupeTimeAt(e.clientX);
    if (drag.which === "seek") { renderHead(t); showLoupeBubble("seek", t); }
    else { setMarker(drag.which, t + drag.offset); showLoupeBubble(drag.which, state[drag.which]); }
  });
  const end = (e) => {
    if (!drag) return;
    const t = loupeTimeAt(e.clientX);
    if (drag.which === "seek") { state.dragging = null; seek(t); }
    else seek(state[drag.which]);
    drag = null;
    state.loupe.frozen = false;
    el.loupeBubble.classList.remove("show");
    renderMarkers();
  };
  el.loupeTrack.addEventListener("pointerup", end);
  el.loupeTrack.addEventListener("pointercancel", (e) => { drag = null; state.dragging = null; state.loupe.frozen = false; el.loupeBubble.classList.remove("show"); });

  // キーボードで 0.1 秒（Shift で 1 秒）
  for (const hd of [el.loupeA, el.loupeB]) {
    hd.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : 0.1;
      if (e.key === "ArrowLeft") { setMarker(hd.dataset.marker, state[hd.dataset.marker] - step); e.preventDefault(); }
      if (e.key === "ArrowRight") { setMarker(hd.dataset.marker, state[hd.dataset.marker] + step); e.preventDefault(); }
    });
  }
}
window.addEventListener("resize", () => { loupeTickKey = ""; renderLoupe(); });
for (const s of [el.track, el.loupeTrack, el.shield, el.knob]) s.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- 表示サイズと拡大 ----------

// デスクトップでは SCREEN の残り高さに 16:9 で収める（iPhone は幅いっぱい）
const desktopMQ = window.matchMedia("(min-width: 900px)");
function isTheater() { return el.app.dataset.theater === "1"; }
const phoneMQ = window.matchMedia("(max-width: 520px)"); // スマホ縦持ち（CSS のブロックと同じ幅）
function fitVideo() {
  // スマホ縦持ちはシアターモードでも幅いっぱい固定（CSS 任せ）
  if ((!desktopMQ.matches && !isTheater()) || phoneMQ.matches) {
    el.video.style.width = "";
    el.video.style.height = "";
    return;
  }
  const cw = el.screenBody.clientWidth, ch = el.screenBody.clientHeight;
  if (!cw || !ch) return;
  const w = Math.floor(Math.min(cw, ch * 16 / 9));
  el.video.style.width = w + "px";
  el.video.style.height = Math.floor(w * 9 / 16) + "px";
  renderZoom();
}
new ResizeObserver(() => fitVideo()).observe(el.screenBody);
desktopMQ.addEventListener("change", fitVideo);
phoneMQ.addEventListener("change", fitVideo);

const ZOOM_MIN = 1, ZOOM_MAX = 4, ZOOM_STEP = 0.25;

// 表示サイズは「操作部コンパクト」固定（拡大したいときはシアターモード・全画面）
function setSize(size) {
  el.app.dataset.size = size;
  requestAnimationFrame(() => { fitVideo(); renderMarkers(); renderZoom(); });
}

// シアターモード：動画を横幅いっぱいに、LOOPER だけ薄く残す
function setTheater(on) {
  el.app.dataset.theater = on ? "1" : "";
  el.theaterBtn.setAttribute("aria-pressed", String(on));
  const store = loadStore();
  store.settings = { ...(store.settings || {}), theater: on };
  saveStore(store);
  requestAnimationFrame(() => { fitVideo(); renderMarkers(); renderZoom(); });
}

// 拡大した動画がコンテナの外へ出ないように位置を制限する
function clampPan() {
  const w = el.video.clientWidth, h = el.video.clientHeight;
  const maxX = (state.zoom - 1) * w / 2, maxY = (state.zoom - 1) * h / 2;
  state.panX = clamp(state.panX, -maxX, maxX);
  state.panY = clamp(state.panY, -maxY, maxY);
}

// 上下の黒帯の高さ。YouTube の表示はプレーヤーの高さに応じて大きくなるので比率＋下限で決める
function renderBars() {
  const h = el.video.clientHeight;
  const bar = Math.max(72, Math.round(h * 0.16));
  el.video.style.setProperty("--bar", bar + "px");
}

function renderZoom() {
  renderBars();
  clampPan();
  el.video.style.setProperty("--zoom", state.zoom);
  el.video.style.setProperty("--pan-x", state.panX + "px");
  el.video.style.setProperty("--pan-y", state.panY + "px");
  el.video.classList.toggle("zoomed", state.zoom > 1);
  el.zoomLabel.textContent = state.zoom.toFixed(2);
  el.zoomOut.disabled = state.zoom <= ZOOM_MIN;
  el.zoomIn.disabled = state.zoom >= ZOOM_MAX;
}

function setZoom(z, save = true) {
  z = clamp(Math.round(z / ZOOM_STEP) * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
  const first = state.zoom === 1 && z > 1;
  state.zoom = z;
  if (z === 1) { state.panX = 0; state.panY = 0; }
  renderZoom();
  if (first) toast("ドラッグで見たい位置に動かせます");
  else if (isTheater()) toast(el.zoomLabel.textContent + "×");
  if (save) saveView();
}

// 動画ごとに拡大率と位置を覚える
function saveView() {
  if (!state.videoId) return;
  const store = loadStore();
  videoEntry(store, state.videoId).view = { zoom: state.zoom, panX: state.panX, panY: state.panY };
  saveStore(store);
}
function restoreView(id) {
  const v = loadStore().videos[id]?.view;
  state.zoom = v?.zoom || 1;
  state.panX = v?.panX || 0;
  state.panY = v?.panY || 0;
  renderZoom();
}

// ---------- プレーヤー制御 ----------

window.onYouTubeIframeAPIReady = () => {
  state.apiReady = true;
  document.getElementById("diag")?.remove();
  if (state.pendingId) {
    const { id, start } = state.pendingId;
    state.pendingId = null;
    loadVideo(id, start);
  }
};

function createPlayer(id, start) {
  state.player = new YT.Player("player", {
    videoId: id,
    playerVars: {
      playsinline: 1,
      controls: 0,
      rel: 0,
      modestbranding: 1,
      cc_load_policy: 3, // 字幕を出さない（非公式だが広く使われている値）
      start: Math.floor(start || 0),
      origin: location.origin.startsWith("http") ? location.origin : undefined,
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onStateChange,
      onPlaybackRateChange: (e) => {
        state.rate = e.data;
        renderRates();
      },
      onError: (e) => showError(e.data),
    },
  });
}

function loadVideo(id, start = 0) {
  if (!state.apiReady) { state.pendingId = { id, start }; return; }
  state.videoId = id;
  state.ready = false;
  state.title = "";
  state.duration = 0;
  state.a = 0; state.b = 0;
  state.loupe.frozen = false; loupeTickKey = "";
  el.video.classList.add("has-video");
  restoreView(id);
  renderShield(YT.PlayerState.CUED);
  history.replaceState(null, "", `?v=${id}`);
  if (!state.player) createPlayer(id, start);
  else state.player.cueVideoById({ videoId: id, startSeconds: start });
  renderMarkers();
  renderSaved();
  renderRecent();
}

function onPlayerReady() {
  refreshMeta();
  applyCaptions();
}

// 字幕モジュールの読み込み/解除で字幕の表示を切り替える
function applyCaptions() {
  const p = state.player;
  if (!p?.loadModule) return;
  if (el.showCaptions.checked) { p.loadModule("captions"); p.loadModule("cc"); }
  else { p.unloadModule("captions"); p.unloadModule("cc"); }
}

function refreshMeta() {
  const p = state.player;
  if (!p || !p.getDuration) return;
  const d = p.getDuration();
  if (d > 0 && !state.ready) {
    state.ready = true;
    state.duration = d;
    state.a = 0;
    state.b = d;
    state.rates = p.getAvailablePlaybackRates?.() || DEFAULT_RATES;
    state.rate = p.getPlaybackRate?.() || 1;
    renderRates();
    renderMarkers();
    // 保存済みの区間があれば最初のものを復元
    const loops = videoEntry(loadStore(), state.videoId).loops;
    if (loops.length) {
      state.a = loops[0].a; state.b = loops[0].b;
      if (loops[0].rate) setRate(loops[0].rate);
      renderMarkers();
    }
  }
  const data = p.getVideoData?.();
  if (data?.title && data.title !== state.title) {
    state.title = data.title;
    document.title = `${state.title} — YT LOOPER`;
    rememberRecent(state.videoId, state.title);
  }
}

// 読み込み失敗を動画の場所にそのまま表示する
const ERRORS = {
  2: "URL が正しくないようです。YouTube の動画ページの URL を貼り付けてください。",
  5: "このブラウザではプレーヤーを再生できませんでした。Safari か Chrome の最新版で試してください。",
  100: "動画が見つかりません。削除された、または非公開の動画です。",
  101: "この動画は投稿者が埋め込み再生を許可していません。別の動画で試してください。",
  150: "この動画は投稿者が埋め込み再生を許可していません。別の動画で試してください。",
  153: "プレーヤーの設定エラーです。ページを再読み込みしてもう一度試してください。",
};
function showError(code) {
  showDiag(`YouTube エラーコード ${code}: ${ERRORS[code] || "YouTube 側でエラーが起きました。"}`);
  el.shield.classList.remove("cued", "cover");
  el.shield.classList.add("error");
  el.shield.style.backgroundImage = "";
  el.shieldMsg.innerHTML = `<span class="big">読み込めませんでした</span><span class="sub"></span><span class="code"></span>`;
  el.shieldMsg.querySelector(".sub").textContent = ERRORS[code] || "YouTube 側でエラーが起きました。";
  el.shieldMsg.querySelector(".code").textContent = `エラーコード ${code}`;
}

// YouTube 側の表示（タイトル・共有・その他の動画）を覆うレイヤー
let liftTimer = null;
const LIFT_DELAY = 700; // 再生開始直後に YouTube が出す再生アイコン等が消えるまで覆っておく

function renderShield(playerState) {
  const S = YT.PlayerState;
  if (playerState === S.BUFFERING) return; // シーク中は直前の見た目を保つ
  clearTimeout(liftTimer);
  if (preroll) {
    if (playerState === S.PLAYING && !preroll.until) {
      preroll.until = performance.now() + PREROLL_MS;
      // 目的位置へ先に飛んでおく（音は消えているので見えない・聞こえない）
      if (Math.abs(currentTime() - preroll.target) > 0.05) state.player.seekTo(preroll.target, true);
    }
    return; // カウントイン中の見た目は tick 側で管理する
  }
  if (playerState === S.PLAYING) {
    const covered = el.shield.classList.contains("cover") || el.shield.classList.contains("cued");
    const lift = () => {
      el.shield.classList.remove("cover", "cued", "error");
      el.shield.style.backgroundImage = "";
      el.shieldMsg.innerHTML = "";
    };
    if (covered && el.hidePaused.checked) liftTimer = setTimeout(lift, LIFT_DELAY);
    else lift();
    return;
  }
  el.shield.classList.remove("cover", "cued", "error");
  el.shield.style.backgroundImage = "";
  if (playerState === S.PAUSED && el.hidePaused.checked) {
    el.shield.classList.add("cover");
    el.shieldMsg.innerHTML = `<span class="big"></span><span class="sub">停止中 — タップで再生</span>`;
    el.shieldMsg.querySelector(".big").textContent = fmt(currentTime());
  } else if (playerState === S.PAUSED) {
    el.shieldMsg.innerHTML = "";
  } else {
    // 読み込み直後・終了後：サムネイルと再生ボタン
    el.shield.classList.add("cued");
    if (state.videoId) el.shield.style.backgroundImage = `url(https://i.ytimg.com/vi/${state.videoId}/hqdefault.jpg)`;
    el.shieldMsg.innerHTML = `<span class="glyph"></span><span class="sub">タップで再生</span>`;
  }
}

function onStateChange(e) {
  const playing = e.data === YT.PlayerState.PLAYING;
  if (e.data !== YT.PlayerState.BUFFERING) state.playing = playing;
  el.playPause.querySelector(".foot-label").textContent = playing ? "Stop" : "Play";
  el.playPause.setAttribute("aria-pressed", String(playing));
  renderShield(e.data);
  refreshMeta();
  if (playing && !el.showCaptions.checked) applyCaptions(); // 動画によっては再生開始時に字幕が復活するため
  if (e.data === YT.PlayerState.ENDED && state.loop) {
    seek(state.a);
    play();
  }
}

function currentTime() {
  return state.player?.getCurrentTime?.() || 0;
}

function seek(t) {
  if (!state.ready) return;
  if (preroll) { cancelPreroll(); renderShield(YT.PlayerState.PLAYING); } // 手動で動かしたらカウントインは終了
  t = clamp(t, 0, state.duration);
  const st = state.player.getPlayerState();
  if (st === YT.PlayerState.CUED || st === YT.PlayerState.UNSTARTED) {
    // 未再生の動画に seekTo すると再生が始まってしまうので、位置を指定して再キューする
    state.player.cueVideoById({ videoId: state.videoId, startSeconds: t });
  } else {
    state.player.seekTo(t, true);
  }
  renderHead(t);
}

// 再生開始直後の約3秒、YouTube はタイトルや「その他の動画」を表示する。
// その間は音を消したまま覆い、カウントダウンを見せておく。時間が来たら
// 目的位置へ戻して音を出す（再生中のシークでは YouTube の表示は出ない）。
const PREROLL_MS = 3400;
let preroll = null;        // { target, until }

function play() {
  if (!state.ready) return;
  const p = state.player;
  // BUFFERING はシーク直後にも出るので、直前まで再生中だったかで判断する
  if (!el.countIn.checked || state.playing || preroll) { p.playVideo(); return; }

  let target = currentTime();
  if (state.loop && (target < state.a || target >= state.b)) target = state.a;
  // カウントは実際に再生が始まった（PLAYING になった）時点から数える
  preroll = { target, until: null, startedAt: performance.now() };
  p.mute();
  showCountIn();
  p.playVideo(); // 位置合わせは再生が始まってから（cued 状態で seek すると再生が止まる）
}

function showCountIn() {
  el.shield.classList.remove("cued", "error");
  el.shield.classList.add("cover");
  el.shield.style.backgroundImage = "";
  el.shieldMsg.innerHTML = `<span class="count"></span><span class="sub">まもなく再生</span>`;
  updateCountIn();
}
function updateCountIn() {
  if (!preroll) return;
  const n = Math.min(3, preroll.until ? Math.ceil((preroll.until - performance.now()) / 1000) : 3);
  const c = el.shieldMsg.querySelector(".count");
  if (c) c.textContent = n > 0 ? String(n) : "";
}
function finishPreroll() {
  if (!preroll) return;
  const { target } = preroll;
  preroll = null;
  state.player.seekTo(target, true);
  state.player.unMute();
  el.shield.classList.remove("cover", "cued", "error");
  el.shield.style.backgroundImage = "";
  el.shieldMsg.innerHTML = "";
  renderHead(target);
}
function cancelPreroll() {
  if (!preroll) return;
  preroll = null;
  state.player.unMute();
}
function pause() {
  if (!state.ready) return;
  cancelPreroll();
  renderShield(YT.PlayerState.PAUSED); // イベントを待たずに先に覆う
  state.player.pauseVideo();
}
function togglePlay() {
  if (!state.ready) return toast("先に動画を読み込んでください");
  const st = state.player.getPlayerState();
  (st === YT.PlayerState.PLAYING || (st === YT.PlayerState.BUFFERING && state.playing)) ? pause() : play();
}

function setRate(r) {
  if (!state.ready) return;
  state.rate = r;
  state.player.setPlaybackRate(r);
  renderRates();
}

function stepRate(dir) {
  const i = state.rates.indexOf(state.rate);
  const next = state.rates[clamp(i + dir, 0, state.rates.length - 1)];
  if (next !== undefined) { setRate(next); toast(next + "×"); }
}

// A/B を置く。相手側を飛び越えたら「区間を新しく作り直している」とみなして、相手側を端まで開く
// （ドラッグ中の微調整では 0.2 秒の間隔だけ守る）
function setMarker(which, t, { open = false } = {}) {
  if (!state.ready) return toast("先に動画を読み込んでください");
  t = clamp(t, 0, state.duration);
  if (which === "a") {
    state.a = t;
    if (state.b < state.a + 0.2) state.b = open ? state.duration : clamp(state.a + 0.2, 0, state.duration);
  } else {
    state.b = t;
    if (state.a > state.b - 0.2) state.a = open ? 0 : clamp(state.b - 0.2, 0, state.duration);
  }
  renderMarkers();
}

function clearMarkers() {
  if (!state.ready) return;
  state.a = 0; state.b = state.duration;
  state.loupe.frozen = false;
  renderMarkers();
  toast("A–B を解除しました");
}

function toggleLoop(force) {
  if (!state.ready) return toast("先に動画を読み込んでください");
  state.loop = force ?? !state.loop;
  renderLoop();
  if (state.loop) {
    const t = currentTime();
    if (t < state.a || t > state.b) seek(state.a);
  }
}

// 毎フレーム、B点を越えたら A点へ戻す
function tick() {
  if (state.ready && !state.dragging) {
    const t = currentTime();
    renderHead(t);
    if (preroll) {
      updateCountIn();
      if (preroll.until && performance.now() >= preroll.until) finishPreroll();
      else if (!preroll.until && performance.now() - preroll.startedAt > 8000) finishPreroll(); // 再生が始まらない
    }
    if (state.loop && state.b > state.a && t >= state.b - 0.03) {
      seek(state.a);
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- イベント ----------

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = parseVideo(el.input.value);
  if (!v) {
    const q = el.input.value.trim();
    if (q) searchVideos(q);
    return;
  }
  closeSearch();
  if (!state.apiReady) toast("YouTube のプレーヤーを準備中です。準備できたら自動で読み込みます");
  loadVideo(v.id, v.start);
  el.input.blur();
});
// 貼り付けたらすぐ読み込む
el.input.addEventListener("paste", () => {
  setTimeout(() => {
    if (!parseVideo(el.input.value)) return;
    if (el.form.requestSubmit) el.form.requestSubmit();
    else el.form.dispatchEvent(new Event("submit", { cancelable: true }));
  }, 0);
});

el.setA.addEventListener("click", () => setMarker("a", currentTime(), { open: true }));
el.setB.addEventListener("click", () => setMarker("b", currentTime(), { open: true }));
$("#clearAB").addEventListener("click", clearMarkers);
document.querySelectorAll(".nudge").forEach((wrap) => {
  const which = wrap.dataset.marker;
  wrap.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => setMarker(which, state[which] + parseFloat(b.dataset.d)));
  });
});

// 動画上のタップは再生/停止。拡大中はドラッグで位置を動かす。2本指のピンチで拡大縮小
{
  let pan = null;
  const touches = new Map(); // pointerId → {x, y}
  let pinch = null;          // { dist, zoom }
  const dist = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };

  el.shield.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { el.shield.setPointerCapture(e.pointerId); } catch {}
    if (touches.size === 2) {
      pan = null;
      pinch = { dist: dist(), zoom: state.zoom };
      el.shield.dataset.skipClick = "1";
      return;
    }
    if (state.zoom <= 1) return;
    pan = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY, moved: false };
  });
  el.shield.addEventListener("pointermove", (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      state.zoom = clamp(pinch.zoom * dist() / pinch.dist, ZOOM_MIN, ZOOM_MAX);
      if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
      renderZoom();
      return;
    }
    if (!pan) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (Math.hypot(dx, dy) > 4) { pan.moved = true; el.shield.classList.add("panning"); }
    if (pan.moved) {
      state.panX = pan.px + dx;
      state.panY = pan.py + dy;
      renderZoom();
    }
  });
  const endPan = (e) => {
    touches.delete(e.pointerId);
    if (pinch) {
      if (touches.size < 2) {
        pinch = null;
        state.zoom = Math.round(state.zoom * 20) / 20; // 0.05 刻みに丸める
        renderZoom();
        saveView();
        toast(el.zoomLabel.textContent + "×");
      }
      return;
    }
    if (!pan) return;
    el.shield.classList.remove("panning");
    if (pan.moved) saveView();
    const moved = pan.moved;
    pan = null;
    // ドラッグ直後の click は再生切り替えにしない
    if (moved) el.shield.dataset.skipClick = "1";
  };
  el.shield.addEventListener("pointerup", endPan);
  el.shield.addEventListener("pointercancel", endPan);
  el.shield.addEventListener("click", () => {
    if (el.shield.dataset.skipClick) { delete el.shield.dataset.skipClick; return; }
    togglePlay();
  });
  // Mac：トラックパッドのピンチ / Ctrl+ホイールで拡大
  el.shield.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  }, { passive: false });
}
el.theaterBtn.addEventListener("click", () => setTheater(!isTheater()));

// 全画面：ブラウザの全画面 + シアターモード。iPhone の Safari は非対応なのでボタンを隠す
const fullscreenOK = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
el.fullBtn.hidden = !fullscreenOK;
function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function toggleFullscreen() {
  if (!fullscreenOK) return;
  if (isFullscreen()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const root = document.documentElement;
    (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    if (!isTheater()) setTheater(true);
  }
}
el.fullBtn.addEventListener("click", toggleFullscreen);
for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(ev, () => {
    el.fullBtn.setAttribute("aria-pressed", String(isFullscreen()));
    requestAnimationFrame(fitVideo);
  });
}

// 動画上のボタン：マウスを動かした／タップしたときだけ 2.5 秒表示
{
  let uiTimer = null;
  const showUI = () => {
    el.video.classList.add("show-ui");
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => el.video.classList.remove("show-ui"), 2500);
  };
  el.video.addEventListener("pointermove", showUI);
  el.video.addEventListener("pointerdown", showUI);
  el.video.addEventListener("pointerleave", () => {
    clearTimeout(uiTimer);
    el.video.classList.remove("show-ui");
  });
}
el.rateDown.addEventListener("click", () => stepRate(-1));
el.rateUp.addEventListener("click", () => stepRate(1));
el.zoomIn.addEventListener("click", () => setZoom(state.zoom + ZOOM_STEP));
el.zoomOut.addEventListener("click", () => setZoom(state.zoom - ZOOM_STEP));
el.zoomReset.addEventListener("click", () => setZoom(1));
window.addEventListener("resize", renderZoom);
el.hidePaused.addEventListener("change", () => {
  const store = loadStore();
  store.settings = { ...(store.settings || {}), hidePaused: el.hidePaused.checked };
  saveStore(store);
  if (state.ready) renderShield(state.player.getPlayerState());
});

el.countIn.addEventListener("change", () => {
  const store = loadStore();
  store.settings = { ...(store.settings || {}), countIn: el.countIn.checked };
  saveStore(store);
});
el.showCaptions.addEventListener("change", () => {
  const store = loadStore();
  store.settings = { ...(store.settings || {}), showCaptions: el.showCaptions.checked };
  saveStore(store);
  applyCaptions();
});

// 巻き戻し・早送りボタン：⏪ 30 … 1 ／ 1 … 30 ⏩
{
  const SEEK_STEPS = [30, 10, 5, 1];
  const icon = (dir) => `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">${
    dir < 0
      ? '<path d="M11 6v12L2 12zM22 6v12l-9-6z"/>'
      : '<path d="M13 6v12l9-6zM2 6v12l9-6z"/>'
  }</svg>`;
  const make = (sec, dir) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.seek = dir * sec;
    b.setAttribute("aria-label", `${sec}秒${dir < 0 ? "戻る" : "進む"}`);
    b.innerHTML = dir < 0 ? `${icon(dir)}<span>${sec}s</span>` : `<span>${sec}s</span>${icon(dir)}`;
    b.addEventListener("click", () => {
      if (!state.ready) return toast("先に動画を読み込んでください");
      seek(currentTime() + dir * sec);
    });
    return b;
  };
  SEEK_STEPS.forEach((sec) => $("#seekBack").appendChild(make(sec, -1)));
  [...SEEK_STEPS].reverse().forEach((sec) => $("#seekFwd").appendChild(make(sec, 1)));
}

el.toA.addEventListener("click", () => seek(state.a));
el.playPause.addEventListener("click", togglePlay);
el.loopToggle.addEventListener("click", () => toggleLoop());

el.saveLoop.addEventListener("click", () => {
  if (!state.ready) return toast("先に動画を読み込んでください");
  const store = loadStore();
  const entry = videoEntry(store, state.videoId);
  const name = prompt("この区間の名前", `区間 ${entry.loops.length + 1}`);
  if (name === null) return;
  entry.loops.push({ name: name.trim() || `区間 ${entry.loops.length + 1}`, a: state.a, b: state.b, rate: state.rate });
  entry.title = state.title || entry.title;
  saveStore(store);
  renderSaved();
  toast("保存しました");
});

// タイムライン：ハンドルのドラッグとタップでのシーク
function timeAt(clientX) {
  const r = el.track.getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * state.duration;
}
function showBubble(which, t) {
  el.bubble.textContent = fmt(t);
  el.bubble.style.left = pct(t) + "%";
  el.bubble.className = "tl-bubble show" + (which === "a" || which === "b" ? " " + which : "");
}
function hideBubble() { el.bubble.classList.remove("show"); }

// ミニマップ：クリック／ドラッグで頭出しだけ
el.track.addEventListener("pointerdown", (e) => {
  if (!state.ready) return;
  e.preventDefault();
  state.dragging = "seek";
  try { el.track.setPointerCapture(e.pointerId); } catch {}
  const t = timeAt(e.clientX);
  renderHead(t); showBubble("seek", t);
});
el.track.addEventListener("pointermove", (e) => {
  if (!state.dragging) return;
  const t = timeAt(e.clientX);
  renderHead(t); showBubble("seek", t);
});
function endDrag(e) {
  if (!state.dragging) return;
  seek(timeAt(e.clientX));
  state.dragging = null;
  hideBubble();
}
el.track.addEventListener("pointerup", endDrag);
el.track.addEventListener("pointercancel", () => { state.dragging = null; hideBubble(); });

// 時刻を直接入力して A点 / B点 を決める
for (const [input, which] of [[el.timeA, "a"], [el.timeB, "b"]]) {
  input.addEventListener("focus", () => input.select());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = fmt(state[which]); input.blur(); }
    e.stopPropagation(); // A/B/Space などのショートカットを発火させない
  });
  input.addEventListener("blur", () => {
    const t = parseTime(input.value);
    if (t === null) { toast("「1:23.4」のように 分:秒 で入力してください"); input.value = fmt(state[which]); return; }
    if (t > state.duration) { toast("動画の長さを超えています"); input.value = fmt(state[which]); return; }
    setMarker(which, t, { open: true });
    seek(state[which]);
  });
}

// スピードノブ：上下ドラッグ、ホイール、矢印キー
{
  let drag = null;
  el.knob.addEventListener("pointerdown", (e) => {
    drag = { y: e.clientY, idx: Math.max(0, state.rates.indexOf(state.rate)) };
    try { el.knob.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  el.knob.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const steps = Math.round((drag.y - e.clientY) / 28); // 28px で 1 段
    const idx = clamp(drag.idx + steps, 0, state.rates.length - 1);
    if (state.rates[idx] !== state.rate) setRate(state.rates[idx]);
  });
  const end = () => { drag = null; };
  el.knob.addEventListener("pointerup", end);
  el.knob.addEventListener("pointercancel", end);
  el.knob.addEventListener("wheel", (e) => {
    e.preventDefault();
    stepRate(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  el.knob.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); stepRate(1); }
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); stepRate(-1); }
  });
}

// キーボードショートカット
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((document.activeElement?.classList.contains("loupe-handle") || document.activeElement === el.knob) && e.key.startsWith("Arrow")) return;
  const key = e.code === "Space" ? " " : e.key;
  switch (key) {
    case " ": e.preventDefault(); togglePlay(); break;
    case "a": case "A": setMarker("a", currentTime(), { open: true }); toast("A点 " + fmt(state.a)); break;
    case "b": case "B": setMarker("b", currentTime(), { open: true }); toast("B点 " + fmt(state.b)); break;
    case "c": case "C": clearMarkers(); break;
    case "l": case "L": toggleLoop(); break;
    case "Enter": seek(state.a); break;
    case "ArrowLeft": e.preventDefault(); seek(currentTime() - (e.shiftKey ? 5 : 1)); break;
    case "ArrowRight": e.preventDefault(); seek(currentTime() + (e.shiftKey ? 5 : 1)); break;
    case "[": stepRate(-1); break;
    case "]": stepRate(1); break;
    case "t": case "T": setTheater(!isTheater()); break;
    case "f": case "F": toggleFullscreen(); break;
    case "+": case "=": case ";": setZoom(state.zoom + ZOOM_STEP); toast(el.zoomLabel.textContent + "×"); break;
    case "-": case "_": setZoom(state.zoom - ZOOM_STEP); toast(el.zoomLabel.textContent + "×"); break;
    case "Escape": if (isTheater()) setTheater(false); break;
  }
});
// ボタンにフォーカスが残っていても Space は常に再生/停止だけにする
// （ボタン自身の Space 押下による click を止める）
document.addEventListener("keyup", (e) => {
  if ((e.key === " " || e.code === "Space") && document.activeElement?.tagName === "BUTTON") e.preventDefault();
});

window.addEventListener("resize", renderMarkers);

// ---------- YouTube 検索（Data API v3、キーはブラウザ内に保存） ----------

function getApiKey() { return (loadStore().settings?.ytApiKey || "").trim(); }
function setApiKey(key) {
  const store = loadStore();
  store.settings = { ...(store.settings || {}), ytApiKey: key.trim() };
  saveStore(store);
  el.apiKeyInput.value = key.trim();
  el.apiKeyInput2.value = key.trim();
}

function openSearch() { el.searchPanel.hidden = false; }
function closeSearch() { el.searchPanel.hidden = true; }

function fmtIsoDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return "";
  const h = +m[1] || 0, mi = +m[2] || 0, s = +m[3] || 0;
  return h ? `${h}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${mi}:${String(s).padStart(2, "0")}`;
}

async function searchVideos(q) {
  openSearch();
  el.searchList.innerHTML = "";
  const key = getApiKey();
  if (!key) {
    el.searchSetup.hidden = false;
    el.searchStatus.textContent = "API キーが未設定です";
    el.searchSetup.dataset.pendingQuery = q;
    return;
  }
  el.searchSetup.hidden = true;
  el.searchStatus.textContent = `「${q}」を検索中…`;
  try {
    const sp = new URLSearchParams({ part: "snippet", type: "video", videoEmbeddable: "true", maxResults: "12", q, key });
    const r = await fetch("https://www.googleapis.com/youtube/v3/search?" + sp);
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error?.message || r.statusText), { code: r.status, reason: data.error?.errors?.[0]?.reason });
    const items = (data.items || []).filter((it) => it.id?.videoId);
    // 長さを取る（1 回で全件）
    let durations = {};
    if (items.length) {
      const vp = new URLSearchParams({ part: "contentDetails", id: items.map((it) => it.id.videoId).join(","), key });
      const vr = await fetch("https://www.googleapis.com/youtube/v3/videos?" + vp);
      const vd = await vr.json();
      for (const v of vd.items || []) durations[v.id] = fmtIsoDuration(v.contentDetails?.duration);
    }
    renderSearch(items, durations);
    el.searchStatus.textContent = items.length ? `「${q}」の結果 ${items.length} 件` : `「${q}」に一致する動画はありません`;
  } catch (err) {
    const reason = err.reason || "";
    let msg = "検索できませんでした: " + err.message;
    if (reason === "quotaExceeded") msg = "本日の検索回数の上限に達しました（Google の無料枠）。明日また使えます。";
    else if (err.code === 400 || err.code === 403) msg = "API キーが無効か、YouTube Data API v3 が有効になっていません。設定を確認してください。";
    el.searchStatus.textContent = msg;
    if (err.code === 400 || err.code === 403) el.searchSetup.hidden = false;
  }
}

function renderSearch(items, durations) {
  el.searchList.innerHTML = "";
  for (const it of items) {
    const id = it.id.videoId;
    const sn = it.snippet || {};
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "open";
    b.innerHTML = `<span class="thumb"><img alt="" loading="lazy"><span class="dur"></span></span><span class="meta"><span class="title"></span><span class="sub"></span></span>`;
    b.querySelector("img").src = sn.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    b.querySelector(".dur").textContent = durations[id] || "";
    b.querySelector(".title").textContent = decodeEntities(sn.title || id);
    b.querySelector(".sub").textContent = decodeEntities(sn.channelTitle || "");
    b.addEventListener("click", () => {
      closeSearch();
      el.input.value = "";
      loadVideo(id, 0);
    });
    li.appendChild(b);
    el.searchList.appendChild(li);
  }
}

function decodeEntities(s) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

el.searchClose.addEventListener("click", closeSearch);
el.keyForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const key = el.apiKeyInput.value.trim();
  if (!key) return toast("キーを入力してください");
  setApiKey(key);
  toast("保存しました");
  const q = el.searchSetup.dataset.pendingQuery;
  if (q) searchVideos(q);
});
el.apiKeyInput2.addEventListener("change", () => setApiKey(el.apiKeyInput2.value));
el.apiKeyClear.addEventListener("click", () => { setApiKey(""); toast("キーを削除しました"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.searchPanel.hidden) closeSearch(); });

// ---------- 診断表示：何かが壊れたら画面に出す ----------
function showDiag(msg) {
  let d = document.getElementById("diag");
  if (!d) {
    d = document.createElement("div");
    d.id = "diag";
    d.className = "diag";
    document.body.appendChild(d);
  }
  d.textContent = msg;
}
window.addEventListener("error", (e) => showDiag("アプリ内でエラー: " + (e.message || e.type)));
window.addEventListener("unhandledrejection", (e) => showDiag("アプリ内でエラー: " + (e.reason?.message || e.reason)));
// YouTube の API スクリプトが一定時間で来なければ知らせる（広告ブロッカー・ネット断など）
setTimeout(() => {
  if (!window.YT || !state.apiReady) showDiag("YouTube のプレーヤーを読み込めていません。インターネット接続や、広告ブロッカー／コンテンツブロッカーが youtube.com を止めていないか確認してください。");
}, 10000);

// ---------- 起動 ----------

renderRates();
renderRecent();
renderLoop();
el.hidePaused.checked = loadStore().settings?.hidePaused ?? true;
el.showCaptions.checked = loadStore().settings?.showCaptions ?? false;
el.countIn.checked = loadStore().settings?.countIn ?? false;
el.apiKeyInput.value = el.apiKeyInput2.value = getApiKey();
setSize("large");
setTheater(!!loadStore().settings?.theater);
renderZoom();

// ?v=ID や ?url=... で開かれた場合はすぐ読み込む
{
  const q = new URLSearchParams(location.search);
  const v = parseVideo(q.get("url") || q.get("v") || "");
  if (v) loadVideo(v.id, v.start);
}

// Service Worker は古いファイルを掴んで「読み込めない」原因になったので使わない。
// 以前の登録が残っていれば外す。
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
}
