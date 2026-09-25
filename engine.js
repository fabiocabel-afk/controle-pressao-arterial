// Motor de leitura de visor LCD 7 segmentos (Omron HEM-7122)
// JS puro, sem dependências. Funciona no navegador e no Node.
(function (root) {
'use strict';

// ---------- utilidades de imagem ----------
function toGray(img, maxSide) {
  // img: {width, height, data: RGBA}
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const g = new Float32Array(w * h);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.floor((x + 1) * sx));
      let acc = 0, n = 0;
      for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) {
        let o = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++, o += 4) {
          acc += 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]; n++;
        }
      }
      g[y * w + x] = acc / n;
    }
  }
  return { w, h, g, scale: s };
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// componentes conexos (4-vizinhança) numa máscara Uint8
function components(mask, w, h, minArea) {
  const lab = new Int32Array(w * h).fill(-1);
  const comps = []; const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = comps.length; let sp = 0; stack[sp++] = i; lab[i] = id;
    const pix = []; let touches = false;
    let minx = w, miny = h, maxx = 0, maxy = 0;
    while (sp) {
      const p = stack[--sp]; pix.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      if (x > 0 && mask[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && lab[p - w] < 0) { lab[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && lab[p + w] < 0) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    comps.push({ id, pix, area: pix.length, touches, minx, miny, maxx, maxy });
  }
  return { lab, comps: comps.filter(c => c.area >= minArea) };
}

function convexHull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop(); return lo.concat(up);
}
function polyArea(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }

// Quadrilátero de área mínima aproximado: 4 cantos a partir do casco convexo.
// Estratégia: escolher 4 pontos do casco que maximizam a área (busca O(n^2) com n pequeno).
function hullToQuad(H) {
  // reduz casco para no máx ~48 pontos
  let P = H;
  if (P.length > 48) { const st = P.length / 48; const R = []; for (let i = 0; i < 48; i++) R.push(P[Math.floor(i * st)]); P = R; }
  const n = P.length; let best = -1, bq = null;
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  for (let i = 0; i < n; i++) for (let k = i + 2; k < n; k++) {
    let m1 = 0, j1 = -1; for (let j = i + 1; j < k; j++) { const t = tri(P[i], P[j], P[k]); if (t > m1) { m1 = t; j1 = j; } }
    let m2 = 0, l1 = -1; for (let l = k + 1; l < n + i; l++) { const t = tri(P[i], P[k], P[l % n]); if (t > m2) { m2 = t; l1 = l % n; } }
    if (j1 >= 0 && l1 >= 0 && m1 + m2 > best) { best = m1 + m2; bq = [P[i], P[j1], P[k], P[l1]]; }
  }
  return bq;
}


// ---------- geometria projetiva ----------
function solve(A, b) { // Gauss com pivoteamento
  const n = b.length; A = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r, i) => r[n] / r[i]);
}
// homografia que leva src[i] -> dst[i]
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const hh = solve(A, b); return hh ? hh.concat([1]) : null;
}
function applyH(H, x, y) { const d = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; }

