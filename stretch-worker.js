"use strict";
// 速度を変えたときの音を、音程を保ったまま伸び縮みさせる（Rubber Band。Mac の分離サーバーと同じ処理）。
// Mac がないとき（この端末に取り込んだ曲）に stems.js から使う。重い計算なので画面とは別のスレッドで動かす。
// 受け取る: { job, parts: [[L, R], ...], sr, rate }   返す: { job, out: [[L, R], ...] }（長さは元の 1/rate）
const RB = "https://cdn.jsdelivr.net/npm/rubberband-wasm@3.3.0/dist/";
importScripts(RB + "index.umd.min.js");

const ready = (async () => {
  const bin = await fetch(RB + "rubberband.wasm").then((r) => r.arrayBuffer());
  return self.rubberband.RubberBandInterface.initialize(await WebAssembly.compile(bin));
})();

// 一度に全部を渡して計算する（オフライン方式：先に全体を調べてから伸ばすので、長さも位置も正確）
function stretch(api, chs, sr, rate) {
  const n = chs[0].length;
  const nc = chs.length;
  const st = api.rubberband_new(sr, nc, 0, 1 / rate, 1);
  const blk = Math.max(api.rubberband_get_samples_required(st), 4096);
  api.rubberband_set_max_process_size(st, blk);
  const arr = api.malloc(nc * 4);
  const ptrs = [];
  for (let c = 0; c < nc; c++) {
    const p = api.malloc(blk * 4);
    ptrs.push(p);
    api.memWritePtr(arr + c * 4, p);
  }
  api.rubberband_set_expected_input_duration(st, n);
  const feed = (r, m) => chs.forEach((b, c) => api.memWrite(ptrs[c], b.subarray(r, r + m)));
  for (let r = 0; r < n; r += blk) {
    const m = Math.min(blk, n - r);
    feed(r, m);
    api.rubberband_study(st, arr, m, r + m >= n ? 1 : 0);
  }
  const len = Math.round(n / rate);
  const out = chs.map(() => new Float32Array(len + blk));
  let w = 0;
  const pull = () => {
    let a;
    while ((a = api.rubberband_available(st)) > 0) {
      const got = api.rubberband_retrieve(st, arr, Math.min(a, blk));
      ptrs.forEach((p, c) => out[c].set(api.memReadF32(p, got), w));
      w += got;
    }
  };
  for (let r = 0; r < n; r += blk) {
    const m = Math.min(blk, n - r);
    feed(r, m);
    api.rubberband_process(st, arr, m, r + m >= n ? 1 : 0);
    pull();
  }
  pull();
  ptrs.forEach((p) => api.free(p));
  api.free(arr);
  api.rubberband_delete(st);
  return out.map((o) => o.slice(0, len));
}

self.onmessage = async (e) => {
  const { job, parts, sr, rate } = e.data;
  try {
    const api = await ready;
    const out = parts.map((lr) => stretch(api, lr, sr, rate));
    self.postMessage({ job, out }, out.flat().map((a) => a.buffer));
  } catch (err) {
    self.postMessage({ job, error: String(err) });
  }
};
