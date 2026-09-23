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
  const HARD = 0.25;     // これ以上ズレたら飛ばして合わせる
  const DEAD = 0.012;    // これ以内なら速度は触らない（伸縮処理で音色を変えないため）
  const SPREAD = 0.04;   // パート同士がこれ以上離れたら揃え直す

  const $ = (id) => document.getElementById(id);
  const ui = {
    app: document.querySelector(".app"),
    dock: $("stemsDock"), status: $("stemsStatus"), mixer: $("stemsMixer"),
    power: $("stemsPower"), led: $("stemsLed"), clear: $("stemsAllOn"), flat: $("stemsFlat"),
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
    playing: false,
    ctx: null,
    ch: PARTS.map((p) => ({ ...p, pos: UNITY, mute: false, solo: false, level: 0 })),
    clock: null,
    drift: 0,
    pollTimer: null,
  };

  // ---------- 設定の保存 ----------
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (typeof p.on === "boolean") S.on = p.on;
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
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ on: S.on, parts })); } catch { /* 同上 */ }
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
  function ensureGraph() {
    if (S.ctx) return;
    // iPhone のマナーモードでも鳴るよう「再生用の音」として扱わせる（Safari 16.4 以降）
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    const AC = window.AudioContext || window.webkitAudioContext;
    S.ctx = new AC();
    for (const c of S.ch) {
      const a = new Audio();
      a.crossOrigin = "anonymous";
      a.preload = "auto";
      a.preservesPitch = true;
      a.webkitPreservesPitch = true;
      a.playsInline = true;
      const src = S.ctx.createMediaElementSource(a);
      c.gain = S.ctx.createGain();
      c.analyser = S.ctx.createAnalyser();
      c.analyser.fftSize = 512;
      c.buf = new Float32Array(c.analyser.fftSize);
      src.connect(c.gain);
      c.gain.connect(S.ctx.destination);
      c.gain.connect(c.analyser);
      c.audio = a;
    }
    applyGains();
  }

  // iPhone は「指で触れた瞬間」にしか音を出し始められない。最初に触れたときに一度鳴らして止めておくと、
  // あとから映像に合わせて自動で鳴らせるようになる
  function unlock() {
    if (!S.ctx) return;
    if (S.ctx.state === "suspended") S.ctx.resume();
    for (const c of S.ch) {
      const a = c.audio;
      if (c.unlocked || !a.src) continue;
      c.unlocked = true;
      a.muted = true;
      a.play().then(() => { if (!S.playing) a.pause(); a.muted = false; })
        .catch(() => { c.unlocked = false; a.muted = false; });
    }
  }
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);

  function loadAudio(id) {
    ensureGraph();
    S.loaded = false;
    S.loadedId = id;
    pauseAll();
    const ready = S.ch.map((c) => new Promise((resolve, reject) => {
      const a = c.audio;
      const ok = () => { off(); resolve(); };
      const ng = () => { off(); reject(new Error(c.name)); };
      const off = () => { a.removeEventListener("canplay", ok); a.removeEventListener("error", ng); };
      a.addEventListener("canplay", ok);
      a.addEventListener("error", ng);
      c.unlocked = false;
      a.src = `${SERVER}/stems/${id}/${c.id}.m4a`;
      a.load();
    }));
    renderStatus();
    Promise.all(ready).then(() => {
      if (S.loadedId !== id) return;
      S.loaded = true;
      updateOwnership();
      renderStatus();
    }).catch((err) => {
      if (S.loadedId !== id) return;
      setPhase("error", { error: `${err.message} の音を読み込めませんでした` });
    });
  }

  function unloadAudio() {
    pauseAll();
    S.loaded = false;
    S.loadedId = null;
    for (const c of S.ch) {
      if (!c.audio) continue;
      c.audio.removeAttribute("src");
      c.audio.load();
      c.level = 0;
    }
    updateOwnership(); // 次の画面更新を待たずに YouTube の音へ戻す
  }

  // ---------- 映像に合わせる ----------
  // getCurrentTime は飛び飛びに変わるので、値が変わった瞬間を基準に経過時間で補う
  function ytNow() {
    const raw = state.player.getCurrentTime();
    const now = performance.now() / 1000;
    if (!S.clock || raw !== S.clock.raw) S.clock = { raw, at: now };
    return S.clock.raw + Math.min(now - S.clock.at, 0.1) * state.rate;
  }

  function startAll(t) {
    if (S.ctx.state === "suspended") S.ctx.resume();
    S.playing = true;
    S.drift = 0;
    for (const c of S.ch) {
      c.audio.currentTime = t;
      c.audio.playbackRate = state.rate;
      c.audio.play().catch(() => {
        if (!S.playing) return;
        S.playing = false;
        pauseAll();
        toast("画面をタップすると分けた音が出ます");
      });
    }
  }
  function pauseAll() {
    S.playing = false;
    S.clock = null;
    for (const c of S.ch) c.audio?.pause();
  }
  function seekAll(t) {
    S.drift = 0;
    S.clock = null;
    for (const c of S.ch) c.audio.currentTime = t;
  }

  function owns() { return S.owning; }

  function updateOwnership() {
    const want = S.available && S.on && S.loaded && S.loadedId === state.videoId && !!state.player?.mute;
    if (want === S.owning) return;
    S.owning = want;
    if (want) {
      state.player.mute();
    } else {
      pauseAll();
      if (state.player?.unMute && !preroll) state.player.unMute();
    }
    renderPower();
  }

  function sync() {
    if (!S.available) return;
    updateOwnership();
    if (S.phase === "none" && state.duration !== S.estFor) renderStatus(); // 長さが分かったら所要時間を出す
    if (S.owning) {
      const st = state.player.getPlayerState?.();
      const want = st === YT.PlayerState.PLAYING && !preroll;
      if (!want) {
        if (S.playing) pauseAll();
      } else if (!S.playing) {
        startAll(ytNow());
      } else {
        follow();
      }
    }
    drawMeters();
  }

  function follow() {
    const yt = ytNow();
    const lead = S.ch[0].audio;
    const d = lead.currentTime - yt;
    if (Math.abs(d) > HARD) { seekAll(yt); return; }
    S.drift = S.drift * 0.85 + d * 0.15;
    const base = state.rate;
    // 少しだけ速度を変えて、音を飛ばさずに寄せる
    const r = Math.abs(S.drift) > DEAD ? base * (1 + clamp(-S.drift * 0.5, -0.02, 0.02)) : base;
    for (const c of S.ch) {
      if (c.audio.playbackRate !== r) c.audio.playbackRate = r;
      if (c !== S.ch[0] && Math.abs(c.audio.currentTime - lead.currentTime) > SPREAD) {
        c.audio.currentTime = lead.currentTime;
      }
    }
  }

  function seek(t) {
    if (S.owning && S.loaded) seekAll(t);
  }

  // メーター：いま実際に鳴っている音（フェーダー・消音のあと）
  function drawMeters() {
    for (const c of S.ch) {
      if (!c.ui) continue;
      let lv = 0;
      if (S.playing && c.analyser) {
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
    loadPrefs();
    buildMixer();
    ui.dock.hidden = false;
    ui.app.dataset.stems = "1";
    const id = S.videoId || state.videoId;
    if (id) onVideo(id);
    else renderStatus();
  }

  init();
  return { onVideo, seek, sync, owns };
})();