// ordena os cantos em sentido horário a partir do ângulo
function orderQuad(q) {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  return q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

// amostra a imagem RGBA original em cinza numa grade W x H mapeada ao quad (TL,TR,BR,BL)
function fullGray(img) {
  if (img._gray) return img._gray;
  const n = img.width * img.height, g = new Float32Array(n), d = img.data;
  for (let i = 0, o = 0; i < n; i++, o += 4) g[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  return (img._gray = g);
}
function warpGray(img, quad, W, H) {
  const Hm = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
  const out = new Float32Array(W * H), g = fullGray(img), iw = img.width, ih = img.height;
  if (!Hm) return out;
  const lum = (x, y) => g[y * iw + x];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let [sx, sy] = applyH(Hm, x + 0.5, y + 0.5); sx -= 0.5; sy -= 0.5;
    const x0 = Math.max(0, Math.min(iw - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(ih - 2, Math.floor(sy)));
    const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
    out[y * W + x] = lum(x0, y0) * (1 - fx) * (1 - fy) + lum(x0 + 1, y0) * fx * (1 - fy) + lum(x0, y0 + 1) * (1 - fx) * fy + lum(x0 + 1, y0 + 1) * fx * fy;
  }
  return out;
}


// ---------- perfil do aparelho ----------
// Coordenadas normalizadas (0..1) dentro do visor retificado (quad expandido por `expand`).
const PROFILE_HEM7122 = {
  id: 'omron-hem7122', name: 'Omron HEM-7122', expand: 1.07, W: 200, H: 250,
  rows: [
    { key: 'sys', cy: 0.293, W2: 0.0875, H2: 0.130, cx: [0.197, 0.484, 0.771], min: 60, max: 260 },
    { key: 'dia', cy: 0.631, W2: 0.0875, H2: 0.130, cx: [0.197, 0.484, 0.771], min: 30, max: 200 },
    { key: 'pulse', cy: 0.896, W2: 0.050, H2: 0.074, cx: [0.473, 0.638, 0.804], min: 30, max: 220 },
  ],
  // padrões aceitos (segmentos a b c d e f g)
  digits: { 'abcdef': 0, 'bc': 1, 'abdeg': 2, 'abcdg': 3, 'bcfg': 4, 'acdfg': 5, 'acdefg': 6, 'cdefg': 6, 'abc': 7, 'abcf': 7, 'abcdefg': 8, 'abcdfg': 9, 'abcfg': 9 }
};
const SEGS = 'abcdefg';

// posições (em unidades de W2/H2) e orientação de cada segmento
const SEG_GEOM = {
  a: [0, -1, 'h'], b: [1, -0.5, 'v'], c: [1, 0.5, 'v'], d: [0, 1, 'h'], e: [-1, 0.5, 'v'], f: [-1, -0.5, 'v'], g: [0, 0, 'h']
};
// pontos de amostragem (u,v normalizados) para cada segmento: grade 5x2 no "miolo"
function segSamples(row, cx, seg) {
  const [gx, gy, o] = SEG_GEOM[seg]; const pts = [];
  const X = cx + gx * row.W2, Y = row.cy + gy * row.H2;
  for (let i = -2; i <= 2; i++) for (const j of [-0.5, 0.5]) {
    if (o === 'h') pts.push([X + i * row.W2 * 0.16, Y + j * row.H2 * 0.07]);
    else pts.push([X + j * row.W2 * 0.10, Y + i * row.H2 * 0.09]);
  }
  return pts;
}
// pontos de fundo: centros dos "buracos" do 8 e laterais
function bgSamples(row, cx) {
  const p = [];
  for (const v of [-0.5, 0.5]) for (const u of [-0.45, 0, 0.45]) p.push([cx + u * row.W2, row.cy + v * row.H2]);
  for (const v of [-0.6, 0, 0.6]) p.push([cx + 1.55 * row.W2, row.cy + v * row.H2]);
  return p;
}
function buildTemplate(P) {
  const segs = [], bg = [], bgRow = P.rows.map(() => []);
  P.rows.forEach((row, ri) => row.cx.forEach((cx, di) => {
    for (const s of SEGS) segs.push({ ri, di, s, pts: segSamples(row, cx, s) });
    for (const q of bgSamples(row, cx)) { bg.push(q); bgRow[ri].push(q); }
  }));
  return { segs, bg, bgRow };
}

// ---------- mapa de "tinta" (quão mais escuro que o fundo local) ----------
// filtro de máximo separável O(n) (van Herk / Gil-Werman)
function maxLine(src, dst, n, off, stride, r, g, hbuf) {
  const k = 2 * r + 1;
  for (let i = 0; i < n; i++) {
    const v = src[off + i * stride];
    g[i] = (i % k === 0) ? v : Math.max(g[i - 1], v);
  }
  for (let i = n - 1; i >= 0; i--) {
    const v = src[off + i * stride];
    hbuf[i] = (i === n - 1 || (i + 1) % k === 0) ? v : Math.max(hbuf[i + 1], v);
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r), b = Math.min(n - 1, i + r);
    if (((a / k) | 0) === ((b / k) | 0) && !(a % k === 0 && b - a === k - 1)) {
      let m = -Infinity; for (let j = a; j <= b; j++) { const v = src[off + j * stride]; if (v > m) m = v; }
      dst[off + i * stride] = m;
    } else dst[off + i * stride] = Math.max(hbuf[a], g[b]);
  }
}
function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const m = Math.max(w, h), g = new Float32Array(m), hb = new Float32Array(m);
  for (let y = 0; y < h; y++) maxLine(src, tmp, w, y * w, 1, r, g, hb);
  for (let x = 0; x < w; x++) maxLine(tmp, out, h, x, w, r, g, hb);
  return out;
}
// substitui a moldura clara (fora do visor) pelo nível do fundo do visor, para não criar "tinta" falsa nas bordas
function maskBorder(t, w, h) {
  const med = a => { const b = Float32Array.from(a).sort(); return b[b.length >> 1]; };
  const sub = new Float32Array(Math.ceil(w / 3) * Math.ceil(h / 3)); let n = 0;
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) sub[n++] = t[y * w + x];
  const all = med(sub.subarray(0, n));
  const rowMed = new Array(h).fill(0), colMed = new Array(w).fill(0);
  const rowAt = y => { const c = new Float32Array(Math.ceil(w / 2)); let k = 0; for (let x = 0; x < w; x += 2) c[k++] = t[y * w + x]; return med(c.subarray(0, k)); };
  const colAt = x => { const c = new Float32Array(Math.ceil(h / 2)); let k = 0; for (let y = 0; y < h; y += 2) c[k++] = t[y * w + x]; return med(c.subarray(0, k)); };
  for (let y = 0; y < h; y++) if (y < h * 0.15 || y > h * 0.85) rowMed[y] = rowAt(y);
  for (let x = 0; x < w; x++) if (x < w * 0.15 || x > w * 0.85) colMed[x] = colAt(x);
  const lim = all + 18;
  const out = Float32Array.from(t);
  const kill = (x, y) => { out[y * w + x] = Math.min(out[y * w + x], all); };
  for (let y = 0; y < h * 0.15 && rowMed[y] > lim; y++) for (let x = 0; x < w; x++) kill(x, y);
  for (let y = h - 1; y > h * 0.85 && rowMed[y] > lim; y--) for (let x = 0; x < w; x++) kill(x, y);
  for (let x = 0; x < w * 0.15 && colMed[x] > lim; x++) for (let y = 0; y < h; y++) kill(x, y);
  for (let x = w - 1; x > w * 0.85 && colMed[x] > lim; x--) for (let y = 0; y < h; y++) kill(x, y);
  return out;
}
function inkMap(t0, w, h) {
  const t = maskBorder(t0, w, h);
  const r = Math.max(3, Math.round(w * 0.035));
  const bg = boxBlur(maxFilter(boxBlur(t, w, h, 1), w, h, r), w, h, r);
  const D = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) D[i] = Math.max(0, bg[i] - t[i]);
  return D;
}
function sampleBilinear(D, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.min(w - 2, x | 0), y0 = Math.min(h - 2, y | 0), fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return D[i] * (1 - fx) * (1 - fy) + D[i + 1] * fx * (1 - fy) + D[i + w] * (1 - fx) * fy + D[i + w + 1] * fx * fy;
}

