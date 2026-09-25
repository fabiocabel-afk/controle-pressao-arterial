// Gera fotos sintéticas do visor HEM-7122 com perspectiva, rotação, reflexo, ruído e segmentos fantasma.
const E = require('../app/engine');
const P = E.PROFILE_HEM7122;
const DIG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abcf', 8: 'abcdefg', 9: 'abcdfg' };

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function segHit(u, v, row, cx, seg) {
  const G = { a: [0, -1, 'h'], b: [1, -0.5, 'v'], c: [1, 0.5, 'v'], d: [0, 1, 'h'], e: [-1, 0.5, 'v'], f: [-1, -0.5, 'v'], g: [0, 0, 'h'] }[seg];
  const X = cx + G[0] * row.W2, Y = row.cy + G[1] * row.H2;
  const du = u - X, dv = v - Y;
  if (G[2] === 'h') { const L = 0.9 * row.W2, T = 0.15 * row.H2; return Math.abs(dv) < T && Math.abs(du) + Math.abs(dv) * (row.W2 / row.H2) * 0.8 < L; }
  const L = 0.46 * row.H2, T = 0.14 * row.W2; return Math.abs(du) < T && Math.abs(dv) + Math.abs(du) * (row.H2 / row.W2) * 0.8 < L;
}

function render(values, seed, opts = {}) {
  const R = rng(seed);
  const W = 1190, H = 2576;
  const data = new Uint8ClampedArray(W * H * 4);
  // plano do aparelho (unidades normalizadas do visor expandido)
  const lcdSize = (opts.size || (0.25 + R() * 0.3)) * W; // largura do visor em px
  const rot = ((R() * 2 - 1) * (opts.maxRot || 35)) * Math.PI / 180;
  const cx = W * (0.4 + R() * 0.2), cy = H * (0.4 + R() * 0.2);
  const aspect = P.H / P.W;
  const base = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => {
    const X = x * lcdSize, Y = y * lcdSize * aspect;
    const j = opts.persp === 0 ? 0 : (opts.persp || 0.12) * lcdSize;
    return [cx + X * Math.cos(rot) - Y * Math.sin(rot) + (R() * 2 - 1) * j, cy + X * Math.sin(rot) + Y * Math.cos(rot) + (R() * 2 - 1) * j];
  });
  const Hm = E.homography(base, [[0, 0], [1, 0], [1, 1], [0, 1]]); // imagem -> plano
  const lit = new Set(), ghostAll = true;
  P.rows.forEach((row, ri) => {
    const s = String(values[ri]).padStart(3, ' ');
    for (let d = 0; d < 3; d++) if (s[d] !== ' ') for (const seg of DIG[s[d]]) lit.add(ri + ':' + d + ':' + seg);
  });
  const glareA = R() * Math.PI, glareOff = R() * 1.2 - 0.1, glareW = 0.08 + R() * 0.15, glareI = opts.glare !== undefined ? opts.glare : R() * 60;
  const lcdBg = 110 + R() * 55, ink = lcdBg * (0.3 + R() * 0.25), ghost = opts.ghost !== undefined ? opts.ghost : R() * 8;
  const woodBase = 60 + R() * 60, light = 0.7 + R() * 0.4;
  const inset = 0.012;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [u, v] = E.applyH(Hm, x, y);
    let val;
    const inLCD = u > inset && u < 1 - inset && v > inset && v < 1 - inset;
    if (inLCD) {
      val = lcdBg;
      for (let ri = 0; ri < 3 && val === lcdBg; ri++) {
        const row = P.rows[ri];
        for (let d = 0; d < 3; d++) for (const seg of 'abcdefg') if (segHit(u, v, row, row.cx[d], seg)) {
          val = lit.has(ri + ':' + d + ':' + seg) ? ink : lcdBg - ghost;
        }
      }
    } else if (u > -0.3 && u < 1.08 && v > -0.3 && v < 1.08) val = 200 + (v * 10);
    else if (u > -0.42 && u < 1.2 && v > -0.5 && v < 1.6) val = 240;
    else val = woodBase + 25 * Math.sin(x * 0.02 + Math.sin(y * 0.005) * 3);
    // reflexo em faixa (no plano)
    const gd = Math.abs((u - 0.5) * Math.cos(glareA) + (v - 0.5) * Math.sin(glareA) - (glareOff - 0.5));
    if (u > -0.3 && u < 1.08 && v > -0.3 && v < 1.08 && gd < glareW) val = Math.min(255, val + glareI * (1 - gd / glareW));
    val = val * light + (R() * 2 - 1) * 6;
    const o = (y * W + x) * 4;
    data[o] = val * 0.98; data[o + 1] = val; data[o + 2] = val * 0.95; data[o + 3] = 255;
  }
  const Hi = E.homography([[0, 0], [1, 0], [1, 1], [0, 1]], base);
  const trueQuad = [[inset, inset], [1 - inset, inset], [1 - inset, 1 - inset], [inset, 1 - inset]].map(([a, b]) => E.applyH(Hi, a, b));
  return { width: W, height: H, data, trueQuad };
}
module.exports = { render };
