'use strict';
// Pressão — registro de pressão arterial com leitura do visor pela câmera
const APP_VERSION = '1.3.0';
const DEVICE_ID = 'omron-hem7122';

// ====================== utilidades ======================
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function toLocalInput(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fromLocalInput(s) { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || ''); if (!m) return NaN; return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime(); }
const fmtHora = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function fmtDia(ms) {
  const d = new Date(ms), hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const d0 = new Date(d); d0.setHours(0, 0, 0, 0);
  const diff = Math.round((hoje - d0) / 86400000);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  return `${DIAS[d.getDay()][0].toUpperCase() + DIAS[d.getDay()].slice(1)}, ${d.getDate()} de ${MESES[d.getMonth()]}${d.getFullYear() !== hoje.getFullYear() ? ' de ' + d.getFullYear() : ''}`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
function toast(msg, ms = 2600) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
function dialog({ title, text, detail, buttons }) {
  return new Promise((resolve) => {
    const f = document.createElement('div'); f.className = 'fundo';
    f.innerHTML = `<div class="dialogo" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t"><h3 id="dlg-t">${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${detail ? `<pre>${esc(detail)}</pre>` : ''}<div class="botoes"></div></div>`;
    const box = f.querySelector('.botoes');
    buttons.forEach((b, i) => {
      const el = document.createElement('button'); el.className = 'btn ' + (b.cls || 'btn-sec'); el.textContent = b.label;
      el.onclick = () => { f.remove(); resolve(b.value); }; box.appendChild(el); if (i === buttons.length - 1) setTimeout(() => el.focus(), 0);
    });
    $('#camada').appendChild(f);
  });
}

// ====================== banco de dados (IndexedDB) ======================
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open('pressao', 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('leituras')) {
          const st = db.createObjectStore('leituras', { keyPath: 'id' });
          st.createIndex('ts', 'ts');
        }
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => { dbp = null; rej(rq.error || new Error('Falha ao abrir o banco de dados')); };
      rq.onblocked = () => rej(new Error('Banco de dados bloqueado por outra aba aberta do app'));
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((res, rej) => {
      const t = db.transaction('leituras', mode); const st = t.objectStore('leituras'); let out;
      Promise.resolve(fn(st, (v) => { out = v; })).catch(rej);
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error || new Error('Erro na transação'));
      t.onabort = () => rej(t.error || new Error('Transação cancelada'));
    }));
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    all: () => tx('readonly', (st, set) => req(st.getAll()).then((v) => set(v.sort((a, b) => b.ts - a.ts)))),
    get: (id) => tx('readonly', (st, set) => req(st.get(id)).then(set)),
    put: (rec) => tx('readwrite', (st) => { st.put(rec); }),
    del: (id) => tx('readwrite', (st) => { st.delete(id); }),
    putMany: (recs) => tx('readwrite', (st) => { for (const r of recs) st.put(r); }),
  };
})();