// transformação afim do template: parâmetros p = [tx, ty, s, ax (razão), rot, shear]
function makeXf(p, w, h) {
  const [tx, ty, s, ar, rot, sh] = p;
  const sx = s * ar, sy = s / ar, c = Math.cos(rot), sn = Math.sin(rot);
  return (u, v) => {
    let X = (u - 0.5) * sx + sh * (v - 0.5) * sy, Y = (v - 0.5) * sy;
    const Xr = X * c - Y * sn, Yr = X * sn + Y * c;
    return [(Xr + 0.5 + tx) * w, (Yr + 0.5 + ty) * h];
  };
}
function affineOf(p, w, h) {
  const [tx, ty, s, ar, rot, sh] = p;
  const sx = s * ar, sy = s / ar, c = Math.cos(rot), sn = Math.sin(rot);
  return [w * c * sx, w * (c * sh * sy - sn * sy), w * (c * (-0.5 * sx - 0.5 * sh * sy) + 0.5 * sn * sy + 0.5 + tx),
          h * sn * sx, h * (sn * sh * sy + c * sy), h * (sn * (-0.5 * sx - 0.5 * sh * sy) - 0.5 * c * sy + 0.5 + ty)];
}
// pontuação rápida: soma ponderada da tinta nos pontos do gabarito (F = pontos achatados)
function scoreAffine(D, w, h, F, A) {
  const U = F.u, V = F.v, Wt = F.wt, n = U.length; let s = 0;
  for (let i = 0; i < n; i++) {
    const x = A[0] * U[i] + A[1] * V[i] + A[2], y = A[3] * U[i] + A[4] * V[i] + A[5];
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue;
    const x0 = x < w - 2 ? x | 0 : w - 2, y0 = y < h - 2 ? y | 0 : h - 2, fx = x - x0, fy = y - y0, k = y0 * w + x0;
    s += Wt[i] * (D[k] + (D[k + 1] - D[k]) * fx + (D[k + w] - D[k]) * fy + (D[k] - D[k + 1] - D[k + w] + D[k + w + 1]) * fx * fy);
  }
  return s;
}
function scoreHomog(D, w, h, F, H) {
  const U = F.u, V = F.v, Wt = F.wt, n = U.length; let s = 0;
  for (let i = 0; i < n; i++) {
    const z = H[6] * U[i] + H[7] * V[i] + H[8];
    const x = (H[0] * U[i] + H[1] * V[i] + H[2]) / z, y = (H[3] * U[i] + H[4] * V[i] + H[5]) / z;
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue;
    const x0 = x < w - 2 ? x | 0 : w - 2, y0 = y < h - 2 ? y | 0 : h - 2, fx = x - x0, fy = y - y0, k = y0 * w + x0;
    s += Wt[i] * (D[k] + (D[k + 1] - D[k]) * fx + (D[k + w] - D[k]) * fy + (D[k] - D[k + 1] - D[k + w] + D[k + w + 1]) * fx * fy);
  }
  return s;
}
function flatten(T, coarse) {
  const u = [], v = [], wt = [];
  const nS = T.segs.length;
  for (const sg of T.segs) {
    const pts = coarse ? [sg.pts[4], sg.pts[5]] : sg.pts;
    for (const [a, b] of pts) { u.push(a); v.push(b); wt.push(1 / (nS * pts.length)); }
  }
  for (const [a, b] of T.bg) { u.push(a); v.push(b); wt.push(-1 / T.bg.length); }
  return { u: Float32Array.from(u), v: Float32Array.from(v), wt: Float32Array.from(wt) };
}
function flats(T) { return T._f || (T._f = { full: flatten(T, false), coarse: flatten(T, true) }); }
function alignScore(D, w, h, T, p, coarse) { const F = flats(T); return scoreAffine(D, w, h, coarse ? F.coarse : F.full, affineOf(p, w, h)); }
function makeXfH(C) { const Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], C); return (u, v) => applyH(Hm, u, v); }
// refinamento projetivo: move os 4 cantos do gabarito (captura perspectiva residual)
function refineCorners(D, w, h, T, p) {
  const F = flats(T).full;
  const xf0 = makeXf(p, w, h);
  let C = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => xf0(u, v));
  const sc = C2 => { const Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], C2); return Hm ? scoreHomog(D, w, h, F, Hm) : -1e9; };
  let bs = sc(C);
  for (const step of [4, 2, 1, 0.5]) {
    let improved = true, guard = 0;
    while (improved && guard++ < 20) {
      improved = false;
      for (let k = 0; k < 8; k++) for (const d of [-1, 1]) {
        const C2 = C.map(q => q.slice()); C2[k >> 1][k & 1] += d * step;
        const v = sc(C2);
        if (v > bs) { bs = v; C = C2; improved = true; }
      }
    }
  }
  return { C, score: bs };
}
function align(D, w, h, T, wide, coarseOnly) {
  let best = null, bs = -1e9;
  const S = wide ? [0.66, 0.72, 0.78, 0.84, 0.9, 0.96] : [0.88, 0.92, 0.96, 1, 1.04, 1.08, 1.12];
  const AR = wide ? [0.85, 1, 1.17] : [1];
  const R = wide ? 0.2 : 0.08, st = wide ? 0.025 : 0.02;
  for (const s of S) for (const ar of AR) for (let tx = -R; tx <= R + 1e-9; tx += st) for (let ty = -R; ty <= R + 1e-9; ty += st) {
    const p = [tx, ty, s, ar, 0, 0]; const sc = alignScore(D, w, h, T, p, true);
    if (sc > bs) { bs = sc; best = p; }
  }
  if (coarseOnly) return { p: best, score: bs };
  bs = alignScore(D, w, h, T, best);
  // refinamento por descida coordenada
  const steps = [0.01, 0.01, 0.02, 0.03, 0.03, 0.06];
  for (let it = 0; it < 4; it++) {
    for (let k = 0; k < 6; k++) {
      for (const d of [-1, 1]) {
        let improved = true;
        while (improved) {
          improved = false; const p = best.slice(); p[k] += d * steps[k];
          const sc = alignScore(D, w, h, T, p); if (sc > bs) { bs = sc; best = p; improved = true; }
        }
      }
    }
    for (let k = 0; k < 6; k++) steps[k] /= 2;
  }
  return { p: best, score: bs };
}

