// Worker de leitura: roda o motor fora da thread da tela
importScripts('engine.js');
const E = self.BPEngine;
let tracker = E.createTracker();

function cropOf(img, quad) {
  const P = E.PROFILE_HEM7122, W = P.W, H = P.H;
  const g = E.warpGray(img, quad, W, H);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = g[i]; out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = v; out[4 * i + 3] = 255; }
  return { w: W, h: H, data: out };
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'reset') { tracker.reset(); return; }
    const img = { width: m.width, height: m.height, data: new Uint8ClampedArray(m.buffer) };
    if (m.type === 'frame') {
      const r = tracker.process(img);
      const msg = { type: 'result', id: m.id, mode: r.mode, ms: r.ms, vote: r.vote, reading: r.reading, lockQuad: null, done: null };
      if (tracker.locked && r.reading) msg.lockQuad = r.quad;
      if (r.vote && r.vote.done) {
        const P = E.PROFILE_HEM7122;
        msg.done = { values: r.vote.values, confident: r.vote.confident, crop: r.quad ? cropOf(img, r.quad) : null };
      }
      self.postMessage(msg, msg.done && msg.done.crop ? [msg.done.crop.data.buffer] : []);
    } else if (m.type === 'photo') {
      const t0 = Date.now();
      const { best } = E.readImage(img);
      const ok = !!(best && best.ok);
      const msg = { type: 'photo', id: m.id, ms: Date.now() - t0, ok, confident: ok && best.confident, values: ok ? best.values : null, crop: best && best.quad ? cropOf(img, best.quad) : null };
      self.postMessage(msg, msg.crop ? [msg.crop.data.buffer] : []);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