// ====================== números de visor (7 segmentos) ======================
const SEG_MAP = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abcf', 8: 'abcdefg', 9: 'abcdfg' };
function segPolys(W, H, t) {
  const g = t * 0.18, x0 = t / 2, x1 = W - t / 2, y0 = t / 2, ym = H / 2, y1 = H - t / 2;
  const hz = (cx, cy, L) => [[cx - L / 2, cy], [cx - L / 2 + t / 2, cy - t / 2], [cx + L / 2 - t / 2, cy - t / 2], [cx + L / 2, cy], [cx + L / 2 - t / 2, cy + t / 2], [cx - L / 2 + t / 2, cy + t / 2]];
  const vt = (cx, cy, L) => [[cx, cy - L / 2], [cx + t / 2, cy - L / 2 + t / 2], [cx + t / 2, cy + L / 2 - t / 2], [cx, cy + L / 2], [cx - t / 2, cy + L / 2 - t / 2], [cx - t / 2, cy - L / 2 + t / 2]];
  const Lh = x1 - x0 - 2 * g, Lv = ym - y0 - 2 * g;
  return { a: hz(W / 2, y0, Lh), g: hz(W / 2, ym, Lh), d: hz(W / 2, y1, Lh), f: vt(x0, (y0 + ym) / 2, Lv), b: vt(x1, (y0 + ym) / 2, Lv), e: vt(x0, (ym + y1) / 2, Lv), c: vt(x1, (ym + y1) / 2, Lv) };
}
function lcdSVG(value, nDigits, H, label) {
  const W = H * 0.56, t = H * 0.13, gap = H * 0.2, polys = segPolys(W, H, t);
  const str = value == null || Number.isNaN(value) ? '' : String(value);
  const chars = str.padStart(nDigits, ' ').slice(-nDigits);
  const total = nDigits * W + (nDigits - 1) * gap + H * 0.15;
  let body = '';
  for (let i = 0; i < nDigits; i++) {
    const on = chars[i] === ' ' ? '' : SEG_MAP[chars[i]];
    const ox = i * (W + gap) + H * 0.12;
    for (const s of 'abcdefg') {
      const pts = polys[s].map(([x, y]) => `${(x + ox).toFixed(1)},${y.toFixed(1)}`).join(' ');
      body += `<polygon points="${pts}" fill="${on.includes(s) ? 'var(--segmento)' : 'var(--fantasma)'}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${total.toFixed(1)} ${H}" width="${total.toFixed(0)}" height="${H}" role="img" aria-label="${esc(label || str)}"><g transform="skewX(-6) translate(${(H * 0.1).toFixed(1)} 0)">${body}</g></svg>`;
}

// ====================== tela inicial ======================
let registros = [];
async function carregar() {
  try { registros = await DB.all(); }
  catch (e) {
    registros = [];
    await dialog({ title: 'Não foi possível abrir suas leituras', text: 'O navegador recusou o acesso ao armazenamento do app. Seus dados não foram alterados. Feche outras abas deste app e tente de novo.', detail: String(e && e.message || e), buttons: [{ label: 'Entendi', value: 1, cls: 'btn-start' }] });
  }
  renderInicio();
}
function origemTxt(r) { return r.source === 'manual' ? 'Digitada' : r.source === 'foto' ? 'Lida de uma foto' : 'Lida pela câmera'; }
function renderInicio() {
  const u = registros[0];
  if (u) {
    $('#ultimo').innerHTML = `
      <div class="visor-rot"><b>SYS</b>mmHg</div><div class="visor-num">${lcdSVG(u.sys, 3, 58, `Sistólica ${u.sys}`)}</div>
      <div class="visor-rot"><b>DIA</b>mmHg</div><div class="visor-num">${lcdSVG(u.dia, 3, 58, `Diastólica ${u.dia}`)}</div>
      <div class="visor-rot"><b>Pulso</b>/min</div><div class="visor-num">${lcdSVG(u.pulse, 3, 32, `Pulso ${u.pulse}`)}</div>`;
    $('#ultimo-quando').textContent = `${fmtDia(u.ts)}, ${fmtHora(u.ts)}`;
    $('#ultimo-origem').textContent = origemTxt(u);
  } else {
    $('#ultimo').innerHTML = `<div class="visor-vazio">Nenhuma leitura ainda.<br>Toque em <b>Ler o aparelho</b> e aponte a câmera para o visor.</div>`;
    $('#ultimo-quando').textContent = ''; $('#ultimo-origem').textContent = '';
  }
  // gráfico simples das últimas 20 leituras
  const serie = registros.slice(0, 20).reverse();
  $('#bloco-grafico').hidden = serie.length < 2;
  if (serie.length >= 2) $('#grafico').innerHTML = graficoSVG(serie);
  // lista
  if (!registros.length) { $('#lista').innerHTML = `<p class="vazio">As leituras salvas aparecem aqui, da mais recente para a mais antiga.</p>`; return; }
  let html = '', diaAtual = '';
  for (const r of registros) {
    const dia = fmtDia(r.ts);
    if (dia !== diaAtual) { if (diaAtual) html += '</ul>'; html += `<div class="dia-titulo">${esc(dia)}</div><ul class="lista">`; diaAtual = dia; }
    const marcas = (r.source === 'manual' ? '<span class="marca">digitada</span>' : '') + (r.edited ? '<span class="marca">corrigida</span>' : '');
    html += `<li><button class="item" data-id="${esc(r.id)}"><span class="hora">${fmtHora(r.ts)}</span><span class="pa">${r.sys}/${r.dia}${marcas}</span><span class="pul">${r.pulse} bpm</span></button></li>`;
  }
  html += '</ul>';
  $('#lista').innerHTML = html;
}
function graficoSVG(s) {
  const W = 320, H = 150, L = 30, R = 8, T = 10, B = 22;
  let lo = Math.min(...s.map((r) => r.dia)), hi = Math.max(...s.map((r) => r.sys));
  lo = Math.floor((lo - 8) / 10) * 10; hi = Math.ceil((hi + 8) / 10) * 10;
  const X = (i) => L + (i * (W - L - R)) / (s.length - 1), Y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  let g = '';
  const passo = hi - lo > 80 ? 40 : 20;
  for (let v = Math.ceil(lo / passo) * passo; v <= hi; v += passo) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#E3E7E1"/><text x="${L - 6}" y="${Y(v) + 4}" font-size="10" text-anchor="end" fill="#6B757D">${v}</text>`;
  const linha = (k, cor) => `<polyline fill="none" stroke="${cor}" stroke-width="2.4" stroke-linejoin="round" points="${s.map((r, i) => `${X(i).toFixed(1)},${Y(r[k]).toFixed(1)}`).join(' ')}"/>` + s.map((r, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(r[k]).toFixed(1)}" r="3" fill="${cor}"/>`).join('');
  const d0 = new Date(s[0].ts), d1 = new Date(s[s.length - 1].ts);
  g += `<text x="${L}" y="${H - 6}" font-size="10" fill="#6B757D">${d0.getDate()}/${d0.getMonth() + 1}</text><text x="${W - R}" y="${H - 6}" font-size="10" text-anchor="end" fill="#6B757D">${d1.getDate()}/${d1.getMonth() + 1}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico das últimas ${s.length} leituras">${g}${linha('sys', 'var(--sys)')}${linha('dia', 'var(--dia)')}</svg>`;
}

// ====================== navegação ======================
let telaAtual = 'inicio';
function mostrar(nome, push = true) {
  for (const id of ['inicio', 'camera', 'conferir', 'painel']) $('#' + id).hidden = id !== nome && !(id === 'inicio' && nome === 'camera');
  if (nome !== 'camera') Camera.parar();
  if (push && nome !== 'inicio' && telaAtual === 'inicio') history.pushState({ tela: nome }, '');
  telaAtual = nome;
  window.scrollTo(0, 0);
}
function voltarInicio() { if (history.state && history.state.tela) history.back(); else mostrar('inicio', false); }
window.addEventListener('popstate', () => {
  if (telaAtual === 'inicio') return;
  // da conferência aberta a partir do painel, volta ao painel
  Camera.parar(); mostrar('inicio', false); carregar();
});

// ====================== worker de leitura ======================
const Leitor = (() => {
  let worker = null, seq = 0; const pend = new Map();
  let onResult = null;
  function get() {
    if (worker) return worker;
    worker = new Worker('worker.js');
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'result' && onResult) onResult(m);
      else if ((m.type === 'photo' || m.type === 'error') && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.type === 'error' ? p.rej(new Error(m.message)) : p.res(m); }
      else if (m.type === 'error' && onResult) onResult(m);
    };
    worker.onerror = (e) => { if (onResult) onResult({ type: 'error', message: e.message || 'Falha no leitor' }); };
    return worker;
  }
  return {
    frame(imgData, cb) { onResult = cb; const id = ++seq; get().postMessage({ type: 'frame', id, width: imgData.width, height: imgData.height, buffer: imgData.data.buffer }, [imgData.data.buffer]); },
    reset() { get().postMessage({ type: 'reset' }); },
    photo(imgData) { const id = ++seq; return new Promise((res, rej) => { pend.set(id, { res, rej }); get().postMessage({ type: 'photo', id, width: imgData.width, height: imgData.height, buffer: imgData.data.buffer }, [imgData.data.buffer]); }); },
  };
})();

// ====================== câmera ======================
const Camera = (() => {
  let stream = null, ativo = false, ocupado = false, inicio = 0, escala = 1, ultimoQuad = null, lanterna = false;
  const video = $('#video'), overlay = $('#overlay'), frameCv = document.createElement('canvas');
  const status = (html) => { $('#cam-status').innerHTML = html; };
  async function abrir() {
    mostrar('camera');
    $('#cam-erro').hidden = true; $('#guia').hidden = false; ultimoQuad = null; desenhar();
    status('Abrindo a câmera…');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return erro('Este navegador não dá acesso à câmera. Abra o app pelo endereço https ou use "Digitar os valores".');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      const negado = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      return erro(negado ? 'O acesso à câmera foi negado. Libere a câmera para este site nas configurações do navegador, ou digite os valores.' : 'Não foi possível abrir a câmera (' + (e && e.name || 'erro') + ').');
    }
    if (telaAtual !== 'camera') { parar(); return; }
    video.srcObject = stream;
    try { await video.play(); } catch (_) { /* autoplay com muted costuma funcionar */ }
    const track = stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    $('#btn-lanterna').hidden = !caps.torch;
    Leitor.reset(); ativo = true; ocupado = false; inicio = performance.now();
    status('Procurando o visor…');
    laco();
  }
  function erro(msg) {
    ativo = false;
    $('#guia').hidden = true;
    $('#cam-erro').hidden = false;
    $('#cam-erro').innerHTML = `<div><p>${esc(msg)}</p><p><button class="btn btn-sec" id="btn-cam-foto">Ler de uma foto</button></p></div>`;
    $('#btn-cam-foto').onclick = () => $('#in-foto').click();
    status('Câmera indisponível');
  }
  function laco() {
    if (!ativo) return;
    if (!ocupado && video.readyState >= 2 && video.videoWidth) {
      const vw = video.videoWidth, vh = video.videoHeight;
      escala = Math.min(1, 1280 / Math.max(vw, vh));
      frameCv.width = Math.round(vw * escala); frameCv.height = Math.round(vh * escala);
      const cx = frameCv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(video, 0, 0, frameCv.width, frameCv.height);
      const img = cx.getImageData(0, 0, frameCv.width, frameCv.height);
      ocupado = true;
      Leitor.frame(img, resultado);
    }
    requestAnimationFrame(laco);
  }
  function resultado(m) {
    ocupado = false;
    if (!ativo) return;
    if (m.type === 'error') { status('Erro no leitor. Tente de novo.'); return; }
    ultimoQuad = m.lockQuad; desenhar();
    $('#guia').hidden = !!m.lockQuad;
    if (m.done) {
      ativo = false;
      if (navigator.vibrate) navigator.vibrate(60);
      const d = m.done;
      Conferir.nova({ values: d.values, confident: d.confident, crop: d.crop, source: 'camera' });
      return;
    }
    if (m.reading && m.vote) {
      const n = Math.min(m.vote.frames, m.vote.need);
      status(`Lendo ${m.reading.values.sys}/${m.reading.values.dia}<span class="cam-pontos">${Array.from({ length: m.vote.need }, (_, i) => `<span class="${i < n ? 'on' : ''}"></span>`).join('')}</span>`);
    } else {
      const t = performance.now() - inicio;
      status(t > 5000 ? 'Aproxime o celular e evite reflexo no visor' : 'Procurando o visor…');
    }
  }
  function desenhar() {
    const cw = overlay.clientWidth, ch = overlay.clientHeight; if (!cw) return;
    if (overlay.width !== cw * devicePixelRatio) { overlay.width = cw * devicePixelRatio; overlay.height = ch * devicePixelRatio; }
    const c = overlay.getContext('2d'); c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); c.clearRect(0, 0, cw, ch);
    if (!ultimoQuad || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    c.beginPath();
    ultimoQuad.forEach(([x, y], i) => { const X = (x / escala) * s + ox, Y = (y / escala) * s + oy; i ? c.lineTo(X, Y) : c.moveTo(X, Y); });
    c.closePath(); c.lineWidth = 3; c.strokeStyle = '#E4A11B'; c.stroke();
  }
  function parar() {
    ativo = false; ocupado = false;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null; lanterna = false;
  }
  async function alternarLanterna() {
    const track = stream && stream.getVideoTracks()[0]; if (!track) return;
    lanterna = !lanterna;
    try { await track.applyConstraints({ advanced: [{ torch: lanterna }] }); } catch (_) { lanterna = !lanterna; }
  }
  return { abrir, parar, alternarLanterna };
})();