// agrupamento em 2 classes (limiar de Otsu em 1D)
function otsu(vals) {
  const v = Array.from(vals).sort((a, b) => a - b); let best = -1, th = v[0];
  for (let i = 1; i < v.length; i++) {
    const A = v.slice(0, i), B = v.slice(i);
    const ma = A.reduce((a, b) => a + b, 0) / A.length, mb = B.reduce((a, b) => a + b, 0) / B.length;
    const between = A.length * B.length * (ma - mb) * (ma - mb);
    if (between > best) { best = between; th = (v[i - 1] + v[i]) / 2; }
  }
  return th;
}

// contraste local de cada segmento: brilho dos "buracos" vizinhos do dígito menos o brilho do segmento
const HOLE_OF = { a: [0], b: [0], f: [0], g: [0, 1], c: [1], d: [1], e: [1] };
function segContrasts(t, w, h, T, P, p) {
  const xf = makeXf(p, w, h);
  const mean = pts => { let a = 0; for (const [u, v] of pts) { const [x, y] = xf(u, v); a += sampleBilinear(t, w, h, x, y); } return a / pts.length; };
  const holeCache = {};
  return T.segs.map(sg => {
    const row = P.rows[sg.ri], cx = row.cx[sg.di], key = sg.ri + ':' + sg.di;
    if (!holeCache[key]) holeCache[key] = [-0.5, 0.5].map(k => {
      const pts = []; for (const du of [-0.3, 0, 0.3]) for (const dv of [-0.12, 0.12]) pts.push([cx + du * row.W2, row.cy + (k + dv) * row.H2]);
      return mean(pts);
    });
    const hs = HOLE_OF[sg.s].map(i => holeCache[key][i]);
    const hb = hs.reduce((a, b) => a + b, 0) / hs.length;
    return hb - mean(sg.pts);
  });
}


// ajuste fino por linha (SYS, DIA, PULSO): pequenos deslocamentos/escala por linha
function rowScore(D, w, h, T, P, ri, xf, o) {
  const row = P.rows[ri];
  const cx0 = (row.cx[0] + row.cx[row.cx.length - 1]) / 2;
  const tf = (u, v) => xf(cx0 + (u - cx0) * o[2] + o[0], row.cy + (v - row.cy) * o[2] + o[1]);
  let sv = 0, n = 0, bv = 0, nb = 0;
  for (const sg of T.segs) if (sg.ri === ri) { let a = 0; for (const [u, v] of sg.pts) { const [x, y] = tf(u, v); a += sampleBilinear(D, w, h, x, y); } sv += a / sg.pts.length; n++; }
  for (const b of T.bgRow[ri]) { const [x, y] = tf(b[0], b[1]); bv += sampleBilinear(D, w, h, x, y); nb++; }
  return { score: sv / n - bv / nb, tf };
}
function refineRows(D, w, h, T, P, xf) {
  return P.rows.map((row, ri) => {
    let best = [0, 0, 1], bs = rowScore(D, w, h, T, P, ri, xf, best).score;
    for (const [st, ss] of [[0.012, 0.03], [0.006, 0.015], [0.003, 0.008]]) {
      let imp = true, guard = 0;
      while (imp && guard++ < 12) {
        imp = false;
        for (const [k, d] of [[0, st], [0, -st], [1, st], [1, -st], [2, ss], [2, -ss]]) {
          const o = best.slice(); o[k] += d;
          if (Math.abs(o[0]) > 0.06 || Math.abs(o[1]) > 0.05 || Math.abs(o[2] - 1) > 0.12) continue;
          const sc = rowScore(D, w, h, T, P, ri, xf, o).score; if (sc > bs) { bs = sc; best = o; imp = true; }
        }
      }
    }
    return rowScore(D, w, h, T, P, ri, xf, best).tf;
  });
}

