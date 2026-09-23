"use strict";
// STEMS：曲を6パートに分けて聴く。Mac の http 版で分離サーバー（~/YouTubeパート分離、8766 番）が
// 見つかったときだけ出てくる。YouTube の映像は無音で流し、分けた音を映像の時刻に合わせて鳴らす。
// app.js の state / preroll / clamp / fmt / toast を使う。

window.Stems = (() => {
  // https の公開版からは http の Mac に届かない（混在コンテンツ）ので、最初から探さない
  const SERVER = location.protocol === "http:" ? `http://${location.hostname}:8766` : null;
  const PARTS = [
    { id: "drums", name: "Drums" },
    { id: "bass", name: "Bass" },
    { id: "other", name: "Other" },
    { id: "vocals", name: "Vocal" },
    { id: "guitar", name: "Guitar" },
    { id: "piano", name: "Piano" },
  ];
  const STORE_KEY = "ytlooper:stems";
  const UNITY = 0.75;    // フェーダーのこの位置が 0 dB（一番上は約 +5 dB）

  // 鳴らし方：6パートを1本にまとめた生の音（mix.pcm）を少しずつ取り、全パートを Web Audio の同じ時計で
  // 同じ瞬間に鳴らす。パートごとに <audio> で鳴らすと、iPhone では鳴り出しの遅れがパートごとに違い、
  // パートどうしがずれてバラバラに聞こえるため
  const CHUNK = 2;          // 曲の秒。まとめた音をこの長さずつ取りに行く（2秒＝約 2MB）
  // 速度を変えたときは、分離サーバーが音程を保ったまま伸び縮みさせた音を作って返す。
  // かたまりどうしは前後 XFADE ずつ重ね、フェードしてつなぐ（サーバーの CHUNK / XFADE と同じ値）
  const XFADE = 0.01;
  const AHEAD = 8;          // 再生位置からこの秒数先まで取っておく
  const KEEP = 24;          // 手元に置くかたまりの数（超えたら遠いものから捨てる）
  const HORIZON = 0.5;      // この秒数先まで鳴らす予約を入れておく
  const START_LEAD = 0.05;  // 鳴らし始め・合わせ直しはこの秒数先から（予約が間に合うように）
  const FADE = 0.008;       // 合わせ直しのつなぎ目を短く重ねてプツッという音を消す
  // 映像とのズレ：一定時間の平均で判断し、大きいときだけ合わせ直す（合わせ直しはほぼ聞こえない）
  const TOL = 0.035;
  const HARD = 0.25;        // これ以上ずれたら平均を待たずに合わせ直す
  const WINDOW_MS = 1000;
  const MIN_GAP_MS = 1500;
  const SETTLE_MS = 300;    // 合わせ直した直後はズレの判定を休む
  const OFFSET_STEP = 0.01; // Sync の「早く」「遅く」1回ぶん
  const OFFSET_MAX = 0.5;

  const $ = (id) => document.getElementById(id);
  const ui = {
    app: document.querySelector(".app"),
    dock: $("stemsDock"), status: $("stemsStatus"), mixer: $("stemsMixer"),
    power: $("stemsPower"), led: $("stemsLed"), clear: $("stemsAllOn"), flat: $("stemsFlat"),
    sync: $("stemsSync"), syncLcd: $("syncLcd"), earlier: $("syncEarlier"), later: $("syncLater"), syncReset: $("syncReset"),
  };

  const S = {
    available: false,
    videoId: null,
    phase: "idle",     // idle | checking | none | working | ready | error | offline
    job: null,
    loadedId: null,    // 音を読み込み済みの動画
    loaded: false,
    on: true,          // On スイッチ：分けた音で鳴らすか
    owning: false,     // いま分けた音で鳴らしているか（YouTube 側は無音）
    ctx: null,
    ch: PARTS.map((p) => ({ ...p, pos: UNITY, mute: false, solo: false, level: 0 })),
    mix: null,         // { id, url, sr, frames, dur, channels, index[], rate } いま鳴らす曲のまとめた音
    chunks: new Map(), // かたまりの番号 → { bufs: AudioBuffer[6] | null, used }
    queue: [],         // 取りに行く順番
    loading: 0,
    gen: null,         // いまの鳴らし方 { at, media, rate, next, bus[], nodes[] }。合わせ直すたびに作り直す
    clock: null,
    offset: 0,         // Sync：耳で合わせたずらし（秒、+ で音が早く出る）。端末ごとに保存
    pollTimer: null,
    stat: { reanchors: 0, d: null, mean: null, lastWhy: "" },
  };

  // ---------- 一時的な診断：iPhone の中の状態を Mac の分離サーバーの記録に送る ----------
  function diag(tag, extra = {}) {
    if (!SERVER) return;
    const body = JSON.stringify({ tag, t: Math.round(performance.now()), ...extra });
    fetch(SERVER + "/api/diag", { method: "POST", body, keepalive: true }).catch(() => {});
  }
  function snapshot() {
    const c = S.ctx;
    const ts = c?.getOutputTimestamp?.();
    return {
      ctx: c?.state, sr: c?.sampleRate, owning: S.owning, gen: !!S.gen, on: S.on, rate: state.rate,
      yt: state.player?.getPlayerState?.(), ytT: +(state.player?.getCurrentTime?.() || 0).toFixed(2),
      base: c?.baseLatency, out: c?.outputLatency,
      ts: ts ? { c: +ts.contextTime.toFixed(3), p: Math.round(ts.performanceTime) } : null,
      lat: c ? +(c.currentTime - heardCtx()).toFixed(3) : null,
      d: S.stat.d == null ? null : Math.round(S.stat.d * 1000),
      mean: S.stat.mean == null ? null : Math.round(S.stat.mean * 1000),
      re: S.stat.reanchors, why: S.stat.lastWhy,
      chunks: [...S.chunks.values()].filter((k) => k.bufs).length, q: S.queue.length, loading: S.loading,
      off: Math.round(S.offset * 1000),
      lv: S.ch.map((k) => k.level.toFixed(2)),
    };
  }
  setInterval(() => { if (S.available && S.loadedId) diag("snap", snapshot()); }, 3000);

  // ---------- 設定の保存 ----------
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (typeof p.on === "boolean") S.on = p.on;
      if (Number.isFinite(p.offset)) S.offset = clamp(p.offset, -OFFSET_MAX, OFFSET_MAX);
      for (const c of S.ch) {
        const q = p.parts?.[c.id];
        if (!q) continue;
        if (typeof q.pos === "number") c.pos = clamp(q.pos, 0, 1);
        c.mute = !!q.mute; c.solo = !!q.solo;
      }
    } catch { /* 保存なしでも動く */ }
  }
  function savePrefs() {
    const parts = {};
    for (const c of S.ch) parts[c.id] = { pos: c.pos, mute: c.mute, solo: c.solo };
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ on: S.on, parts, offset: S.offset })); } catch { /* 同上 */ }
  }

  // ---------- 音量の換算 ----------
  const posToGain = (p) => (p <= 0.005 ? 0 : (p / UNITY) ** 2);
  function dbText(p) {
    const g = posToGain(p);
    if (!g) return "OFF";
    const db = 20 * Math.log10(g);
    const r = Math.round(db * 10) / 10;
    return (r > 0 ? "+" : "") + (Object.is(r, -0) ? 0 : r).toFixed(1);
  }

  // ---------- ミキサーの部品 ----------
  function buildMixer() {
    ui.mixer.innerHTML = "";
    for (const c of S.ch) {
      const root = document.createElement("div");
      root.className = "stem";
      root.dataset.part = c.id;
      root.innerHTML = `
        <span class="stem-name">${c.name}</span>
        <div class="stem-fader" role="slider" tabindex="0" aria-label="${c.name} の音量"
             aria-valuemin="0" aria-valuemax="1"><div class="slot"></div><div class="cap"></div></div>
        <div class="stem-meter" aria-hidden="true"><i></i></div>
        <span class="lcd stem-db"></span>
        <div class="stem-ms">
          <button type="button" class="metal-btn mute" aria-pressed="false" title="消音">M</button>
          <button type="button" class="metal-btn solo" aria-pressed="false" title="このパートだけ聴く">S</button>
        </div>`;
      c.ui = {
        root,
        fader: root.querySelector(".stem-fader"),
        meter: root.querySelector(".stem-meter i"),
        db: root.querySelector(".stem-db"),
        mute: root.querySelector(".mute"),
        solo: root.querySelector(".solo"),
      };
      c.ui.mute.addEventListener("click", () => { c.mute = !c.mute; mixChanged(); });
      c.ui.solo.addEventListener("click", () => { c.solo = !c.solo; mixChanged(); });
      wireFader(c);
      ui.mixer.appendChild(root);
    }
    renderMix();
  }

  // フェーダー：つまんだ所からの相対移動で動かす（iPhone でスクロールのつもりの指が触れても音量が跳ばない）
  function wireFader(c) {
    const f = c.ui.fader;
    let drag = null;
    const vertical = () => f.clientHeight > f.clientWidth;
    f.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const v = vertical();
      drag = { v, start: v ? e.clientY : e.clientX, pos: c.pos, len: (v ? f.clientHeight : f.clientWidth) - 16, id: e.pointerId };
      f.setPointerCapture(e.pointerId);
      f.classList.add("dragging");
    });
    f.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const now = drag.v ? e.clientY : e.clientX;
      const d = (drag.v ? drag.start - now : now - drag.start) / Math.max(40, drag.len);
      c.pos = clamp(drag.pos + d, 0, 1);
      // 0 dB の位置で軽く吸い付かせる
      if (Math.abs(c.pos - UNITY) < 0.012) c.pos = UNITY;
      mixChanged(false);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      f.classList.remove("dragging");
      savePrefs();
    };
    f.addEventListener("pointerup", end);
    f.addEventListener("pointercancel", end);
    f.addEventListener("dblclick", () => { c.pos = UNITY; mixChanged(); });
    f.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const k = e.key;
      if (k === "ArrowUp" || k === "ArrowRight") c.pos = clamp(c.pos + step, 0, 1);
      else if (k === "ArrowDown" || k === "ArrowLeft") c.pos = clamp(c.pos - step, 0, 1);
      else if (k === "Home") c.pos = 0;
      else if (k === "End") c.pos = 1;
      else if (k === "0" || k === "Enter") c.pos = UNITY;
      else return;
      e.preventDefault();
      e.stopPropagation(); // ルーパーの ← → シークに渡さない
      mixChanged();
    });
  }

  function mixChanged(save = true) {
    renderMix();
    applyGains();
    if (save) savePrefs();
  }

  function renderMix() {
    const anySolo = S.ch.some((c) => c.solo);
    for (const c of S.ch) {
      if (!c.ui) continue;
      c.ui.fader.style.setProperty("--pos", c.pos);
      c.ui.fader.setAttribute("aria-valuenow", c.pos.toFixed(2));
      c.ui.fader.setAttribute("aria-valuetext", dbText(c.pos) + " dB");
      c.ui.db.textContent = dbText(c.pos);
      c.ui.mute.setAttribute("aria-pressed", String(c.mute));
      c.ui.solo.setAttribute("aria-pressed", String(c.solo));
      c.ui.root.classList.toggle("silent", c.mute || (anySolo && !c.solo) || !posToGain(c.pos));
    }
  }

  function applyGains() {
    if (!S.ctx) return;
    const anySolo = S.ch.some((c) => c.solo);
    for (const c of S.ch) {
      const g = c.mute || (anySolo && !c.solo) ? 0 : posToGain(c.pos);
      c.gain.gain.setTargetAtTime(g, S.ctx.currentTime, 0.015);
    }
  }

  // ---------- 音の配線 ----------
  // パートごとに 音量（gain）→ スピーカー、と メーター（analyser）。鳴らす音はその手前に毎回つなぐ
  function ensureGraph() {
    if (S.ctx) return;
    // iPhone のマナーモードでも鳴るよう「再生用の音」として扱わせる（Safari 16.4 以降）
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    const AC = window.AudioContext || window.webkitAudioContext;
    S.ctx = new AC();
    S.ctx.onstatechange = () => diag("ctx", { state: S.ctx.state });
    diag("graph", { ctx: S.ctx.state, sr: S.ctx.sampleRate, base: S.ctx.baseLatency, out: S.ctx.outputLatency });
    for (const c of S.ch) {
      c.gain = S.ctx.createGain();
      c.analyser = S.ctx.createAnalyser();
      c.analyser.fftSize = 512;
      c.buf = new Float32Array(c.analyser.fftSize);
      c.gain.connect(S.ctx.destination);
      c.gain.connect(c.analyser);
    }
    applyGains();
  }

  // iPhone は「ユーザーの操作の中」でしか音を出し始められない。画面に触れるたびに処理系を起こしておく。
  // 指の操作は「離した瞬間」（pointerup / touchend）しか操作と認められない（指の pointerdown では何もしない）
  function unlock(e) {
    if (e.type === "pointerdown" && e.pointerType !== "mouse") return;
    if (!S.ctx) return;
    if (S.ctx.state !== "running") {
      S.ctx.resume().catch((err) => diag("resume-ng", { err: `${err.name}: ${err.message}` }));
    }
    if (!S.primed) {
      // 1サンプルの無音を鳴らす（古い iOS はこれで初めて音が出せるようになる）
      S.primed = true;
      const n = S.ctx.createBufferSource();
      n.buffer = S.ctx.createBuffer(1, 1, 22050);
      n.connect(S.ctx.destination);
      n.start();
    }
  }
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown"]) {
    document.addEventListener(type, unlock, true);
  }

  async function loadAudio(id) {
    ensureGraph();
    unloadAudio();
    S.loadedId = id;
    renderStatus();
    try {
      const r = await fetch(`/stems/${id}/mix.json`, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const m = await r.json();
      if (S.loadedId !== id) return;
      S.mix = {
        id, url: `/stems/${id}/mix.pcm`, sr: m.sr, frames: m.frames, dur: m.frames / m.sr, channels: m.channels,
        index: S.ch.map((c) => m.parts.indexOf(c.id)),
        rate: 1,
      };
      S.loaded = true;
      diag("loaded", { id, dur: +S.mix.dur.toFixed(1) });
      prefetch();
      updateOwnership();
      renderStatus();
    } catch (err) {
      if (S.loadedId !== id) return;
      diag("load-ng", { id, err: String(err) });
      setPhase("error", { error: "分けた音を読み込めませんでした" });
    }
  }

  function unloadAudio() {
    stopGen();
    S.loaded = false;
    S.loadedId = null;
    S.mix = null;
    S.chunks.clear();
    S.queue = [];
    for (const c of S.ch) c.level = 0;
    updateOwnership(); // 次の画面更新を待たずに YouTube の音へ戻す
  }

  // ---------- まとめた音を少しずつ取る ----------
  const chunkOf = (t) => Math.floor(Math.max(0, t) / CHUNK);
  // かたまり i が始まる曲の位置（速度を変えた音は前のかたまりと XFADE だけ重なる）
  const chunkStart = (i, rate) => (rate === 1 ? i * CHUNK : Math.max(0, i * CHUNK - XFADE));

  function need(i, urgent = false) {
    const m = S.mix;
    if (!m || i < 0 || i * CHUNK >= m.dur) return;
    const k = S.chunks.get(i);
    if (k) { k.used = performance.now(); return; }
    S.chunks.set(i, { bufs: null, used: performance.now() });
    urgent ? S.queue.unshift(i) : S.queue.push(i);
    pump();
  }

  function pump() {
    while (S.loading < 2 && S.queue.length) {
      const i = S.queue.shift();
      const m = S.mix;
      const k = S.chunks.get(i);
      if (!m || !k || k.bufs) continue;
      const f0 = Math.round(i * CHUNK * m.sr);
      const f1 = Math.min(m.frames, Math.round((i + 1) * CHUNK * m.sr));
      const bpf = m.channels * 2;
      const rate = m.rate;
      S.loading++;
      (rate === 1
        ? fetch(m.url, { headers: { Range: `bytes=${f0 * bpf}-${f1 * bpf - 1}` }, cache: "no-store" })
        : fetch(`${SERVER}/api/pcm?id=${m.id}&rate=${rate}&i=${i}`, { cache: "no-store" }))
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
        .then((ab) => {
          if (S.mix !== m || S.chunks.get(i) !== k || m.rate !== rate) return;
          k.bufs = toBuffers(m, ab);
          schedule();
        })
        .catch((err) => {
          if (S.chunks.get(i) === k) S.chunks.delete(i); // 次の先読みで取り直す
          diag("chunk-ng", { i, err: String(err) });
        })
        .finally(() => { S.loading--; pump(); });
    }
  }

  // 16bit・12ch（パート×ステレオ）を、パートごとのステレオの AudioBuffer に分ける
  function toBuffers(m, ab) {
    const d = new Int16Array(ab);
    const n = Math.floor(d.length / m.channels);
    return S.ch.map((c, p) => {
      const b = S.ctx.createBuffer(2, Math.max(1, n), m.sr);
      const L = b.getChannelData(0), R = b.getChannelData(1);
      const src = m.index[p];
      if (src < 0) return b;
      for (let f = 0, j = src * 2; f < n; f++, j += m.channels) {
        L[f] = d[j] / 32768;
        R[f] = d[j + 1] / 32768;
      }
      return b;
    });
  }

  // 再生位置の先と、A–B ループの戻り先を取っておく。遠いものは捨てる
  function prefetch() {
    if (!S.mix || !state.player?.getCurrentTime) return;
    if (S.mix.rate !== state.rate) {
      // 速度が変わった：その速度の音を取り直す
      S.mix.rate = state.rate;
      S.chunks.clear();
      S.queue = [];
    }
    const t = S.gen ? heardMedia() : ytNow();
    const cur = chunkOf(t);
    need(cur, true);
    for (let i = cur + 1; i <= cur + AHEAD / CHUNK; i++) need(i);
    const keep = new Set();
    for (let i = cur - 1; i <= cur + AHEAD / CHUNK; i++) keep.add(i);
    if (state.loop && state.b > state.a) {
      const a = chunkOf(state.a + S.offset);
      for (let i = a; i <= a + 1; i++) { need(i); keep.add(i); }
    }
    if (S.chunks.size > KEEP) {
      const old = [...S.chunks.entries()].filter(([i]) => !keep.has(i)).sort((x, y) => x[1].used - y[1].used);
      for (const [i] of old.slice(0, S.chunks.size - KEEP)) S.chunks.delete(i);
    }
  }

  // ---------- 時計 ----------
  // いまスピーカーから出ている音の、処理系の時刻。予約した時刻から実際に聞こえるまでの遅れ
  // （iPhone では大きい）を差し引いた値
  function heardCtx() {
    const c = S.ctx;
    const ts = c.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return c.currentTime - (c.outputLatency || 0) - (c.baseLatency || 0);
  }
  // いま聞こえている曲の位置
  function heardMedia() {
    const g = S.gen;
    return g.media + (heardCtx() - g.at) * g.rate;
  }
  // YouTube の getCurrentTime は飛び飛びに変わる（iPhone は特に粗い）ので、値が変わった瞬間を基準に経過時間で補う
  function ytNow() {
    const raw = state.player.getCurrentTime();
    const now = performance.now() / 1000;
    if (!S.clock || raw !== S.clock.raw) S.clock = { raw, at: now };
    return S.clock.raw + Math.min(now - S.clock.at, 0.5) * state.rate;
  }

  // ---------- 鳴らす ----------
  // 曲の位置 t（いま映像に出ている位置）から鳴らし始める。鳴っていれば、短く重ねて乗り換える
  function begin(t, why) {
    const ctx = S.ctx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const at = now + START_LEAD;
    // at に予約した音が聞こえるのは、映像がさらに (at − いま聞こえている時刻) × 速度 進んだとき
    const rate = S.mix.rate;
    const media = t + (S.offset + (at - heardCtx())) * rate;
    endGen(at);
    const bus = S.ch.map((c) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(1, at + FADE);
      g.connect(c.gain);
      return g;
    });
    S.gen = { at, media, rate, next: chunkOf(media), bus, nodes: [] };
    S.stat.reanchors++;
    S.stat.lastWhy = why;
    S.settleUntil = performance.now() + SETTLE_MS;
    S.win = null;
    S.clock = null;
    need(S.gen.next, true);
    schedule();
  }

  function endGen(at) {
    const g = S.gen;
    if (!g) return;
    S.gen = null;
    for (const b of g.bus) {
      b.gain.cancelScheduledValues(at);
      b.gain.setValueAtTime(1, at);
      b.gain.linearRampToValueAtTime(0, at + FADE);
    }
    for (const { n } of g.nodes) { try { n.stop(at + FADE + 0.005); } catch { /* 鳴り終わっている */ } }
    setTimeout(() => { for (const b of g.bus) b.disconnect(); }, (at - S.ctx.currentTime + 0.2) * 1000);
  }

  function stopGen() {
    if (S.gen) endGen(S.ctx.currentTime);
  }

  // 取れているかたまりを、少し先まで順に予約する（かたまりどうしは隙間なくつながる）
  function schedule() {
    const g = S.gen, m = S.mix;
    if (!g || !m) return;
    const ctx = S.ctx;
    const now = ctx.currentTime;
    g.nodes = g.nodes.filter((x) => x.end > now);
    for (;;) {
      const i = g.next;
      if (i * CHUNK >= m.dur) break;
      const when = g.at + (chunkStart(i, g.rate) - g.media) / g.rate;
      if (when > now + HORIZON) break;
      const k = S.chunks.get(i);
      if (!k?.bufs) { need(i, true); break; } // まだ届いていない。届いたらそこから鳴らす
      k.used = performance.now();
      const len = k.bufs[0].duration;
      let t = when, off = 0;
      if (t < now + 0.005) { off = now + 0.005 - t; t = now + 0.005; } // 遅れて届いたぶんは途中から
      if (off < len) {
        k.bufs.forEach((b, p) => {
          const n = ctx.createBufferSource();
          n.buffer = b;
          n.connect(g.bus[p]);
          n.start(t, off);
          g.nodes.push({ n, end: t + len - off });
        });
      }
      g.next = i + 1;
    }
  }
  setInterval(schedule, 200); // 画面の更新が止まっても予約は続ける

  function owns() { return S.owning; }

  function updateOwnership() {
    // 処理系が動き出す（最初に画面に触れる）までは YouTube の音のまま鳴らす
    const want = S.available && S.on && S.loaded && S.ctx?.state === "running"
      && S.loadedId === state.videoId && !!state.player?.mute;
    if (want === S.owning) return;
    S.owning = want;
    if (want) {
      state.player.mute();
    } else {
      stopGen();
      if (state.player?.unMute && !preroll) state.player.unMute();
    }
    renderPower();
  }

  function sync() {
    try { syncInner(); } catch (err) {
      if (!S.syncErr) { S.syncErr = true; diag("sync-err", { err: `${err.name}: ${err.message}`, stack: String(err.stack).slice(0, 400) }); }
    }
  }
  function syncInner() {
    if (!S.available) return;
    updateOwnership();
    if (S.phase === "none" && state.duration !== S.estFor) renderStatus(); // 長さが分かったら所要時間を出す
    if (S.owning) {
      const st = state.player.getPlayerState?.();
      const want = st === YT.PlayerState.PLAYING && !preroll;
      if (!want) {
        if (S.gen) stopGen();
      } else if (!S.gen) {
        prefetch();
        begin(ytNow(), "start");
      } else if (S.gen.rate !== state.rate) {
        prefetch();                       // 速度が変わった：新しい速度の音に乗り換える
        begin(ytNow(), "rate");
      } else {
        follow();
      }
      prefetch();
      schedule();
    }
    drawMeters();
  }

  function follow() {
    const now = performance.now();
    if (now < S.settleUntil) return;
    const d = (heardMedia() - ytNow()) / S.gen.rate - S.offset; // 聞こえる音のズレ（実時間の秒）
    S.stat.d = d;
    if (Math.abs(d) > HARD) { begin(ytNow(), "hard " + Math.round(d * 1000)); return; }
    if (!S.win) S.win = { start: now, sum: 0, n: 0 };
    S.win.sum += d;
    S.win.n++;
    if (now - S.win.start < WINDOW_MS) return;
    const mean = S.win.sum / S.win.n;
    S.win = null;
    S.stat.mean = mean;
    if (Math.abs(mean) <= TOL || now - (S.fixedAt || 0) < MIN_GAP_MS) return;
    S.fixedAt = now;
    begin(ytNow(), "mean " + Math.round(mean * 1000));
  }

  // ルーパー側のシーク（A–B ループの折り返しなど）
  function seek(t) {
    S.clock = null;
    if (S.owning && S.gen) begin(t, "seek");
  }

  // ---------- Sync：音のタイミングを耳で合わせる ----------
  function setOffset(v) {
    S.offset = clamp(Math.round(v * 1000) / 1000, -OFFSET_MAX, OFFSET_MAX);
    renderSync();
    savePrefs();
    if (S.owning && S.gen) begin(ytNow(), "offset");
  }
  function renderSync() {
    const ms = Math.round(S.offset * 1000);
    ui.syncLcd.innerHTML = ms > 0 ? `<b>+</b>${ms}` : String(ms);
    ui.syncLcd.setAttribute("aria-label", `音のずらし ${ms} ミリ秒`);
  }
  // 押し続けると続けて動く
  function wireNudge(btn, dir) {
    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; };
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      btn.dataset.held = "1";
      setOffset(S.offset + dir * OFFSET_STEP);
      const again = (delay) => { timer = setTimeout(() => { setOffset(S.offset + dir * OFFSET_STEP); again(80); }, delay); };
      again(450);
    });
    for (const t of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(t, stop);
    btn.addEventListener("click", (e) => {
      // キーボードで押したとき（pointerdown が来ない）だけここで動かす
      if (btn.dataset.held) { delete btn.dataset.held; return; }
      e.preventDefault();
      setOffset(S.offset + dir * OFFSET_STEP);
    });
  }
  wireNudge(ui.earlier, +1);
  wireNudge(ui.later, -1);
  ui.syncReset.addEventListener("click", () => setOffset(0));

  // メーター：いま実際に鳴っている音（フェーダー・消音のあと）
  function drawMeters() {
    for (const c of S.ch) {
      if (!c.ui) continue;
      let lv = 0;
      if (S.gen && c.analyser) {
        c.analyser.getFloatTimeDomainData(c.buf);
        let peak = 0;
        for (let i = 0; i < c.buf.length; i++) {
          const v = Math.abs(c.buf[i]);
          if (v > peak) peak = v;
        }
        lv = peak > 0 ? clamp((20 * Math.log10(peak) + 48) / 48, 0, 1) : 0;
      }
      const next = Math.max(lv, c.level - 0.025);
      if (Math.abs(next - c.level) > 0.002 || (next === 0 && c.level !== 0)) {
        c.level = next;
        c.ui.meter.style.setProperty("--lv", next.toFixed(3));
      }
    }
  }

  // ---------- サーバーとのやりとり ----------
  async function api(path, opts = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || 4000);
    try {
      const r = await fetch(SERVER + path, { method: opts.method || "GET", signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkVideo(id) {
    stopPolling();
    setPhase("checking");
    try {
      const st = await api(`/api/status?id=${encodeURIComponent(id)}`);
      if (S.videoId !== id) return;
      applyStatus(id, st);
    } catch {
      if (S.videoId === id) setPhase("offline");
    }
  }

  function applyStatus(id, st) {
    if (st.state === "ready") {
      stopPolling();
      setPhase("ready");
      if (S.loadedId !== id) loadAudio(id);
    } else if (st.state === "working") {
      setPhase("working", st);
      startPolling(id);
    } else if (st.state === "error") {
      stopPolling();
      setPhase("error", st);
    } else {
      setPhase("none");
    }
  }

  async function prepare() {
    const id = S.videoId;
    if (!id) return;
    setPhase("working", { message: "始めています" });
    try {
      const st = await api(`/api/prepare?id=${encodeURIComponent(id)}`, { method: "POST" });
      if (S.videoId === id) applyStatus(id, st);
    } catch {
      if (S.videoId === id) setPhase("offline");
    }
  }

  function startPolling(id) {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(async () => {
      try {
        const st = await api(`/api/status?id=${encodeURIComponent(id)}`);
        if (S.videoId !== id) return stopPolling();
        applyStatus(id, st);
      } catch {
        stopPolling();
        if (S.videoId === id) setPhase("offline");
      }
    }, 1000);
  }
  function stopPolling() {
    clearInterval(S.pollTimer);
    S.pollTimer = null;
  }

  // ---------- 表示 ----------
  function setPhase(phase, job = null) {
    S.phase = phase;
    S.job = job;
    renderStatus();
  }

  function mmss(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function renderStatus() {
    const box = ui.status;
    const ready = S.phase === "ready" && S.loaded;
    ui.mixer.classList.toggle("idle", !ready);
    box.hidden = ready;
    box.dataset.phase = S.phase;
    let html = "";
    switch (S.phase) {
      case "idle":
        html = `<p>動画を読み込むと、ここでパートごとに聴けます。</p>`;
        break;
      case "checking":
        html = `<p>確認しています…</p>`;
        break;
      case "none": {
        S.estFor = state.duration;
        const est = state.duration ? Math.max(1, Math.round((state.duration * 0.5 + 20) / 60)) : 0;
        html = `<p>この曲はまだ分けていません。${est ? `分けるのに約 ${est} 分かかります。` : ""}一度分ければ、次からはすぐ聴けます。</p>
                <button type="button" class="metal-btn stems-go" data-act="prepare">Split</button>`;
        break;
      }
      case "working": {
        const j = S.job || {};
        const pct = j.total ? Math.min(99, Math.floor((j.done / j.total) * 100)) : 0;
        const remain = j.remain != null ? `残り約 ${mmss(j.remain)}。` : "";
        html = `<div class="stems-progress">
                  <span class="lcd small">${String(pct).padStart(2, "0")}</span>
                  <div class="stems-bar"><i style="width:${pct}%"></i></div>
                </div>
                <p>${esc(j.message || "分けています")}… ${remain}再生はそのまま続けられます。終わると分けた音に切り替わります。</p>`;
        break;
      }
      case "ready":
        html = `<p>読み込んでいます…</p>`;
        break;
      case "error":
        html = `<p>分けられませんでした。${esc(shortError(S.job?.error))}</p>
                <button type="button" class="metal-btn stems-go" data-act="prepare">Retry</button>`;
        break;
      case "offline":
        html = `<p>分離サーバーにつながりません。YT LOOPER.app から開き直すと立ち上がります。</p>
                <button type="button" class="metal-btn stems-go" data-act="recheck">Retry</button>`;
        break;
    }
    box.innerHTML = html;
    renderPower();
  }

  function shortError(msg) {
    if (!msg) return "";
    if (/Sign in|confirm your age|age-restricted/i.test(msg)) return "年齢制限のある動画は分けられません。";
    if (/Private video|unavailable/i.test(msg)) return "この動画は取得できません。";
    const line = msg.split("\n").filter(Boolean).pop() || "";
    return line.length > 120 ? line.slice(0, 120) + "…" : line;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  function renderPower() {
    ui.power.setAttribute("aria-pressed", String(S.on));
    ui.led.classList.toggle("on", S.owning);
    ui.power.title = S.on ? "元の音に戻す" : "分けた音で聴く";
  }

  ui.status.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "prepare") prepare();
    else if (act === "recheck") (S.available ? checkVideo(S.videoId) : init());
  });
  ui.power.addEventListener("click", () => {
    S.on = !S.on;
    savePrefs();
    updateOwnership();
    renderPower();
    toast(S.on ? (S.loaded ? "分けた音で再生" : "分け終わると切り替わります") : "元の音で再生");
  });
  ui.clear.addEventListener("click", () => {
    for (const c of S.ch) { c.mute = false; c.solo = false; }
    mixChanged();
  });
  ui.flat.addEventListener("click", () => {
    for (const c of S.ch) c.pos = UNITY;
    mixChanged();
  });

  // ---------- 入口 ----------
  function onVideo(id) {
    S.videoId = id;
    if (!S.available) return;
    if (S.loadedId && S.loadedId !== id) unloadAudio();
    checkVideo(id);
  }

  async function init() {
    if (!SERVER) return;
    try {
      await api("/api/hello", { timeout: 1500 });
    } catch {
      return; // 分離サーバーがなければ何も出さない
    }
    S.available = true;
    diag("init", { ua: navigator.userAgent, audioSession: !!navigator.audioSession });
    loadPrefs();
    buildMixer();
    renderSync();
    ui.dock.hidden = false;
    ui.app.dataset.stems = "1";
    const id = S.videoId || state.videoId;
    if (id) onVideo(id);
    else renderStatus();
  }

  init();
  return { onVideo, seek, sync, owns };
})();