// ====================== conferir / editar ======================
const Conferir = (() => {
  let ctx = null; // { modo, source, confident, lidos, registro }
  const campos = { sys: $('#in-sys'), dia: $('#in-dia'), pulse: $('#in-pul') };
  function preencher(v) { campos.sys.value = v && v.sys != null && !Number.isNaN(v.sys) ? v.sys : ''; campos.dia.value = v && v.dia != null && !Number.isNaN(v.dia) ? v.dia : ''; campos.pulse.value = v && v.pulse != null && !Number.isNaN(v.pulse) ? v.pulse : ''; }
  function limparErros() { for (const id of ['c-sys', 'c-dia', 'c-pul', 'c-data']) { $('#' + id).classList.remove('erro'); $('#' + id + ' .msg-erro').hidden = true; } }
  function marcarErro(id, msg) { $('#' + id).classList.add('erro'); const e = $('#' + id + ' .msg-erro'); e.textContent = msg; e.hidden = false; }
  function desenharRecorte(crop) {
    const cv = $('#recorte');
    if (!crop) { cv.hidden = true; return; }
    cv.hidden = false; cv.width = crop.w; cv.height = crop.h;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(crop.data), crop.w, crop.h), 0, 0);
  }
  function abrirTela() {
    limparErros();
    $('.conf-grade').style.gridTemplateColumns = $('#recorte').hidden ? '1fr' : '';
    mostrar('conferir', telaAtual === 'inicio');
  }
  function nova({ values, confident, crop, source, falhou }) {
    ctx = { modo: 'nova', source, confident: !!confident, lidos: values ? { ...values } : null };
    $('#conf-titulo').textContent = source === 'manual' ? 'Nova leitura' : 'Confira a leitura';
    preencher(values);
    $('#in-data').value = toLocalInput(Date.now());
    desenharRecorte(crop);
    const av = $('#conf-aviso');
    if (falhou) { av.hidden = false; av.textContent = 'Não consegui ler o visor nesta imagem. Digite os valores ou tente outra foto, de frente e sem reflexo.'; }
    else if (source !== 'manual' && !confident) { av.hidden = false; av.textContent = 'Parte do visor estava com reflexo. Compare os números com o aparelho antes de salvar.'; }
    else av.hidden = true;
    $('#btn-reler').hidden = source === 'manual';
    $('#btn-reler').textContent = source === 'foto' ? 'Escolher outra foto' : 'Ler novamente';
    $('#btn-excluir').hidden = true;
    $('#btn-salvar').textContent = 'Salvar';
    abrirTela();
    if (source === 'manual' || falhou) setTimeout(() => campos.sys.focus(), 50);
  }
  function editar(reg) {
    ctx = { modo: 'editar', source: reg.source, confident: reg.confident, lidos: reg.read || null, registro: reg };
    $('#conf-titulo').textContent = 'Editar leitura';
    preencher(reg);
    $('#in-data').value = toLocalInput(reg.ts);
    desenharRecorte(null);
    $('#conf-aviso').hidden = true;
    $('#btn-reler').hidden = true;
    $('#btn-excluir').hidden = false;
    $('#btn-salvar').textContent = 'Salvar alterações';
    abrirTela();
  }
  function validar() {
    limparErros();
    const n = (el) => (el.value.trim() === '' ? NaN : Number(el.value));
    const v = { sys: n(campos.sys), dia: n(campos.dia), pulse: n(campos.pulse) };
    let ok = true;
    const faixa = (k, id, min, max, nome) => {
      if (!Number.isInteger(v[k])) { marcarErro(id, `Informe a ${nome} (número inteiro).`); ok = false; }
      else if (v[k] < min || v[k] > max) { marcarErro(id, `Valor fora do intervalo aceito (${min} a ${max}).`); ok = false; }
    };
    faixa('sys', 'c-sys', 50, 280, 'sistólica'); faixa('dia', 'c-dia', 30, 200, 'diastólica'); faixa('pulse', 'c-pul', 30, 240, 'pulsação');
    if (ok && v.dia >= v.sys) { marcarErro('c-dia', 'A diastólica precisa ser menor que a sistólica.'); ok = false; }
    const ts = fromLocalInput($('#in-data').value);
    if (Number.isNaN(ts)) { marcarErro('c-data', 'Informe a data e a hora.'); ok = false; }
    else if (ts > Date.now() + 5 * 60000) { marcarErro('c-data', 'A data está no futuro.'); ok = false; }
    return ok ? { ...v, ts } : null;
  }
  async function salvar() {
    const v = validar(); if (!v) return;
    const agora = Date.now();
    let rec;
    if (ctx.modo === 'nova') {
      const lidos = ctx.lidos;
      rec = { id: uuid(), ts: v.ts, sys: v.sys, dia: v.dia, pulse: v.pulse, source: ctx.source, device: ctx.source === 'manual' ? null : DEVICE_ID,
        confident: ctx.source === 'manual' ? null : ctx.confident, read: lidos || null,
        edited: !!(lidos && (lidos.sys !== v.sys || lidos.dia !== v.dia || lidos.pulse !== v.pulse)), createdAt: agora, updatedAt: agora };
    } else {
      const r0 = ctx.registro;
      rec = { ...r0, ts: v.ts, sys: v.sys, dia: v.dia, pulse: v.pulse, updatedAt: agora };
      if (r0.read) rec.edited = r0.read.sys !== v.sys || r0.read.dia !== v.dia || r0.read.pulse !== v.pulse;
    }
    const btn = $('#btn-salvar'); btn.disabled = true;
    try {
      await DB.put(rec);
      const conf = await DB.get(rec.id); // confirma que foi gravado de verdade
      if (!conf || conf.sys !== rec.sys || conf.dia !== rec.dia || conf.pulse !== rec.pulse || conf.ts !== rec.ts) throw new Error('A leitura não foi encontrada no armazenamento depois de salvar.');
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      toast(ctx.modo === 'nova' ? 'Leitura salva' : 'Alterações salvas');
      voltarInicio(); await carregar();
    } catch (e) {
      await dialog({ title: 'A leitura NÃO foi salva', text: 'Os valores continuam na tela. Tente salvar de novo; se o erro continuar, anote os números e exporte um backup pelo menu.', detail: String(e && e.message || e), buttons: [{ label: 'Voltar aos valores', value: 1, cls: 'btn-start' }] });
    } finally { btn.disabled = false; }
  }
  async function excluir() {
    const ok = await dialog({ title: 'Excluir esta leitura?', text: `${ctx.registro.sys}/${ctx.registro.dia}, pulso ${ctx.registro.pulse}, em ${fmtDia(ctx.registro.ts)} às ${fmtHora(ctx.registro.ts)}. Isso não pode ser desfeito.`, buttons: [{ label: 'Cancelar', value: false }, { label: 'Excluir', value: true, cls: 'btn-perigo' }] });
    if (!ok) return;
    try {
      await DB.del(ctx.registro.id);
      if (await DB.get(ctx.registro.id)) throw new Error('A leitura continua no armazenamento.');
      toast('Leitura excluída'); voltarInicio(); await carregar();
    } catch (e) {
      await dialog({ title: 'Não foi possível excluir', detail: String(e && e.message || e), buttons: [{ label: 'Ok', value: 1, cls: 'btn-start' }] });
    }
  }
  function reler() {
    if (ctx.source === 'foto') { $('#in-foto').click(); return; }
    Leitor.reset(); Camera.abrir();
  }
  return { nova, editar, salvar, excluir, reler };
})();