function decodeAligned(t, D, w, h, T, P, xf) {
  const rx = refineRows(D, w, h, T, P, xf);
  const outside = P.rows.map(() => 0);
  const vals = T.segs.map((sg, k) => { let a = 0; for (const [u, v] of sg.pts) { const [x, y] = rx[sg.ri](u, v); if (x < 0 || y < 0 || x > w - 1 || y > h - 1) outside[sg.ri]++; a += sampleBilinear(D, w, h, x, y); } return a / sg.pts.length; });
  const res = {}; let ok = true, minMargin = 1, fixes = 0;
  const detail = [], rowStats = [];
  const gth = otsu(vals);
  P.rows.forEach((row, ri) => {
    // limiar próprio de cada linha (o pulso tem dígitos menores e costuma ter menos contraste)
    const nd = row.cx.length, base0 = ri * nd * 7, rv = vals.slice(base0, base0 + nd * 7);
    const th = otsu(rv);
    const on = rv.filter(v => v > th), off = rv.filter(v => v <= th);
    const mOn = on.reduce((a, b) => a + b, 0) / Math.max(1, on.length), mOff = off.reduce((a, b) => a + b, 0) / Math.max(1, off.length);
    const half = Math.max(1e-6, (mOn - mOff) / 2);
    rowStats.push({ th, mOn, mOff });
    let str = '', started = false, rowOk = true;
    row.cx.forEach((cx, di) => {
      let pat = ''; const base = base0 + di * 7;
      for (let s = 0; s < 7; s++) {
        const v = vals[base + s];
        const m = Math.abs(v - th) / half; if (m < minMargin) minMargin = m;
        if (v > th) pat += SEGS[s];
      }
      // padrão inválido: tentar limiar próprio do dígito (reflexo pode enfraquecer segmentos)
      if (pat !== '' && P.digits[pat] === undefined) {
        const dv = []; for (let s = 0; s < 7; s++) dv.push([vals[base + s], SEGS[s]]);
        dv.sort((a, b) => b[0] - a[0]);
        let bestGap = 0, bestPat = null;
        for (let i = 1; i < 7; i++) {
          const gap = dv[i - 1][0] - dv[i][0];
          const p2 = dv.slice(0, i).map(x => x[1]).sort().join('');
          if (P.digits[p2] !== undefined && gap > bestGap) { bestGap = gap; bestPat = p2; }
        }
        if (bestPat && bestGap > 0.2 * (mOn - mOff)) { pat = bestPat; fixes++; }
      }
      detail.push(pat);
      if (pat === '') { if (started) rowOk = false; return; }
      const d = P.digits[pat];
      if (d === undefined) { rowOk = false; return; }
      if (!started && d === 0) { rowOk = false; return; }
      started = true; str += d;
    });
    if (outside[ri]) rowOk = false; // parte da linha caiu fora da imagem retificada
    const val = str ? parseInt(str, 10) : NaN;
    if (!rowOk || !(val >= row.min && val <= row.max)) ok = false;
    res[row.key] = rowOk ? val : NaN;
  });
  // contraste de cada linha precisa ser razoável frente à melhor linha
  const contrasts = rowStats.map(r => r.mOn - r.mOff), cmax = Math.max(...contrasts);
  if (contrasts.some(c => c < 8 || c < 0.25 * cmax)) ok = false;
  if (ok && !(res.sys > res.dia)) ok = false;
  const contrast = Math.min(...contrasts);
  const th = gth;
  const confident = ok && fixes === 0 && minMargin >= 0.2;
  return { ok, confident, values: res, pattern: detail, contrast, minMargin, threshold: th, fixes, rowStats };
}

// ---------- detecção do visor ----------
function sobelMag(g, w, h) {
  const m = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
    const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
    m[i] = Math.hypot(gx, gy);
  }
  return m;
}

// área preenchida (componente + buracos internos) dentro do bbox
function filledArea(c, lab, w) {
  const bw = c.maxx - c.minx + 3, bh = c.maxy - c.miny + 3;
  const out = new Uint8Array(bw * bh); // 1 = alcançável de fora
  const inC = (x, y) => { const X = x + c.minx - 1, Y = y + c.miny - 1; if (X < c.minx || Y < c.miny || X > c.maxx || Y > c.maxy) return false; return lab[Y * w + X] === c.id; };
  const st = [0]; out[0] = 1; let reach = 0;
  while (st.length) {
    const p = st.pop(); reach++;
    const x = p % bw, y = (p / bw) | 0;
    const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const q = ny * bw + nx; if (out[q] || inC(nx, ny)) continue; out[q] = 1; st.push(q);
    }
  }
  return bw * bh - reach;
}

