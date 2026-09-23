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
  // 飛ばして合わせると、iPhone では鳴り出すまでしばらく無音になり、しかも currentTime が粗くズレを大きく見せる。
  // 再生速度はズレ直しに使わない（iPhone では速度を変え続けると Web Audio への音が止まる）。
  // 一度合わせればズレはほとんど増えない（実測 1分で 5ms）ので、平均のズレが大きいときだけ飛ばして合わせる
  const TOL = 0.08;        // 平均でこれ以上ずれていたら合わせ直す
  const HARD = 1.0;        // これ以上ずれたら平均を待たずに合わせ直す
  const WINDOW_MS = 1500;  // ズレはこの時間の平均で判断する（iPhone の currentTime は粗い）
  const MIN_GAP_MS = 3000; // 合わせ直しはこの間隔より詰めない
  const SPREAD = 0.5;      // パート同士がこれ以上離れたら揃え直す
  const SETTLE_MS = 800;   // 飛ばしたあと、鳴り出すまでズレの判定を休む時間

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
    seekLead: 0,       // 飛ばすときに先へ飛ばす秒数（平均のズレから学習し、端末ごとに保存）
    pollTimer: null,
  };

  // ---------- 一時的な診断：iPhone の中の状態を Mac の分離サーバーの記録に送る ----------
  function diag(tag, extra = {}) {
    if (!SERVER) return;
    const body = JSON.stringify({ tag, t: Math.round(performance.now()), ...extra });
    fetch(SERVER + "/api/diag", { method: "POST", body, keepalive: true }).catch(() => {});
  }
  function snapshot() {
    const p = state.player;
    return {
      ctx: S.ctx?.state, owning: S.owning, playing: S.playing, loaded: S.loaded, on: S.on,
      yt: p?.getPlayerState?.(), ytMuted: p?.isMuted?.(), ytT: +(p?.getCurrentTime?.() || 0).toFixed(2),
      vis: document.visibilityState,
      a: S.ch.map((c) => {
        const a = c.audio;
        if (!a) return "-";
        return `${a.paused ? "P" : ">"}${a.readyState}/${a.currentTime.toFixed(1)}${a.muted ? "/m" : ""}${a.error ? "/E" + a.error.code : ""}`;
      }),
      lv: S.ch.map((c) => c.level.toFixed(2)),
      gain: S.ch.map((c) => (c.gain ? c.gain.gain.value.toFixed(2) : "-")),
      mix: S.ch.map((c) => `${c.pos.toFixed(2)}${c.mute ? "M" : ""}${c.solo ? "S" : ""}`),
      raw: S.ch.map((c) => {
        if (!c.analyser) return "-";
        c.analyser.getFloatTimeDomainData(c.buf);
        let p = 0;
        for (const v of c.buf) p = Math.max(p, Math.abs(v));
        return p.toFixed(3);
      }),
      raf: rafCount,
      seeks: S.seeks || 0,
      lead: +S.seekLead.toFixed(2),
      d: S.playing ? +((S.ch[0].audio.currentTime - state.player.getCurrentTime()) * 1000).toFixed(0) : null,
    };
  }
  let rafCount = 0;
  const countFrames = () => { rafCount++; requestAnimationFrame(countFrames); };
  requestAnimationFrame(countFrames);
  setInterval(() => { if (S.available && S.loadedId) diag("snap", snapshot()); }, 3000);

  // ---------- 設定の保存 ----------
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (typeof p.on === "boolean") S.on = p.on;
      if (Number.isFinite(p.seekLead)) S.seekLead = clamp(p.seekLead, 0, 1.5);
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
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ on: S.on, parts, seekLead: S.seekLead })); } catch { /* 同上 */ }
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
  // 音量・メーターの処理系（Web Audio）。
  // 必ず「Web Audio につないでから src を入れる」。音を読み込んだあとでつなぐと、Chrome では無音になる。
  // 処理系はここ（操作の外）で作ってよく、画面に触れた操作の中で resume するだけでよい（iPhone で確認済み）
  function ensureGraph() {
    if (S.ctx) return;
    // iPhone のマナーモードでも鳴るよう「再生用の音」として扱わせる（Safari 16.4 以降）
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    const AC = window.AudioContext || window.webkitAudioContext;
    S.ctx = new AC();
    S.ctx.onstatechange = () => diag("ctx", { state: S.ctx.state });
    diag("graph", { ctx: S.ctx.state, audioSession: navigator.audioSession?.type || null });
    for (const c of S.ch) {
      const a = new Audio();
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

  // iPhone は「ユーザーの操作の中」でしか音を出し始められない。操作のたびに一度鳴らして止めておくと、
  // あとから映像に合わせて自動で鳴らせるようになる。
  // 指の操作は「離した瞬間」（pointerup / touchend）しか操作と認められない。触れた瞬間（pointerdown）は
  // マウスのときだけ認められるので、指の pointerdown では何もしない（ここで失敗すると次の機会を逃す）
  function unlock(e) {
    if (e.type === "pointerdown" && e.pointerType !== "mouse") return;
    if (!S.ctx) return;
    const pending = S.ch.filter((c) => !c.unlocked && c.audio.src).length;
    if (S.ctx.state !== "running" || pending) diag("unlock", { type: e.type, pt: e.pointerType, ctx: S.ctx.state, pending });
    if (S.ctx.state !== "running") S.ctx.resume().catch((err) => diag("resume-ng", { err: `${err.name}: ${err.message}` }));
    for (const c of S.ch) {
      const a = c.audio;
      if (c.unlocked || !a.src) continue;
      c.unlocked = true;
      a.muted = true;
      a.play().then(() => { if (!S.playing) a.pause(); a.muted = false; diag("unlock-ok", { part: c.id }); })
        .catch((err) => { c.unlocked = false; a.muted = false; diag("unlock-ng", { part: c.id, err: `${err.name}: ${err.message}` }); });
    }
  }
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown"]) {
    document.addEventListener(type, unlock, true);
  }

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
      // ページと同じサーバー（serve.py）から読む。別のポートから読むと iPhone では Web Audio で無音になる
      a.src = `/stems/${id}/${c.id}.m4a`;
      a.load();
    }));
    renderStatus();
    Promise.all(ready).then(() => {
      if (S.loadedId !== id) return;
      S.loaded = true;
      diag("loaded", { id });
      updateOwnership();
      renderStatus();
    }).catch((err) => {
      if (S.loadedId !== id) return;
      diag("load-ng", { id, err: err.message });
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
  // 分けた音の再生位置も同じように補う。iPhone の Safari は currentTime を粗い間隔でしか更新しないので、
  // 生の値で比べると「ずれて見える → 飛ばす → 鳴る前にまた飛ばす」を繰り返し、音が一度も出なくなる
  function audioNow() {
    const a = S.ch[0].audio;
    const raw = a.currentTime;
    const now = performance.now() / 1000;
    if (!S.aclock || raw !== S.aclock.raw) S.aclock = { raw, at: now };
    return S.aclock.raw + Math.min(now - S.aclock.at, 0.3) * a.playbackRate;
  }
  // 飛ばして合わせた直後は、鳴り出すまで待つ（その間はズレを判定しない）
  function settle() {
    S.settleUntil = performance.now() + SETTLE_MS;
    S.win = null;
    S.clock = null;
    S.aclock = null;
  }

  function startAll(t) {
    if (S.ctx.state === "suspended") S.ctx.resume();
    S.playing = true;
    t += S.seekLead;
    settle();
    diag("start", { t: +t.toFixed(2), ...snapshot() });
    for (const c of S.ch) {
      c.audio.currentTime = t;
      c.audio.playbackRate = state.rate;
      c.audio.play().then(() => diag("start-ok", { part: c.id })).catch((err) => {
        diag("start-ng", { part: c.id, err: `${err.name}: ${err.message}` });
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
  // 飛ばすと、新しい位置の音を取りに行くあいだ鳴り出しが遅れる（iPhone で 0.3〜0.6 秒）。
  // その間も映像は進むので、遅れるぶん先へ飛ばす。先へ飛ばす量は着地のズレから学習する
  function seekAll(t, { ahead = true } = {}) {
    S.seeks = (S.seeks || 0) + 1;
    settle();
    const to = Math.max(0, t + (ahead ? S.seekLead : 0));
    for (const c of S.ch) c.audio.currentTime = to;
  }

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
      pauseAll();
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
    const now = performance.now();
    const lead = S.ch[0].audio;
    for (const c of S.ch) {
      // 速度は SPEED で変えたときだけ合わせる
      if (c.audio.playbackRate !== state.rate) c.audio.playbackRate = state.rate;
      // パート同士のずれ直しは、大きくずれたときだけ・1本あたり2秒に1回まで
      if (c !== lead && now > (c.fixedAt || 0) + 2000
          && Math.abs(c.audio.currentTime - lead.currentTime) > SPREAD) {
        c.fixedAt = now;
        c.audio.currentTime = lead.currentTime;
      }
    }
    if (now < S.settleUntil) return;

    const yt = ytNow();
    const d = audioNow() - yt;
    if (Math.abs(d) > HARD) { seekAll(yt); return; }

    if (!S.win) S.win = { start: now, sum: 0, n: 0 };
    S.win.sum += d;
    S.win.n++;
    if (now - S.win.start < WINDOW_MS) return;
    const mean = S.win.sum / S.win.n;
    S.win = null;
    S.drift = mean;   // 記録用
    if (Math.abs(mean) <= TOL || now - (S.fixedAt || 0) < MIN_GAP_MS) return;

    // 平均で mean だけずれて鳴っている。次からはそのぶん見越して飛ばす
    S.seekLead = clamp(S.seekLead - mean, 0, 1.5);
    savePrefs();
    S.fixedAt = now;
    seekAll(yt);
  }

  // ルーパー側のシーク（A–B ループの折り返しなど）。映像も同じだけ止まって読み込むので、先へは飛ばさない
  function seek(t) {
    if (S.owning && S.loaded) seekAll(t, { ahead: false });
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
    diag("init", { ua: navigator.userAgent, audioSession: !!navigator.audioSession });
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