// ====================== foto da galeria ======================
async function lerFoto(file) {
  if (!file) return;
  toast('Lendo a foto…', 1800);
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0, cv.width, cv.height);
    const r = await Leitor.photo(cx.getImageData(0, 0, cv.width, cv.height));
    Conferir.nova({ values: r.ok ? r.values : null, confident: r.confident, crop: r.ok ? r.crop : null, source: 'foto', falhou: !r.ok });
  } catch (e) {
    await dialog({ title: 'Não foi possível abrir a foto', detail: String(e && e.message || e), buttons: [{ label: 'Ok', value: 1, cls: 'btn-start' }] });
  } finally { $('#in-foto').value = ''; }
}

// ====================== backup ======================
function baixar(nome, tipo, conteudo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const hojeStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
async function exportarJSON() {
  const all = await DB.all();
  baixar(`pressao-backup-${hojeStr()}.json`, 'application/json', JSON.stringify({ app: 'pressao', versao: APP_VERSION, exportadoEm: new Date().toISOString(), leituras: all }, null, 1));
  toast(`${plural(all.length, 'leitura exportada', 'leituras exportadas')}`);
}
async function exportarCSV() {
  const all = await DB.all();
  const linhas = ['data;hora;sistolica;diastolica;pulso;origem;corrigida'];
  for (const r of all.slice().reverse()) { const d = new Date(r.ts); linhas.push(`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()};${fmtHora(r.ts)};${r.sys};${r.dia};${r.pulse};${r.source};${r.edited ? 'sim' : 'não'}`); }
  baixar(`pressao-${hojeStr()}.csv`, 'text/csv;charset=utf-8', '\ufeff' + linhas.join('\r\n'));
  toast(`${plural(all.length, 'leitura exportada', 'leituras exportadas')}`);
}
function validarRegistro(r) {
  const int = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
  return r && typeof r.id === 'string' && r.id && Number.isFinite(r.ts) && int(r.sys, 50, 280) && int(r.dia, 30, 200) && int(r.pulse, 30, 240) && r.dia < r.sys;
}
async function importar(file) {
  if (!file) return;
  try {
    const dados = JSON.parse(await file.text());
    const lista = Array.isArray(dados) ? dados : dados && dados.leituras;
    if (!Array.isArray(lista)) throw new Error('O arquivo não é um backup deste app.');
    const validos = lista.filter(validarRegistro), invalidos = lista.length - validos.length;
    const atuais = new Map((await DB.all()).map((r) => [r.id, r]));
    const gravar = []; let novos = 0, atualizados = 0, iguais = 0;
    for (const r of validos) {
      const a = atuais.get(r.id);
      if (!a) { gravar.push(r); novos++; }
      else if ((r.updatedAt || 0) > (a.updatedAt || 0)) { gravar.push(r); atualizados++; }
      else iguais++;
    }
    const ok = await dialog({ title: 'Importar backup?', text: `${plural(novos, 'leitura nova', 'leituras novas')}, ${plural(atualizados, 'atualizada', 'atualizadas')}, ${plural(iguais, 'já existente', 'já existentes')}${invalidos ? `, ${plural(invalidos, 'ignorada', 'ignoradas')} por estar incompleta` : ''}. Nenhuma leitura atual será apagada.`, buttons: [{ label: 'Cancelar', value: false }, { label: 'Importar', value: true, cls: 'btn-start' }] });
    if (!ok) return;
    await DB.putMany(gravar);
    const depois = new Set((await DB.all()).map((r) => r.id));
    const faltando = gravar.filter((r) => !depois.has(r.id)).length;
    if (faltando) throw new Error(`${faltando} leituras não foram gravadas.`);
    toast(gravar.length ? plural(gravar.length, 'leitura importada', 'leituras importadas') : 'Nada novo para importar'); await carregar();
  } catch (e) {
    await dialog({ title: 'O backup não foi importado', text: 'Suas leituras atuais não foram alteradas.', detail: String(e && e.message || e), buttons: [{ label: 'Ok', value: 1, cls: 'btn-start' }] });
  } finally { $('#in-backup').value = ''; }
}

// ====================== menu ======================
function abrirMenu() {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const f = document.createElement('div'); f.className = 'fundo';
  f.innerHTML = `<div class="folha" role="menu">
    <button data-a="json" role="menuitem">Exportar backup (JSON)</button>
    <button data-a="csv" role="menuitem">Exportar planilha (CSV)</button>
    <button data-a="imp" role="menuitem">Importar backup</button>
    <div class="versao">Versão ${APP_VERSION} · leitor para Omron HEM-7122</div></div>`;
  f.onclick = async (ev) => {
    const a = ev.target.dataset && ev.target.dataset.a;
    if (ev.target === f || a) f.remove();
    try {
      if (a === 'json') await exportarJSON();
      else if (a === 'csv') await exportarCSV();
      else if (a === 'imp') $('#in-backup').click();
    } catch (e) { dialog({ title: 'Não foi possível exportar', detail: String(e && e.message || e), buttons: [{ label: 'Ok', value: 1, cls: 'btn-start' }] }); }
  };
  $('#camada').appendChild(f);
  f.querySelector('button').focus();
}


// ====================== painel (dashboard) ======================
const Painel = (() => {
  const DIA_MS = 86400000;
  const st = { periodo: 'semana', ancora: null, modo: 'valores', pulso: true, sel: null, itens: [] };
  const inicioDia = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDias = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  const chaveDia = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const media = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);

  function janela(periodo, ancora) {
    if (periodo === 'dia') { const i = inicioDia(ancora); return { ini: i, fim: addDias(i, 1) }; }
    if (periodo === 'semana') { const f = addDias(inicioDia(ancora), 1); return { ini: addDias(f, -7), fim: f }; }
    const d = new Date(ancora); return { ini: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), fim: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
  }
  function rotulo(periodo, j) {
    const a = new Date(j.ini), b = new Date(j.fim - 1);
    if (periodo === 'dia') return fmtDia(j.ini);
    if (periodo === 'semana') return a.getMonth() === b.getMonth() ? `${a.getDate()} a ${b.getDate()} de ${MESES[b.getMonth()]}` : `${a.getDate()} de ${MESES[a.getMonth()]} a ${b.getDate()} de ${MESES[b.getMonth()]}`;
    return `${MESES_LONGOS[a.getMonth()][0].toUpperCase() + MESES_LONGOS[a.getMonth()].slice(1)} de ${a.getFullYear()}`;
  }
  // itens do gráfico/lista: leituras individuais (dia, semana) ou médias diárias (mês)
  function montarItens() {
    const asc = registros.slice().sort((x, y) => x.ts - y.ts);
    const j = janela(st.periodo, st.ancora);
    let todos;
    if (st.periodo === 'mes') {
      const grupos = new Map();
      for (const r of asc) { const k = chaveDia(r.ts); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(r); }
      todos = [...grupos.entries()].map(([k, rs]) => ({ id: 'd-' + k, ts: inicioDia(rs[0].ts) + DIA_MS / 2, sys: media(rs.map((r) => r.sys)), dia: media(rs.map((r) => r.dia)), pulse: media(rs.map((r) => r.pulse)), n: rs.length }));
    } else todos = asc.map((r) => ({ id: r.id, ts: r.ts, sys: r.sys, dia: r.dia, pulse: r.pulse, n: 1, rec: r }));
    todos.forEach((it, i) => { it.prev = i > 0 ? todos[i - 1] : null; });
    const dentro = todos.filter((it) => it.ts >= j.ini && it.ts < j.fim);
    const antes = asc.filter((r) => r.ts >= j.ini - (j.fim - j.ini) && r.ts < j.ini);
    const noPeriodo = asc.filter((r) => r.ts >= j.ini && r.ts < j.fim);
    return { j, itens: dentro, noPeriodo, antes };
  }
  // ---------- variação ----------
  function delta(v, ant, cls) {
    if (ant == null) return '';
    const d = v - ant;
    const tipo = d > 0 ? 'sobe' : d < 0 ? 'desce' : 'igual';
    const seta = d > 0 ? '▲' : d < 0 ? '▼' : '=';
    const txt = d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0';
    const fala = d > 0 ? `subiu ${d}` : d < 0 ? `caiu ${-d}` : 'igual';
    return `<span class="delta ${tipo} ${cls || ''}" aria-label="${fala}"><span class="seta">${seta}</span>${txt}</span>`;
  }
  // ---------- resumo ----------
  function resumo(noPeriodo, antes) {
    if (!noPeriodo.length) return '';
    const m = (arr, k) => media(arr.map((r) => r[k]));
    const nomeAnt = st.periodo === 'dia' ? 'dia anterior' : st.periodo === 'semana' ? 'semana anterior' : 'mês anterior';
    const card = (nome, k) => {
      const v = m(noPeriodo, k), a = antes.length ? m(antes, k) : null;
      return `<div class="card"><span>${nome}</span><b>${v}</b><em>${a == null ? `<span class="delta igual">sem ${nomeAnt}</span>` : delta(v, a) + `<span class="vs">vs ${nomeAnt}</span>`}</em></div>`;
    };
    return `<p class="pn-media">Médias de ${plural(noPeriodo.length, 'leitura', 'leituras')}</p><div class="pn-cards">` + card('Sistólica', 'sys') + card('Diastólica', 'dia') + card('Pulso', 'pulse') + '</div>';
  }
  // ---------- gráfico ----------
  // Eixo X por "casas": cada leitura (ou média diária no mês) ocupa uma casa larga; dias sem leitura viram casas estreitas.
  // Se não couber na largura da tela, o gráfico rola na horizontal.
  const AX = 36, GH = 250, GT = 34, GB = 30;
  function casas(itens, j) {
    const cs = [];
    const porDia = new Map();
    for (const it of itens) { const k = chaveDia(it.ts); if (!porDia.has(k)) porDia.set(k, []); porDia.get(k).push(it); }
    if (st.periodo === 'dia') {
      for (const it of itens) cs.push({ it, w: 56, rot: fmtHora(it.ts), grupo: null });
    } else {
      for (let t = j.ini; t < j.fim; t = addDias(t, 1)) {
        const d = new Date(t), k = chaveDia(t), lst = porDia.get(k) || [];
        const rot = st.periodo === 'semana' && lst.length ? `${DIAS_CURTOS[d.getDay()]} ${d.getDate()}` : String(d.getDate());
        if (!lst.length) cs.push({ it: null, w: st.periodo === 'semana' ? 26 : 16, rot, grupo: k, dia: t });
        else lst.forEach((it) => cs.push({ it, w: st.periodo === 'semana' ? 50 : 42, rot, grupo: k, dia: t }));
      }
    }
    return cs;
  }
  const abrev = (v) => String(Math.floor(v / 10)); // 145 -> 14, 94 -> 9 (como se fala: "14 por 9")
  function grafico(itens, j) {
    const box = $('#pn-grafico');
    const disp = Math.max(260, (box.clientWidth || 340) - AX - 2);
    const cs = casas(itens, j);
    let total = cs.reduce((a, c) => a + c.w, 0) + 16;
    const f = total < disp ? disp / total : 1;
    cs.forEach((c) => { c.w *= f; });
    total = Math.max(disp, Math.round(total * f));
    let acc = 8 * f; cs.forEach((c) => { c.x = acc + c.w / 2; acc += c.w; });
    const ph = GH - GT - GB;
    let g = '', eixo = '', marcas = '', alvos = '';
    // rótulos do eixo X e divisórias entre dias
    if (st.periodo === 'dia') cs.forEach((c) => { g += `<text x="${c.x.toFixed(1)}" y="${GH - 9}" font-size="11" text-anchor="middle" fill="#6B757D">${c.rot}</text>`; });
    else {
      let i = 0;
      while (i < cs.length) {
        let k = i; while (k + 1 < cs.length && cs[k + 1].grupo === cs[i].grupo) k++;
        const x0 = cs[i].x - cs[i].w / 2, x1 = cs[k].x + cs[k].w / 2, xm = (x0 + x1) / 2;
        const temLeitura = cs.slice(i, k + 1).some((c) => c.it);
        if (st.periodo === 'semana' || temLeitura || new Date(cs[i].dia).getDate() % 5 === 1)
          g += `<text x="${xm.toFixed(1)}" y="${GH - 9}" font-size="${st.periodo === 'semana' ? 11 : 10.5}" text-anchor="middle" fill="${temLeitura ? '#3B4650' : '#A3ACB2'}" font-weight="${temLeitura ? 600 : 400}">${cs[i].rot}</text>`;
        if (i > 0) g += `<line x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${GT}" y2="${GT + ph}" stroke="#EDF0EB"/>`;
        i = k + 1;
      }
    }
    const comItem = cs.filter((c) => c.it);
    const svgEixo = (conteudo) => `<svg class="eixo" viewBox="0 0 ${AX} ${GH}" width="${AX}" height="${GH}" aria-hidden="true">${conteudo}</svg>`;
    if (!comItem.length) {
      g += `<text x="${total / 2}" y="${GT + ph / 2}" text-anchor="middle" font-size="13" fill="#6B757D">Nenhuma leitura neste período</text>`;
      return `<div class="gr-wrap">${svgEixo('')}<div class="gr-rolagem"><svg class="principal" viewBox="0 0 ${total} ${GH}" width="${total}" height="${GH}" role="img" aria-label="Gráfico vazio">${g}</svg></div></div>`;
    }
    const menorCasa = Math.min(...comItem.map((c) => c.w));
    const bw = Math.max(16, Math.min(26, menorCasa * 0.5));
    const raio = Math.max(12, bw / 2 + 2);
    if (st.modo === 'valores') {
      let lo = Math.min(...itens.map((it) => st.pulso ? Math.min(it.dia, it.pulse) : it.dia)), hi = Math.max(...itens.map((it) => st.pulso ? Math.max(it.sys, it.pulse) : it.sys));
      lo = Math.floor((lo - 12) / 10) * 10; hi = Math.ceil((hi + 12) / 10) * 10;
      const Y = (v) => GT + ((hi - v) * ph) / (hi - lo);
      const passo = hi - lo > 100 ? 40 : 20;
      for (let v = Math.ceil(lo / passo) * passo; v <= hi; v += passo) { g = `<line x1="0" x2="${total}" y1="${Y(v)}" y2="${Y(v)}" stroke="#E6EAE4"/>` + g; eixo += `<text x="${AX - 6}" y="${Y(v) + 3.5}" font-size="10" text-anchor="end" fill="#6B757D">${v}</text>`; }
      if (st.pulso && comItem.length > 1) g += `<polyline fill="none" stroke="var(--pulso)" stroke-width="1.6" stroke-dasharray="3 3" points="${comItem.map((c) => `${c.x.toFixed(1)},${Y(c.it.pulse).toFixed(1)}`).join(' ')}"/>`;
      for (const c of comItem) {
        const it = c.it, x = c.x, ys = Y(it.sys), yd = Y(it.dia), sel = it.id === st.sel;
        g += `<rect x="${(x - bw / 2).toFixed(1)}" y="${ys.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, yd - ys).toFixed(1)}" rx="${(bw / 2).toFixed(1)}" fill="${sel ? 'var(--ambar)' : 'rgba(46,50,114,0.20)'}"/>`;
        if (st.pulso) g += `<rect x="${(x - 4).toFixed(1)}" y="${(Y(it.pulse) - 4).toFixed(1)}" width="8" height="8" transform="rotate(45 ${x.toFixed(1)} ${Y(it.pulse).toFixed(1)})" fill="var(--pulso)" stroke="#fff" stroke-width="1"/>`;
        g += `<circle cx="${x.toFixed(1)}" cy="${ys.toFixed(1)}" r="${raio}" fill="var(--sys)" stroke="#fff" stroke-width="2"/><text class="num-sys" x="${x.toFixed(1)}" y="${(ys + 4).toFixed(1)}" font-size="12" font-weight="700" text-anchor="middle" fill="#fff">${abrev(it.sys)}</text>`;
        g += `<circle cx="${x.toFixed(1)}" cy="${yd.toFixed(1)}" r="${raio}" fill="var(--dia)" stroke="#fff" stroke-width="2"/><text class="num-dia" x="${x.toFixed(1)}" y="${(yd + 4).toFixed(1)}" font-size="12" font-weight="700" text-anchor="middle" fill="#fff">${abrev(it.dia)}</text>`;
      }
    } else {
      const ds = itens.filter((it) => it.prev).flatMap((it) => [it.sys - it.prev.sys, it.dia - it.prev.dia].concat(st.pulso ? [it.pulse - it.prev.pulse] : []));
      const m = Math.max(10, Math.ceil((Math.max(0, ...ds.map(Math.abs)) + 2) / 10) * 10);
      const Y = (v) => GT + ((m - v) * ph) / (2 * m);
      for (const v of [-m, -m / 2, 0, m / 2, m]) { const vv = Math.round(v); g = `<line x1="0" x2="${total}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? '#9AA4AB' : '#E6EAE4'}"/>` + g; eixo += `<text x="${AX - 6}" y="${Y(v) + 3.5}" font-size="10" text-anchor="end" fill="#6B757D">${vv > 0 ? '+' + vv : vv < 0 ? '−' + -vv : '0'}</text>`; }
      const nb = st.pulso ? 3 : 2, sb = Math.max(6, Math.min(12, (menorCasa * 0.75) / nb));
      for (const c of comItem) {
        const it = c.it, x = c.x;
        if (!it.prev) { g += `<circle cx="${x.toFixed(1)}" cy="${Y(0)}" r="4" fill="none" stroke="#9AA4AB" stroke-width="1.5"/>`; continue; }
        const vals = [it.sys - it.prev.sys, it.dia - it.prev.dia].concat(st.pulso ? [it.pulse - it.prev.pulse] : []);
        vals.forEach((d, k) => {
          const x0 = x - (nb * sb) / 2 + k * sb, y0 = Y(Math.max(0, d)), hh = Math.max(2, Math.abs(Y(d) - Y(0)));
          const cor = k === 2 ? 'var(--pulso)' : d > 0 ? 'var(--sobe)' : d < 0 ? 'var(--desce)' : '#9AA4AB';
          g += `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(sb - 1.5).toFixed(1)}" height="${hh.toFixed(1)}" rx="1.5" fill="${cor}" opacity="${k === 1 ? 0.65 : 1}"/>`;
        });
      }
    }
    // seleção: guia vertical + etiqueta
    const s = comItem.find((c) => c.it.id === st.sel);
    if (s) {
      const x = s.x, it = s.it, d = new Date(it.ts);
      marcas += `<line x1="${x}" x2="${x}" y1="${GT - 6}" y2="${GT + ph}" stroke="var(--ambar)" stroke-width="2" stroke-dasharray="4 3"/>`;
      const txt = st.periodo === 'mes' ? `${DIAS_CURTOS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} · média ${it.sys}/${it.dia}` : `${DIAS_CURTOS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${fmtHora(it.ts)} · ${it.sys}/${it.dia} · ${it.pulse}`;
      const tw = txt.length * 6.1 + 16, tx = Math.min(total - tw - 2, Math.max(2, x - tw / 2));
      marcas += `<rect x="${tx}" y="5" width="${tw}" height="21" rx="10.5" fill="var(--tinta)"/><text x="${tx + tw / 2}" y="19.5" font-size="11" text-anchor="middle" fill="#fff" font-weight="600">${esc(txt)}</text>`;
    }
    for (const c of comItem) alvos += `<circle class="alvo" data-id="${esc(c.it.id)}" cx="${c.x.toFixed(1)}" cy="${GT + ph / 2}" r="0" fill="transparent"/>`;
    return `<div class="gr-wrap">${svgEixo(eixo)}<div class="gr-rolagem"><svg class="principal" viewBox="0 0 ${total} ${GH}" width="${total}" height="${GH}" role="img" aria-label="Gráfico de ${comItem.length} ${st.periodo === 'mes' ? 'dias' : 'leituras'}; toque num ponto para ver na lista">${g}${marcas}${alvos}</svg></div></div>`;
  }
  // ---------- lista ----------
  function lista(itens) {
    if (!itens.length) return `<p class="pn-vazio">Nenhuma leitura ${st.periodo === 'dia' ? 'neste dia' : st.periodo === 'semana' ? 'nesta semana' : 'neste mês'}. Use as setas para ver outros períodos.</p>`;
    let html = '', grupo = '';
    for (const it of itens.slice().reverse()) {
      const d = new Date(it.ts);
      if (st.periodo === 'semana') { const gdia = fmtDia(it.ts); if (gdia !== grupo) { if (grupo) html += '</ul>'; html += `<div class="dia-titulo">${esc(gdia)}</div><ul class="lista">`; grupo = gdia; } }
      else if (!grupo) { html += '<ul class="lista">'; grupo = 'x'; }
      const quando = st.periodo === 'mes' ? `<b>${d.getDate()}</b>${DIAS_CURTOS[d.getDay()]}` : `<b>${fmtHora(it.ts)}</b>`;
      const sub = st.periodo === 'mes' ? `média de ${plural(it.n, 'leitura', 'leituras')}` : '';
      let meio, dir;
      if (st.modo === 'valores') {
        meio = `<span class="valores">${it.sys}/${it.dia}${sub ? `<span class="sub">${sub}</span>` : ''}</span>`;
        dir = `${it.pulse} bpm`;
      } else if (!it.prev) {
        meio = `<span class="valores"><span class="sub">primeira leitura registrada</span>${it.sys}/${it.dia}</span>`; dir = `${it.pulse} bpm`;
      } else {
        meio = `<span class="valores">${delta(it.sys, it.prev.sys)}${delta(it.dia, it.prev.dia)}<span class="sub">${it.sys}/${it.dia} ${st.periodo === 'mes' ? 'vs dia anterior com leitura' : 'vs leitura anterior'}</span></span>`;
        dir = `${delta(it.pulse, it.prev.pulse)}<span class="sub">${it.pulse} bpm</span>`;
      }
      html += `<li><button class="pn-item${it.id === st.sel ? ' sel' : ''}" data-id="${esc(it.id)}"><span class="quando">${quando}</span>${meio}<span class="dir">${dir}</span></button></li>`;
    }
    return html + '</ul>';
  }
  // ---------- navegação só por períodos com leituras ----------
  function vizinho(dir) {
    const j = janela(st.periodo, st.ancora);
    const asc = registros.slice().sort((x, y) => x.ts - y.ts);
    if (!asc.length) return null;
    if (dir < 0) {
      const r = [...asc].reverse().find((x) => x.ts < j.ini);
      return r ? r.ts : null;
    }
    const r = asc.find((x) => x.ts >= j.fim);
    if (!r) return null;
    if (st.periodo !== 'semana') return r.ts;
    // semana: começa no dia da próxima leitura, sem passar da última leitura registrada
    const ultimo = asc[asc.length - 1].ts;
    return Math.min(addDias(inicioDia(r.ts), 6) + DIA_MS / 2, Math.max(r.ts, ultimo));
  }
  function render(rolar) {
    const { j, itens, noPeriodo, antes } = montarItens();
    st.itens = itens;
    if (st.sel && !itens.some((it) => it.id === st.sel)) st.sel = null;
    document.querySelectorAll('#painel [data-p]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.p === st.periodo)));
    document.querySelectorAll('#painel [data-m]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.m === st.modo)));
    $('#pn-pulso').setAttribute('aria-pressed', String(st.pulso));
    $('#pn-rotulo-txt').textContent = rotulo(st.periodo, j);
    $('#pn-ant').disabled = vizinho(-1) == null;
    $('#pn-prox').disabled = vizinho(1) == null;
    $('#pn-resumo').innerHTML = resumo(noPeriodo, antes);
    const velho = document.querySelector('#pn-grafico .gr-rolagem');
    const scrollAntes = velho ? velho.scrollLeft : 0;
    $('#pn-grafico').innerHTML = grafico(itens, j);
    $('#pn-lista').innerHTML = lista(itens);
    const rol = document.querySelector('#pn-grafico .gr-rolagem');
    if (rol) {
      if (rolar === 'fim') rol.scrollLeft = rol.scrollWidth;
      else rol.scrollLeft = scrollAntes;
    }
  }
  function centralizarNoGrafico(id, suave) {
    const rol = document.querySelector('#pn-grafico .gr-rolagem'), c = rol && rol.querySelector(`.alvo[data-id="${CSS.escape(id)}"]`);
    if (!c) return;
    const x = +c.getAttribute('cx'), alvo = Math.max(0, x - rol.clientWidth / 2);
    if (Math.abs(rol.scrollLeft - alvo) > 2) rol.scrollTo({ left: alvo, behavior: suave ? 'smooth' : 'auto' });
  }
  function selecionar(id, origem) {
    st.sel = id; render();
    const suave = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const alvo = document.querySelector(`#pn-lista .pn-item[data-id="${CSS.escape(id)}"]`);
    if (alvo && origem === 'grafico') alvo.scrollIntoView({ block: 'center', behavior: suave ? 'smooth' : 'auto' });
    if (origem === 'lista') centralizarNoGrafico(id, suave);
  }
  function toqueGrafico(ev) {
    const svg = ev.target.closest('svg.principal'); if (!svg || !st.itens.length) return;
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    let melhor = null, dmin = Infinity;
    for (const c of svg.querySelectorAll('.alvo')) { const d = Math.abs(+c.getAttribute('cx') - p.x); if (d < dmin) { dmin = d; melhor = c.dataset.id; } }
    if (melhor && dmin < 40) selecionar(melhor, 'grafico');
  }
  // ---------- calendário ----------
  function abrirCalendario() {
    const diasCom = new Set(registros.map((r) => chaveDia(r.ts)));
    if (!diasCom.size) { toast('Ainda não há leituras registradas'); return; }
    const mesesCom = [...new Set(registros.map((r) => { const d = new Date(r.ts); return d.getFullYear() * 12 + d.getMonth(); }))].sort((a, b) => a - b);
    const a0 = new Date(st.ancora); let mes = a0.getFullYear() * 12 + a0.getMonth();
    if (!mesesCom.includes(mes)) mes = mesesCom[mesesCom.length - 1];
    const j = janela(st.periodo, st.ancora);
    const f = document.createElement('div'); f.className = 'fundo';
    const desenhar = () => {
      const ano = Math.floor(mes / 12), m = mes % 12;
      const primeiro = new Date(ano, m, 1), nDias = new Date(ano, m + 1, 0).getDate();
      const ant = mesesCom.filter((x) => x < mes).pop(), prox = mesesCom.find((x) => x > mes);
      let cel = '';
      for (let i = 0; i < primeiro.getDay(); i++) cel += '<span></span>';
      for (let d = 1; d <= nDias; d++) {
        const t = new Date(ano, m, d, 12).getTime(), k = chaveDia(t), tem = diasCom.has(k);
        const noPeriodo = t >= j.ini && t < j.fim;
        cel += `<button class="cal-dia${tem ? ' tem' : ''}${noPeriodo ? ' atual' : ''}" data-t="${t}" ${tem ? '' : 'aria-disabled="true"'} aria-label="${d} de ${MESES_LONGOS[m]}${tem ? '' : ', sem leituras'}">${d}</button>`;
      }
      f.innerHTML = `<div class="dialogo calendario" role="dialog" aria-modal="true" aria-label="Escolher data">
        <div class="cal-topo">
          <button class="icone" data-cal="ant" ${ant == null ? 'disabled' : ''} aria-label="Mês anterior com leituras"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
          <b>${MESES_LONGOS[m][0].toUpperCase() + MESES_LONGOS[m].slice(1)} de ${ano}</b>
          <button class="icone" data-cal="prox" ${prox == null ? 'disabled' : ''} aria-label="Próximo mês com leituras"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
        </div>
        <div class="cal-sem">${['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
        <div class="cal-grade">${cel}</div>
        <p class="cal-legenda"><i></i>dias com leitura</p>
        <div class="botoes"><button class="btn btn-sec" data-cal="fechar">Fechar</button></div>
      </div>`;
    };
    desenhar();
    f.onclick = (ev) => {
      if (ev.target === f) { f.remove(); return; }
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.cal === 'fechar') { f.remove(); return; }
      if (b.dataset.cal === 'ant') { mes = mesesCom.filter((x) => x < mes).pop(); desenhar(); return; }
      if (b.dataset.cal === 'prox') { mes = mesesCom.find((x) => x > mes); desenhar(); return; }
      if (b.dataset.t) {
        const t = +b.dataset.t, d = new Date(t);
        if (!b.classList.contains('tem')) { toast(`Não há leituras em ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`); return; }
        f.remove(); st.ancora = t; st.sel = null; render('fim');
      }
    };
    $('#camada').appendChild(f);
    const foco = f.querySelector('.cal-dia.atual.tem') || f.querySelector('.cal-dia.tem'); if (foco) foco.focus();
  }
  function abrir() {
    const ult = registros[0];
    st.ancora = ult ? ult.ts : Date.now(); st.sel = null;
    mostrar('painel');
    render('fim');
  }
  let rz = 0;
  window.addEventListener('resize', () => { if (telaAtual !== 'painel') return; cancelAnimationFrame(rz); rz = requestAnimationFrame(() => render()); });
  $('#painel').addEventListener('click', (ev) => {
    const p = ev.target.closest('[data-p]'); if (p) { st.periodo = p.dataset.p; render('fim'); return; }
    const m = ev.target.closest('[data-m]'); if (m) { st.modo = m.dataset.m; render(); return; }
    const it = ev.target.closest('.pn-item'); if (it) { selecionar(it.dataset.id, 'lista'); return; }
  });
  $('#pn-grafico').addEventListener('click', toqueGrafico);
  $('#pn-pulso').onclick = () => { st.pulso = !st.pulso; render(); };
  $('#pn-ant').onclick = () => { const t = vizinho(-1); if (t != null) { st.ancora = t; st.sel = null; render('fim'); } };
  $('#pn-prox').onclick = () => { const t = vizinho(1); if (t != null) { st.ancora = t; st.sel = null; render('fim'); } };
  $('#pn-rotulo').onclick = abrirCalendario;
  return { abrir, render, estado: st };
})();

// ====================== botão adicionar ======================
function abrirAdicionar() {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const f = document.createElement('div'); f.className = 'fundo';
  f.innerHTML = `<div class="folha" role="menu" aria-label="Adicionar leitura">
    <button class="opcao" id="op-ler" role="menuitem"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></span><span><b>Ler o aparelho</b><small>Aponte a câmera para o visor</small></span></button>
    <button class="opcao" id="op-digitar" role="menuitem"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg></span><span><b>Digitar os valores</b><small>Informe sistólica, diastólica e pulso</small></span></button>
    <button class="opcao" id="op-foto" role="menuitem"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg></span><span><b>Ler de uma foto da galeria</b><small>Use uma foto já tirada do visor</small></span></button>
  </div>`;
  f.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (ev.target === f || b) f.remove();
    if (b && b.id === 'op-ler') Camera.abrir();
    else if (b && b.id === 'op-digitar') Conferir.nova({ values: null, source: 'manual' });
    else if (b && b.id === 'op-foto') $('#in-foto').click();
  };
  $('#camada').appendChild(f);
  f.querySelector('button').focus();
}