function erode(m, w, h) {
  const o = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    o[i] = m[i] & m[i - 1] & m[i + 1] & m[i - w] & m[i + w];
  }
  return o;
}

function findLCDCandidates(G) {
  const { w, h, g } = G;
  const bl = boxBlur(g, w, h, 1);
  const mag = sobelMag(bl, w, h);
  const sorted = Float32Array.from(mag).sort();
  const cands = [];
  for (const pc of [0.70, 0.78, 0.85, 0.90]) for (const dil of [0, 1]) {
    const t = Math.max(12, sorted[Math.floor(pc * sorted.length)]);
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = mag[i] < t ? 1 : 0;
    if (dil) mask = erode(mask, w, h);
    const { lab, comps } = components(mask, w, h, w * h * 0.004);
    for (const c of comps) {
      if (c.touches) continue;
      const bbA = (c.maxx - c.minx + 1) * (c.maxy - c.miny + 1);
      if (bbA < w * h * 0.015 || bbA > w * h * 0.6) continue;
      const fa = filledArea(c, lab, w);
      const pts = []; for (const p of c.pix) pts.push([p % w, (p / w) | 0]);
      const H = convexHull(pts); const ha = polyArea(H);
      const q = hullToQuad(H); if (!q) continue;
      const qa = polyArea(q);
      cands.push({ pc, dil, t, area: c.area, filled: fa, frac: fa / (w * h), solidity: fa / Math.max(1, ha), inkFrac: 1 - c.area / Math.max(1, fa), quadFit: ha / Math.max(1, qa), quad: q, bbox: [c.minx, c.miny, c.maxx, c.maxy] });
    }
  }
  return cands;
}



// ---------- plano B: localizar o visor pelos próprios segmentos ----------
function locateByInk(img, P, size) {
  const G = toGray(img, size || 800);
  const { w, h, g } = G;
  const r = Math.max(4, Math.round(Math.max(w, h) * 0.008));
  const bg = boxBlur(maxFilter(boxBlur(g, w, h, 1), w, h, r), w, h, r);
  const D = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) D[i] = Math.max(0, bg[i] - g[i]);
  const s = Float32Array.from(D).sort();
  const th = Math.max(14, 0.35 * s[Math.floor(0.995 * s.length)]);
  const m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) m[i] = D[i] > th ? 1 : 0;
  const { comps } = components(m, w, h, 6);
  const segs = [];
  for (const c of comps) {
    if (c.area > w * h * 0.01) continue;
    let mx = 0, my = 0; for (const p of c.pix) { mx += p % w; my += (p / w) | 0; } mx /= c.area; my /= c.area;
    let sxx = 0, syy = 0, sxy = 0; for (const p of c.pix) { const dx = p % w - mx, dy = ((p / w) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    sxx /= c.area; syy /= c.area; sxy /= c.area;
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-3, tr / 2 - disc);
    if (l1 / l2 < 5) continue;
    const len = 4 * Math.sqrt(l1); if (len < 5 || len > Math.max(w, h) * 0.25) continue;
    segs.push({ x: mx, y: my, len, th: 0.5 * Math.atan2(2 * sxy, sxx - syy), c });
  }
  if (segs.length < 6) return [];
  // agrupamento por proximidade (ligação simples)
  const n = segs.length, grp = new Int32Array(n).fill(-1); let best = [];
  for (let i = 0; i < n; i++) {
    if (grp[i] >= 0) continue; const q = [i]; grp[i] = i; const mem = [];
    while (q.length) {
      const a = q.pop(); mem.push(a);
      for (let b = 0; b < n; b++) if (grp[b] < 0) {
        const d = Math.hypot(segs[a].x - segs[b].x, segs[a].y - segs[b].y);
        if (d < 1.6 * Math.max(segs[a].len, segs[b].len) && segs[b].len < 2.5 * segs[a].len && segs[a].len < 2.5 * segs[b].len) { grp[b] = i; q.push(b); }
      }
    }
    if (mem.length > best.length) best = mem;
  }
  if (best.length < 6) return [];
  const S = best.map(i => segs[i]);
  // duas direções dominantes (k-means em ângulo mod pi)
  let a0 = S.reduce((m, x) => x.len > m.len ? x : m, S[0]).th, a1 = a0 + Math.PI / 2;
  const adiff = (a, b) => { let d = (a - b) % Math.PI; if (d < -Math.PI / 2) d += Math.PI; if (d > Math.PI / 2) d -= Math.PI; return d; };
  for (let it = 0; it < 6; it++) {
    let s0 = 0, n0 = 0, s1 = 0, n1 = 0;
    for (const x of S) { const d0 = adiff(x.th, a0), d1 = adiff(x.th, a1); if (Math.abs(d0) < Math.abs(d1)) { s0 += d0 * x.len; n0 += x.len; } else { s1 += d1 * x.len; n1 += x.len; } }
    if (n0) a0 += s0 / n0; if (n1) a1 += s1 / n1;
  }
  const quads = [];
  const aspect = P.lcdAspect || 0.75; // largura/altura física do visor expandido
  for (const [ha, va] of [[a0, a1], [a1, a0]]) {
    const U = [Math.cos(ha), Math.sin(ha)], V = [Math.cos(va), Math.sin(va)];
    // garantir V "para baixo" de forma consistente não é necessário: as 4 rotações são testadas depois
    const det = U[0] * V[1] - U[1] * V[0]; if (Math.abs(det) < 0.3) continue;
    const toUV = (x, y) => [(x * V[1] - y * V[0]) / det, (U[0] * y - U[1] * x) / det];
    let umin = 1e9, umax = -1e9, vmin = 1e9, vmax = -1e9;
    for (const sg of S) for (const p of sg.c.pix) { const [uu, vv] = toUV(p % w, (p / w) | 0); if (uu < umin) umin = uu; if (uu > umax) umax = uu; if (vv < vmin) vmin = vv; if (vv > vmax) vmax = vv; }
    // altura da tinta corresponde a ~[0.14, 0.98] do visor
    const Hl = (vmax - vmin) / 0.84, Wl = Hl * aspect;
    for (const flip of [false, true]) {
      const v0 = flip ? vmax + 0.02 * Hl : vmin - 0.14 * Hl, dv = flip ? -Hl : Hl;
      const u0 = flip ? umin - 0.13 * Wl : umax + 0.13 * Wl, du = flip ? Wl : -Wl; // borda direita do visor ~0.87 + margem
      const corners = [[u0 + du, v0], [u0, v0], [u0, v0 + dv], [u0 + du, v0 + dv]]; // TL,TR,BR,BL no referencial do visor
      const q = corners.map(([uu, vv]) => [(uu * U[0] + vv * V[0]) / G.scale, (uu * U[1] + vv * V[1]) / G.scale]);
      quads.push(expandQuad(orderQuad(q), 1.2));
    }
  }
  return quads;
}

// ---------- pipeline completo ----------
function dedupe(cands) {
  const u = [];
  for (const k of cands.sort((a, b) => b.filled - a.filled)) {
    if (!u.some(v => Math.abs(v.bbox[0] - k.bbox[0]) < 4 && Math.abs(v.bbox[1] - k.bbox[1]) < 4 && Math.abs(v.bbox[2] - k.bbox[2]) < 4 && Math.abs(v.bbox[3] - k.bbox[3]) < 4)) u.push(k);
  }
  return u;
}
function goodCands(G) {
  return dedupe(findLCDCandidates(G).filter(c => c.solidity > 0.85 && c.quadFit < 1.3));
}
function expandQuad(q, f) {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  return q.map(p => [cx + (p[0] - cx) * f, cy + (p[1] - cy) * f]);
}

// img: {width,height,data RGBA}. Retorna melhor leitura.
function readImage(img, opts) {
  opts = opts || {};
  const P = opts.profile || PROFILE_HEM7122;
  const T = P._tpl || (P._tpl = buildTemplate(P));
  const G = toGray(img, opts.detectSize || 400);
  let quads = opts.onlyQuads ? [] : goodCands(G).slice(0, opts.maxCands || 8).map(c => orderQuad(c.quad).map(p => [p[0] / G.scale, p[1] / G.scale]));
  // segunda etapa: procurar visor dentro de cada candidato (ex.: quando só achou o painel)
  let frontier = quads.slice();
  if (opts.onlyQuads) { quads = opts.onlyQuads.slice(); frontier = []; }
  for (let depth = 0; depth < 2; depth++) {
    const inner = [];
    for (const q of frontier) {
      const W = 160, H = 200;
      const t = warpGray(img, q, W, H);
      const Hm = homography([[0, 0], [W, 0], [W, H], [0, H]], q);
      for (const c of goodCands({ w: W, h: H, g: t }).slice(0, 3)) {
        if (c.frac > 0.85 || c.frac < 0.08) continue;
        inner.push(orderQuad(c.quad).map(p => applyH(Hm, p[0], p[1])));
      }
    }
    quads = quads.concat(inner); frontier = inner;
  }
  if (opts.extraQuads) quads = opts.extraQuads.concat(quads);
  const W = P.W, H = P.H;
  let best = null; const tried = [];
  // etapa 1: triagem rápida em meia resolução de todos os candidatos x orientações
  const pre = [];
  const wideSearch = !!opts.onlyQuads && !opts.narrow;
  for (const q0 of quads) {
    const qe = opts.noExpand ? q0 : expandQuad(q0, P.expand);
    for (let r = 0; r < (opts.noExpand ? 1 : 4); r++) {
      const q = [qe[r % 4], qe[(r + 1) % 4], qe[(r + 2) % 4], qe[(r + 3) % 4]];
      if (quads.length * (opts.noExpand ? 1 : 4) <= 2) { pre.push({ q, s: 0 }); continue; }
      const t2 = warpGray(img, q, W, H), D2 = inkMap(t2, W, H);
      const al2 = align(D2, W, H, T, wideSearch, true);
      let md = 0; for (let i = 0; i < D2.length; i += 3) md += D2[i]; md /= Math.ceil(D2.length / 3);
      pre.push({ q, s: al2.score / (md + 3), t: t2, D: D2 });
    }
  }
  pre.sort((a, b) => b.s - a.s);
  // etapa 2: análise completa só dos melhores
  for (const pr of pre.slice(0, opts.topK || 4)) {
    const q = pr.q;
    const t = pr.t || warpGray(img, q, W, H);
    const D = pr.D || inkMap(t, W, H);
    const al = align(D, W, H, T, wideSearch);
    const rc = refineCorners(D, W, H, T, al.p);
    al.corners = rc.C;
    const dec = decodeAligned(t, D, W, H, T, P, makeXfH(rc.C));
    const score = rc.score;
    const rec = { quad: q, align: al, ...dec, score };
    tried.push(rec);
    if (!best || (rec.ok && !best.ok) || (rec.ok === best.ok && score > best.score)) best = rec;
  }
  // polimento: re-retifica usando os cantos do gabarito encontrados (remove perspectiva residual)
  const polish = (rec) => {
    let cur = rec;
    for (let it = 0; it < 2 && cur && !opts.noPolish; it++) {
      if (cur.ok && cur.minMargin > 0.35) break;
      const Hq = homography([[0, 0], [W, 0], [W, H], [0, H]], cur.quad);
      const nq = cur.align.corners.map(c => applyH(Hq, c[0], c[1]));
      const r2 = readImage(img, Object.assign({}, opts, { onlyQuads: [nq], noExpand: true, noInkFallback: true, noPolish: true, narrow: true }));
      const b2 = r2.best; tried.push(...r2.tried);
      if (b2 && ((b2.ok && !cur.ok) || (b2.ok === cur.ok && b2.score >= cur.score * 0.98 && (b2.ok ? b2.minMargin >= cur.minMargin : true)))) cur = b2; else break;
    }
    return cur;
  };
  if (!opts.noPolish && best && !opts.onlyQuads) best = polish(best);
  if ((!best || !best.ok) && !opts.noInkFallback) {
    const iq = locateByInk(img, P);
    if (iq.length) {
      const r2 = readImage(img, Object.assign({}, opts, { noInkFallback: true, onlyQuads: iq }));
      tried.push(...r2.tried);
      const pb = r2.best ? polish(r2.best) : null;
      if (pb && (!best || (pb.ok && !best.ok) || (pb.ok === best.ok && pb.score > best.score))) best = pb;
    }
  }
  return { best, tried };
}