// ====================== ligações ======================
$('#btn-add').onclick = abrirAdicionar;
$('#btn-painel').onclick = () => Painel.abrir();
$('#btn-painel-voltar').onclick = () => voltarInicio();
$('#btn-cam-fechar').onclick = () => { Camera.parar(); voltarInicio(); };
$('#btn-cam-digitar').onclick = () => { Camera.parar(); Conferir.nova({ values: null, source: 'manual' }); };
$('#btn-lanterna').onclick = () => Camera.alternarLanterna();
$('#btn-conf-fechar').onclick = () => voltarInicio();
$('#btn-salvar').onclick = () => Conferir.salvar();
$('#btn-excluir').onclick = () => Conferir.excluir();
$('#btn-reler').onclick = () => Conferir.reler();
$('#btn-menu').onclick = abrirMenu;
$('#lista').onclick = (ev) => { const b = ev.target.closest('.item'); if (!b) return; const r = registros.find((x) => x.id === b.dataset.id); if (r) Conferir.editar(r); };
$('#in-foto').onchange = (ev) => lerFoto(ev.target.files[0]);
$('#in-backup').onchange = (ev) => importar(ev.target.files[0]);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && telaAtual === 'conferir' && ev.target.tagName === 'INPUT') Conferir.salvar(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && telaAtual === 'camera') Camera.parar(); else if (!document.hidden && telaAtual === 'camera') Camera.abrir(); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
carregar();