// ---------- modo ao vivo: rastreamento + votação entre quadros ----------
function templateQuadOf(rec, P) {
  const Hq = homography([[0, 0], [P.W, 0], [P.W, P.H], [0, P.H]], rec.quad);
  return rec.align.corners.map(c => applyH(Hq, c[0], c[1]));
}
function createTracker(opts) {
  opts = Object.assign({ needConfident: 3, needLow: 5, maxMisses: 3, history: 10 }, opts || {});
  const P = opts.profile || PROFILE_HEM7122;
  let lock = null, misses = 0, hist = [];
  function vote() {
    // aceita quando o mesmo valor aparece N vezes na janela recente, sem nenhuma leitura divergente no meio
    const last = [...hist].reverse().find(e => e);
    if (!last) return null;
    let n = 0, allConf = true;
    for (let i = hist.length - 1; i >= 0; i--) {
      const e = hist[i]; if (!e) continue;
      if (e.key !== last.key) break;
      n++; if (!e.confident) allConf = false;
    }
    const need = allConf ? opts.needConfident : opts.needLow;
    return { values: last.values, frames: n, need, confident: allConf, done: n >= need };
  }
  return {
    get locked() { return !!lock; },
    reset() { lock = null; misses = 0; hist = []; },
    process(img) {
      const t0 = Date.now(); let r = null, mode;
      if (lock) {
        mode = 'rastreio';
        r = readImage(img, { profile: P, onlyQuads: [lock], noExpand: true, narrow: true, noInkFallback: true, noPolish: true, topK: 1 }).best;
        if (!r || !r.ok) { misses++; if (misses >= opts.maxMisses) { lock = null; misses = 0; } }
      }
      if (!r || (!r.ok && !lock)) {
        mode = 'busca';
        r = readImage(img, { profile: P }).best;
      }
      if (r && r.ok) { lock = templateQuadOf(r, P); misses = 0; }
      const entry = r && r.ok ? { key: [r.values.sys, r.values.dia, r.values.pulse].join('/'), values: r.values, confident: r.confident } : null;
      hist.push(entry); if (hist.length > opts.history) hist.shift();
      return { mode, ms: Date.now() - t0, reading: r && r.ok ? { values: r.values, confident: r.confident } : null, vote: vote(), quad: r ? r.quad : null };
    }
  };
}

const api = { createTracker, templateQuadOf, maxFilter, alignScore, scoreAffine, flats, affineOf, refineRows, makeXfH, refineCorners, locateByInk, segContrasts, makeXf, sampleBilinear, readImage, PROFILE_HEM7122, buildTemplate, inkMap, align, decodeAligned, expandQuad, goodCands, homography, applyH, orderQuad, warpGray, sobelMag, toGray, boxBlur, components, convexHull, hullToQuad, polyArea, findLCDCandidates };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BPEngine = api;
})(typeof self !== 'undefined' ? self : this);
