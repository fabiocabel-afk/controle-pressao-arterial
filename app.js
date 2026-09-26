'use strict';
// Pressão — registro de pressão arterial com leitura do visor pela câmera
const APP_VERSION = '1.6.2';
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
// v1: leituras. v2: + perfis (cada leitura ganha profileId).
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open('pressao', 2);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('leituras')) {
          const st = db.createObjectStore('leituras', { keyPath: 'id' });
          st.createIndex('ts', 'ts');
        }
        if (!db.objectStoreNames.contains('perfis')) db.createObjectStore('perfis', { keyPath: 'id' });
      };
      rq.onsuccess = () => { const db = rq.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
      rq.onerror = () => { dbp = null; rej(rq.error || new Error('Falha ao abrir o banco de dados')); };
      rq.onblocked = () => rej(new Error('Banco de dados bloqueado por outra aba aberta do app. Feche as outras abas e tente de novo.'));
    });
    return dbp;
  }
  function tx(stores, mode, fn) {
    return open().then((db) => new Promise((res, rej) => {
      const t = db.transaction(stores, mode); let out;
      const st = (n) => t.objectStore(n);
      Promise.resolve(fn(st, (v) => { out = v; })).catch((e) => { try { t.abort(); } catch (_) {} rej(e); });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error || new Error('Erro na transação'));
      t.onabort = () => rej(t.error || new Error('Transação cancelada'));
    }));
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    all: () => tx(['leituras'], 'readonly', (st, set) => req(st('leituras').getAll()).then((v) => set(v.sort((a, b) => b.ts - a.ts)))),
    get: (id) => tx(['leituras'], 'readonly', (st, set) => req(st('leituras').get(id)).then(set)),
    put: (rec) => tx(['leituras'], 'readwrite', (st) => { st('leituras').put(rec); }),
    del: (id) => tx(['leituras'], 'readwrite', (st) => { st('leituras').delete(id); }),
    perfis: () => tx(['perfis'], 'readonly', (st, set) => req(st('perfis').getAll()).then((v) => set(v.sort((a, b) => a.createdAt - b.createdAt)))),
    putPerfil: (p) => tx(['perfis'], 'readwrite', (st) => { st('perfis').put(p); }),
    // primeiro perfil: grava e associa a ele as leituras antigas sem dono (tudo numa transação)
    primeiroPerfil: (p) => tx(['perfis', 'leituras'], 'readwrite', (st, set) => {
      st('perfis').put(p);
      return req(st('leituras').getAll()).then((ls) => { let n = 0; for (const r of ls) if (!r.profileId) { r.profileId = p.id; st('leituras').put(r); n++; } set(n); });
    }),
    // exclui a pessoa e todas as leituras dela (tudo ou nada)
    delPerfil: (id) => tx(['perfis', 'leituras'], 'readwrite', (st, set) => {
      st('perfis').delete(id);
      return req(st('leituras').getAll()).then((ls) => { let n = 0; for (const r of ls) if (r.profileId === id) { st('leituras').delete(r.id); n++; } set(n); });
    }),
    importar: (perfis, leituras) => tx(['perfis', 'leituras'], 'readwrite', (st) => { for (const p of perfis) st('perfis').put(p); for (const r of leituras) st('leituras').put(r); }),
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
let registros = [];      // leituras da pessoa atual (mais recente primeiro)
let todas = [];          // leituras de todas as pessoas
let perfis = [];
let perfilAtual = null;  // id
const MAX_PERFIS = 12;
const CORES_PERFIL = ['#2E3272', '#23806B', '#B0532A', '#7A3E9D', '#1F6FA8', '#A0356A', '#5B6B1F', '#8A5A12', '#2F7C8C', '#6A4A3A', '#3D55B8', '#9C2F2F'];
const perfilDe = (id) => perfis.find((p) => p.id === id) || null;
const lerPerfilSalvo = () => { try { return localStorage.getItem('pressao.perfilAtual'); } catch (_) { return null; } };
const salvarPerfilAtual = (id) => { try { localStorage.setItem('pressao.perfilAtual', id); } catch (_) {} };
async function carregar() {
  try { [perfis, todas] = await Promise.all([DB.perfis(), DB.all()]); }
  catch (e) {
    perfis = []; todas = []; registros = [];
    await dialog({ title: 'Não foi possível abrir suas leituras', text: 'O navegador recusou o acesso ao armazenamento do app. Seus dados não foram alterados. Feche outras abas deste app e tente de novo.', detail: String(e && e.message || e), buttons: [{ label: 'Entendi', value: 1, cls: 'btn-start' }] });
    return;
  }
  if (!perfis.length) { Perfil.primeiro(todas.filter((r) => !r.profileId).length); return; }
  if (!perfilDe(perfilAtual)) perfilAtual = perfilDe(lerPerfilSalvo()) ? lerPerfilSalvo() : perfis[0].id;
  registros = todas.filter((r) => r.profileId === perfilAtual);
  renderTopo();
  renderInicio();
  if (telaAtual === 'painel') Painel.render();
}
function avatarHTML(p, tam) {
  const ini = (p.nome.trim()[0] || '?').toUpperCase();
  return `<span class="avatar" style="background:${CORES_PERFIL[(p.cor || 0) % CORES_PERFIL.length]};${tam ? `width:${tam}px;height:${tam}px;font-size:${Math.round(tam * 0.45)}px` : ''}" aria-hidden="true">${esc(ini)}</span>`;
}
function renderTopo() {
  const p = perfilDe(perfilAtual); if (!p) return;
  $('#perfil-avatar').innerHTML = avatarHTML(p);
  $('#perfil-nome').textContent = p.nome;
  $('#btn-perfil').setAttribute('aria-label', `Pessoa: ${p.nome}. Trocar ou adicionar pessoa`);
  const pn = $('#painel-pessoa'); if (pn) pn.textContent = p.nome;
}

// ---------- faixas de referência (limite do "normal") ----------
// sys/dia = valor-limite; inclusivo = o próprio limite ainda é normal ("até"), senão precisa ficar abaixo.
const FAIXAS = [
  { id: 'sbc2025', curto: 'Diretriz 2025', nome: 'Diretriz Brasileira de Hipertensão Arterial 2025', ano: 2025, sys: 120, dia: 80, inclusivo: false, desc: 'Normal: abaixo de 120/80. De 120/80 a 139/89 é pré-hipertensão; hipertensão a partir de 140/90. É a mais atual.' },
  { id: 'meta2025', curto: 'Meta 2025', nome: 'Meta de tratamento da Diretriz 2025', ano: 2025, sys: 130, dia: 80, inclusivo: false, desc: 'Para quem já trata a hipertensão: manter abaixo de 130/80, quando tolerado.' },
  { id: 'sbc2020', curto: 'Diretriz 2020', nome: 'Diretrizes Brasileiras de Hipertensão Arterial 2020', ano: 2020, sys: 129, dia: 84, inclusivo: true, desc: 'Ótima: abaixo de 120/80. Normal: até 129/84. Pré-hipertensão: 130–139/85–89; hipertensão a partir de 140/90.' },
  { id: 'sbc2016', curto: 'Diretriz 2016', nome: '7ª Diretriz Brasileira de Hipertensão Arterial (2016)', ano: 2016, sys: 120, dia: 80, inclusivo: true, desc: 'Normal: até 120/80. Pré-hipertensão: 121–139/81–89; hipertensão a partir de 140/90.' },
  { id: 'sbc2010', curto: 'Diretriz 2010', nome: 'VI Diretrizes Brasileiras de Hipertensão (2010)', ano: 2010, sys: 130, dia: 85, inclusivo: false, desc: 'Ótima: abaixo de 120/80. Normal: abaixo de 130/85. Limítrofe: 130–139/85–89; hipertensão a partir de 140/90.' },
];
function faixaDe(perfil) {
  const p = perfil && perfil.parametro;
  if (p && p.id === 'personalizado' && Number.isInteger(p.sys) && Number.isInteger(p.dia)) return { id: 'personalizado', curto: 'Personalizado', nome: 'Faixa personalizada', sys: p.sys, dia: p.dia, inclusivo: true, desc: `Normal: até ${p.sys}/${p.dia}.` };
  return FAIXAS.find((f) => p && f.id === p.id) || FAIXAS[0];
}
const faixaTexto = (f) => `${f.curto} · ${f.inclusivo ? 'até' : 'abaixo de'} ${f.sys}/${f.dia}`;
const foraDaFaixa = (r, f) => (f.inclusivo ? r.sys > f.sys || r.dia > f.dia : r.sys >= f.sys || r.dia >= f.dia);

// ---------- notas ----------
const CATEGORIAS = [
  { k: 'sintomas', nome: 'Sintomas', op: ['Dor de cabeça', 'Tontura', 'Visão turva', 'Falta de ar', 'Dor no peito', 'Palpitação', 'Cansaço', 'Nenhum'] },
  { k: 'alimentacao', nome: 'Alimentação', op: ['Refeição há menos de 1 h', 'Comida salgada', 'Refeição pesada', 'Em jejum'] },
  { k: 'atividade', nome: 'Atividade física', op: ['Exercício há menos de 30 min', 'Caminhada', 'Esforço físico', 'Em repouso'] },
  { k: 'emocional', nome: 'Emocional', op: ['Calmo', 'Ansioso', 'Estressado', 'Irritado', 'Triste', 'Com dor'] },
  { k: 'sono', nome: 'Qualidade do sono', op: ['Boa', 'Regular', 'Ruim', 'Dormi pouco', 'Acordei várias vezes'] },
  { k: 'medicamentos', nome: 'Medicamentos', op: ['Tomei no horário', 'Tomei atrasado', 'Esqueci de tomar', 'Medi antes do remédio', 'Remédio novo ou dose mudou'] },
  { k: 'substancias', nome: 'Cafeína, álcool ou cigarro', op: ['Café', 'Chá ou refrigerante com cafeína', 'Energético', 'Bebida alcoólica', 'Cigarro'] },
  { k: 'medicao', nome: 'Como foi a medição', op: ['Braço esquerdo', 'Braço direito', 'Sentado', 'Deitado', 'Em pé', 'Repousei 5 min antes', 'Não repousei antes', 'Bexiga cheia', 'Falei durante a medição', 'Braçadeira sobre a roupa'] },
];
const catDe = (k) => CATEGORIAS.find((c) => c.k === k);
function notaPreenchida(n) { return !!(n && ((n.cats && Object.keys(n.cats).length) || (n.livre && n.livre.trim()))); }
function temNota(r) { return notaPreenchida(r && r.nota); }
function notaLinhas(n) {
  if (!n) return [];
  const out = [];
  for (const c of CATEGORIAS) { const v = n.cats && n.cats[c.k]; if (!v) continue; const partes = [...(v.op || [])]; if (v.txt && v.txt.trim()) partes.push(v.txt.trim()); out.push({ nome: c.nome, texto: partes.join(', ') || '(marcado)' }); }
  if (n.livre && n.livre.trim()) out.push({ nome: 'Nota', texto: n.livre.trim() });
  return out;
}
const ICONE_NOTA = '<svg class="ic-nota" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="tem nota"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/></svg>';
function origemTxt(r) { return r.source === 'manual' ? 'Digitada' : r.source === 'foto' ? 'Lida de uma foto' : 'Lida pela câmera'; }
function renderInicio() {
  const u = registros[0];
  if (u) {
    $('#ultimo').innerHTML = `
      <div class="visor-rot"><b>SYS</b>mmHg</div><div class="visor-num">${lcdSVG(u.sys, 3, 48, `Sistólica ${u.sys}`)}</div>
      <div class="visor-rot"><b>DIA</b>mmHg</div><div class="visor-num">${lcdSVG(u.dia, 3, 48, `Diastólica ${u.dia}`)}</div>
      <div class="visor-rot"><b>Pulso</b>/min</div><div class="visor-num">${lcdSVG(u.pulse, 3, 28, `Pulso ${u.pulse}`)}</div>`;
    $('#ultimo-quando').textContent = `${fmtDia(u.ts)}, ${fmtHora(u.ts)}`;
    $('#ultimo-origem').textContent = origemTxt(u);
  } else {
    $('#ultimo').innerHTML = `<div class="visor-vazio">Nenhuma leitura de ${esc((perfilDe(perfilAtual) || { nome: '' }).nome)} ainda.<br>Toque em <b>+</b> para adicionar a primeira.</div>`;
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
    html += `<li><button class="item" data-id="${esc(r.id)}"><span class="hora">${fmtHora(r.ts)}</span><span class="pa">${r.sys}/${r.dia}${marcas}${temNota(r) ? ICONE_NOTA : ''}</span><span class="pul">${r.pulse} bpm</span></button></li>`;
  }
  html += '</ul>';
  $('#lista').innerHTML = html;
}
function graficoSVG(s) {
  const W = 320, H = 176, L = 30, R = 12, T = 14, B = 24;
  let lo = Math.min(...s.map((r) => r.dia)), hi = Math.max(...s.map((r) => r.sys));
  lo = Math.floor((lo - 12) / 10) * 10; hi = Math.ceil((hi + 12) / 10) * 10;
  const X = (i) => L + 8 + (i * (W - L - R - 16)) / (s.length - 1), Y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const esp = (W - L - R - 16) / Math.max(1, s.length - 1);
  const r = Math.max(6.5, Math.min(10, esp * 0.46)), fs = r >= 8.5 ? 9 : 7.5;
  let g = '';
  const passo = hi - lo > 80 ? 40 : 20;
  for (let v = Math.ceil(lo / passo) * passo; v <= hi; v += passo) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#E3E7E1"/><text x="${L - 6}" y="${Y(v) + 4}" font-size="10" text-anchor="end" fill="#6B757D">${v}</text>`;
  const linha = (k, cor, cls) => `<polyline fill="none" stroke="${cor}" stroke-width="2.2" stroke-linejoin="round" points="${s.map((x, i) => `${X(i).toFixed(1)},${Y(x[k]).toFixed(1)}`).join(' ')}"/>` +
    s.map((x, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(x[k]).toFixed(1)}" r="${r.toFixed(1)}" fill="${cor}" stroke="#fff" stroke-width="1.5"/><text class="${cls}" x="${X(i).toFixed(1)}" y="${(Y(x[k]) + fs * 0.36).toFixed(1)}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="#fff">${Math.floor(x[k] / 10)}</text>`).join('');
  const d0 = new Date(s[0].ts), d1 = new Date(s[s.length - 1].ts);
  g += `<text x="${L + 8}" y="${H - 6}" font-size="10" fill="#6B757D">${d0.getDate()}/${d0.getMonth() + 1}</text><text x="${W - R - 8}" y="${H - 6}" font-size="10" text-anchor="end" fill="#6B757D">${d1.getDate()}/${d1.getMonth() + 1}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico das últimas ${s.length} leituras">${g}${linha('sys', 'var(--sys)', 'mini-sys')}${linha('dia', 'var(--dia)', 'mini-dia')}</svg>`;
}

// ====================== navegação ======================
let telaAtual = 'inicio';
function mostrar(nome, push = true) {
  for (const id of ['inicio', 'camera', 'conferir', 'painel', 'perfil']) $('#' + id).hidden = id !== nome && !(id === 'inicio' && nome === 'camera');
  if (nome !== 'camera') Camera.parar();
  if (push && nome !== 'inicio' && telaAtual === 'inicio') history.pushState({ tela: nome }, '');
  telaAtual = nome;
  window.scrollTo(0, 0);
}
function voltarInicio() { if (history.state && history.state.tela) history.back(); else mostrar('inicio', false); }
window.addEventListener('popstate', () => {
  if (!perfis.length) { history.pushState({ tela: 'perfil' }, ''); return; } // cadastro inicial é obrigatório
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
  let nota = { cats: {}, livre: '' };
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
  // ---------- pessoa ----------
  function preencherPessoas(id) {
    $('#in-pessoa').innerHTML = perfis.map((p) => `<option value="${esc(p.id)}"${p.id === id ? ' selected' : ''}>${esc(p.nome)}</option>`).join('');
    $('#c-pessoa').hidden = perfis.length < 2;
  }
  // ---------- notas ----------
  function renderNota() {
    $('#nota-cats').innerHTML = CATEGORIAS.map((c) => `<button type="button" class="chip-cat" data-cat="${c.k}" aria-pressed="${!!nota.cats[c.k]}">${esc(c.nome)}</button>`).join('');
    $('#nota-paineis').innerHTML = CATEGORIAS.filter((c) => nota.cats[c.k]).map((c) => {
      const v = nota.cats[c.k];
      return `<div class="nota-painel" data-painel="${c.k}"><div class="nota-painel-t">${esc(c.nome)}<button type="button" class="nota-tirar" data-tirar="${c.k}" aria-label="Remover ${esc(c.nome)}">×</button></div>
        <div class="nota-ops">${c.op.map((o) => `<button type="button" class="chip-op" data-cat="${c.k}" data-op="${esc(o)}" aria-pressed="${v.op.includes(o)}">${esc(o)}</button>`).join('')}</div>
        <input type="text" class="nota-txt" data-cat="${c.k}" maxlength="200" placeholder="Detalhes (opcional)" value="${esc(v.txt || '')}"></div>`;
    }).join('');
    $('#nota-livre').value = nota.livre || '';
    const n = notaLinhas(nota).length;
    $('#nota-resumo-cont').textContent = n ? `(${n})` : '';
  }
  function carregarNota(n) {
    nota = { cats: {}, livre: (n && n.livre) || '' };
    if (n && n.cats) for (const k of Object.keys(n.cats)) if (catDe(k)) nota.cats[k] = { op: [...(n.cats[k].op || [])], txt: n.cats[k].txt || '' };
    renderNota();
    $('#nota-sec').open = notaPreenchida(nota);
  }
  function notaFinal() {
    const out = { cats: {}, livre: ($('#nota-livre').value || '').trim().slice(0, 1000) };
    for (const k of Object.keys(nota.cats)) out.cats[k] = { op: nota.cats[k].op.slice(), txt: (nota.cats[k].txt || '').trim() };
    return notaPreenchida(out) ? out : null;
  }
  $('#nota-sec').addEventListener('click', (ev) => {
    const cat = ev.target.closest('.chip-cat'), op = ev.target.closest('.chip-op'), tirar = ev.target.closest('[data-tirar]');
    if (cat) { const k = cat.dataset.cat; if (nota.cats[k]) delete nota.cats[k]; else nota.cats[k] = { op: [], txt: '' }; renderNota(); const inp = document.querySelector(`.nota-painel[data-painel="${k}"] .chip-op`); if (inp && nota.cats[k]) inp.focus(); }
    else if (op) { const v = nota.cats[op.dataset.cat]; const o = op.dataset.op; v.op = v.op.includes(o) ? v.op.filter((x) => x !== o) : v.op.concat(o); op.setAttribute('aria-pressed', String(v.op.includes(o))); }
    else if (tirar) { delete nota.cats[tirar.dataset.tirar]; renderNota(); }
  });
  $('#nota-sec').addEventListener('input', (ev) => {
    if (ev.target.classList.contains('nota-txt')) nota.cats[ev.target.dataset.cat].txt = ev.target.value;
    if (ev.target.id === 'nota-livre') nota.livre = ev.target.value;
  });
  // ---------- alerta de valores muito altos ----------
  function checarAlerta() {
    const s = Number(campos.sys.value), d = Number(campos.dia.value);
    $('#conf-alerta').hidden = !((s >= 180) || (d >= 120));
  }
  for (const k of ['sys', 'dia']) campos[k].addEventListener('input', checarAlerta);

  function abrirTela() {
    limparErros(); checarAlerta();
    $('.conf-grade').style.gridTemplateColumns = $('#recorte').hidden ? '1fr' : '';
    mostrar('conferir', telaAtual === 'inicio');
  }
  function nova({ values, confident, crop, source, falhou, ts, tsOrigem }) {
    ctx = { modo: 'nova', source, confident: !!confident, lidos: values ? { ...values } : null };
    $('#conf-titulo').textContent = source === 'manual' ? 'Nova leitura' : 'Confira a leitura';
    preencher(values);
    $('#in-data').value = toLocalInput(ts || Date.now());
    const dica = $('#data-origem');
    dica.hidden = source !== 'foto';
    dica.textContent = tsOrigem === 'exif' ? 'Data e hora em que a foto foi tirada.' : tsOrigem === 'arquivo' ? 'A foto não tinha a hora da captura; usei a data do arquivo. Confira.' : 'Não encontrei a data da foto; confira a data e a hora.';
    dica.className = 'data-origem' + (tsOrigem === 'exif' ? '' : ' atencao');
    preencherPessoas(perfilAtual);
    carregarNota(null);
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
    preencherPessoas(reg.profileId);
    carregarNota(reg.nota);
    $('#data-origem').hidden = true;
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
    const pid = $('#in-pessoa').value || perfilAtual;
    if (!perfilDe(pid)) { ok = false; toast('Escolha a pessoa desta leitura'); }
    return ok ? { ...v, ts, profileId: pid } : null;
  }
  async function salvar() {
    const v = validar(); if (!v) return;
    const agora = Date.now(), nf = notaFinal();
    let rec;
    if (ctx.modo === 'nova') {
      const lidos = ctx.lidos;
      rec = { id: uuid(), profileId: v.profileId, ts: v.ts, sys: v.sys, dia: v.dia, pulse: v.pulse, source: ctx.source, device: ctx.source === 'manual' ? null : DEVICE_ID,
        confident: ctx.source === 'manual' ? null : ctx.confident, read: lidos || null, nota: nf,
        edited: !!(lidos && (lidos.sys !== v.sys || lidos.dia !== v.dia || lidos.pulse !== v.pulse)), createdAt: agora, updatedAt: agora };
    } else {
      const r0 = ctx.registro;
      rec = { ...r0, profileId: v.profileId, ts: v.ts, sys: v.sys, dia: v.dia, pulse: v.pulse, nota: nf, updatedAt: agora };
      if (r0.read) rec.edited = r0.read.sys !== v.sys || r0.read.dia !== v.dia || r0.read.pulse !== v.pulse;
    }
    const btn = $('#btn-salvar'); btn.disabled = true;
    try {
      await DB.put(rec);
      const conf = await DB.get(rec.id); // confirma que foi gravado de verdade
      if (!conf || conf.sys !== rec.sys || conf.dia !== rec.dia || conf.pulse !== rec.pulse || conf.ts !== rec.ts || conf.profileId !== rec.profileId || JSON.stringify(conf.nota) !== JSON.stringify(rec.nota))
        throw new Error('A leitura não foi encontrada no armazenamento depois de salvar.');
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const outra = rec.profileId !== perfilAtual ? ` para ${perfilDe(rec.profileId).nome}` : '';
      toast((ctx.modo === 'nova' ? 'Leitura salva' : 'Alterações salvas') + outra);
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

// ====================== pessoas (perfis) ======================
const Perfil = (() => {
  let ctx = null; // { modo: 'primeiro'|'novo'|'editar', perfil, orfas }
  let sexo = '';
  const f = { nome: () => $('#pf-nome'), nasc: () => $('#pf-nasc'), peso: () => $('#pf-peso'), alt: () => $('#pf-alt') };
  function limparErros() { document.querySelectorAll('#perfil .campo').forEach((c) => { c.classList.remove('erro'); const m = c.querySelector('.msg-erro'); if (m) m.hidden = true; }); }
  function erro(id, msg) { const c = $('#' + id); c.classList.add('erro'); const m = c.querySelector('.msg-erro'); m.textContent = msg; m.hidden = false; }
  function marcarSexo(v) { sexo = v; document.querySelectorAll('#pf-sexo [data-sexo]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sexo === v))); }
  function imc() {
    const p = parseFloat(String(f.peso().value).replace(',', '.')), a = parseFloat(String(f.alt().value).replace(',', '.'));
    $('#pf-imc').textContent = p > 0 && a > 0 ? `IMC ${(p / ((a / 100) ** 2)).toFixed(1).replace('.', ',')}` : '';
  }
  function abrirForm(modo, perfil, orfas) {
    ctx = { modo, perfil, orfas: orfas || 0 };
    limparErros();
    $('#pf-titulo').textContent = modo === 'editar' ? 'Dados da pessoa' : modo === 'primeiro' ? 'Quem vai usar?' : 'Nova pessoa';
    $('#pf-intro').hidden = modo !== 'primeiro';
    $('#pf-intro').innerHTML = `Cadastre a primeira pessoa. Depois você pode adicionar até ${MAX_PERFIS} pessoas e alternar pelo nome no topo.` + (orfas ? `<br><b>${plural(orfas, 'leitura já salva', 'leituras já salvas')} neste aparelho ${orfas === 1 ? 'será associada' : 'serão associadas'} a esta pessoa.</b>` : '');
    $('#btn-pf-voltar').hidden = modo === 'primeiro';
    $('#pf-importar').hidden = modo !== 'primeiro';
    f.nome().value = perfil ? perfil.nome : '';
    f.nasc().value = perfil && perfil.nascimento ? perfil.nascimento : '';
    f.peso().value = perfil && perfil.peso ? String(perfil.peso).replace('.', ',') : '';
    f.alt().value = perfil && perfil.altura ? perfil.altura : '';
    marcarSexo(perfil ? perfil.sexo || '' : '');
    imc();
    $('#btn-pf-excluir').hidden = !(modo === 'editar' && perfis.length > 1);
    mostrar('perfil', telaAtual === 'inicio');
    if (modo !== 'editar') setTimeout(() => f.nome().focus(), 50);
  }
  function validar() {
    limparErros(); let ok = true;
    const nome = f.nome().value.trim().replace(/\s+/g, ' ');
    if (!nome) { erro('pf-c-nome', 'Informe o nome.'); ok = false; }
    else if (perfis.some((p) => p.nome.toLowerCase() === nome.toLowerCase() && (!ctx.perfil || p.id !== ctx.perfil.id))) { erro('pf-c-nome', 'Já existe uma pessoa com esse nome.'); ok = false; }
    if (!sexo) { erro('pf-c-sexo', 'Escolha uma opção.'); ok = false; }
    const num = (el) => { const t = String(el.value).trim().replace(',', '.'); return t === '' ? null : Number(t); };
    const peso = num(f.peso()), alt = num(f.alt());
    if (peso != null && !(peso >= 20 && peso <= 300)) { erro('pf-c-peso', 'Peso entre 20 e 300 kg.'); ok = false; }
    if (alt != null && !(Number.isInteger(alt) && alt >= 50 && alt <= 250)) { erro('pf-c-alt', 'Altura em centímetros, entre 50 e 250.'); ok = false; }
    const nasc = f.nasc().value || null;
    if (nasc && (nasc < '1900-01-01' || new Date(nasc + 'T00:00') > new Date())) { erro('pf-c-nasc', 'Data de nascimento inválida.'); ok = false; }
    return ok ? { nome, sexo, peso: peso != null ? Math.round(peso * 10) / 10 : null, altura: alt, nascimento: nasc } : null;
  }
  async function salvar() {
    const v = validar(); if (!v) return;
    const agora = Date.now();
    const usadas = new Set(perfis.map((p) => p.cor));
    const cor = ctx.perfil ? ctx.perfil.cor : [...Array(MAX_PERFIS).keys()].find((i) => !usadas.has(i)) ?? perfis.length;
    const p = ctx.perfil ? { ...ctx.perfil, ...v, updatedAt: agora } : { id: uuid(), cor, ...v, createdAt: agora, updatedAt: agora };
    if (ctx.modo !== 'editar' && perfis.length >= MAX_PERFIS) { toast(`Limite de ${MAX_PERFIS} pessoas atingido`); return; }
    const btn = $('#btn-pf-salvar'); btn.disabled = true;
    try {
      if (ctx.modo === 'primeiro') await DB.primeiroPerfil(p); else await DB.putPerfil(p);
      const lidos = await DB.perfis();
      if (!lidos.some((x) => x.id === p.id && x.nome === p.nome)) throw new Error('A pessoa não foi encontrada no armazenamento depois de salvar.');
      if (ctx.modo !== 'editar') { perfilAtual = p.id; salvarPerfilAtual(p.id); }
      toast(ctx.modo === 'editar' ? 'Dados salvos' : `Pessoa cadastrada: ${p.nome}`);
      if (ctx.modo === 'primeiro') mostrar('inicio', false); else voltarInicio();
      await carregar();
    } catch (e) {
      await dialog({ title: 'Os dados NÃO foram salvos', text: 'Os campos continuam preenchidos. Tente de novo.', detail: String(e && e.message || e), buttons: [{ label: 'Ok', value: 1, cls: 'btn-start' }] });
    } finally { btn.disabled = false; }
  }
  async function excluir() {
    const p = ctx.perfil, n = todas.filter((r) => r.profileId === p.id).length;
    const ok1 = await dialog({ title: `Excluir ${p.nome}?`, text: `Isso apaga a pessoa e ${plural(n, 'leitura', 'leituras')} dela. Não pode ser desfeito. Se tiver dúvida, exporte um backup antes pelo menu ⋯.`, buttons: [{ label: 'Cancelar', value: false }, { label: 'Continuar', value: true, cls: 'btn-perigo' }] });
    if (!ok1) return;
    const ok2 = await dialog({ title: 'Tem certeza?', text: `${p.nome} e ${plural(n, 'leitura', 'leituras')} serão apagadas agora.`, buttons: [{ label: 'Cancelar', value: false }, { label: `Excluir ${p.nome}`, value: true, cls: 'btn-perigo' }] });
    if (!ok2) return;
    try {
      await DB.delPerfil(p.id);
      const [ps, ls] = await Promise.all([DB.perfis(), DB.all()]);
      if (ps.some((x) => x.id === p.id) || ls.some((r) => r.profileId === p.id)) throw new Error('Parte dos dados continua no armazenamento.');
      if (perfilAtual === p.id) { perfilAtual = ps[0].id; salvarPerfilAtual(perfilAtual); }
      toast(`Pessoa excluída: ${p.nome}`); voltarInicio(); await carregar();
    } catch (e) {
      await dialog({ title: 'Não foi possível excluir', detail: String(e && e.message || e), buttons: [{ label: 'Ok', value: 1, cls: 'btn-start' }] });
    }
  }
  function trocar(id) { perfilAtual = id; salvarPerfilAtual(id); registros = todas.filter((r) => r.profileId === id); renderTopo(); renderInicio(); if (telaAtual === 'painel') Painel.abrir(true); toast(`Mostrando ${perfilDe(id).nome}`); }
  function abrirFolha() {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const fundo = document.createElement('div'); fundo.className = 'fundo';
    const cont = (id) => todas.filter((r) => r.profileId === id).length;
    const cheio = perfis.length >= MAX_PERFIS, atual = perfilDe(perfilAtual);
    fundo.innerHTML = `<div class="folha" role="menu" aria-label="Pessoas">
      <div class="folha-titulo">Pessoas (${perfis.length} de ${MAX_PERFIS})</div>
      <div class="pessoas">${perfis.map((p) => `<button class="pessoa${p.id === perfilAtual ? ' atual' : ''}" data-pessoa="${esc(p.id)}" role="menuitemradio" aria-checked="${p.id === perfilAtual}">${avatarHTML(p, 36)}<span><b>${esc(p.nome)}</b><small>${plural(cont(p.id), 'leitura', 'leituras')}</small></span>${p.id === perfilAtual ? '<svg class="ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>' : ''}</button>`).join('')}</div>
      <button data-pa="editar" role="menuitem">Editar dados de ${esc(atual.nome)}</button>
      <button data-pa="novo" role="menuitem" ${cheio ? 'disabled' : ''}>${cheio ? `Limite de ${MAX_PERFIS} pessoas atingido` : 'Adicionar pessoa'}</button>
    </div>`;
    fundo.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (ev.target === fundo) { fundo.remove(); return; }
      if (!b || b.disabled) return;
      fundo.remove();
      if (b.dataset.pessoa) { if (b.dataset.pessoa !== perfilAtual) trocar(b.dataset.pessoa); }
      else if (b.dataset.pa === 'editar') abrirForm('editar', perfilDe(perfilAtual));
      else if (b.dataset.pa === 'novo') abrirForm('novo', null);
    };
    $('#camada').appendChild(fundo);
    fundo.querySelector('.pessoa.atual').focus();
  }
  $('#pf-sexo').addEventListener('click', (ev) => { const b = ev.target.closest('[data-sexo]'); if (b) { marcarSexo(b.dataset.sexo); limparCampo(b); } });
  $('#pf-peso').addEventListener('input', imc); $('#pf-alt').addEventListener('input', imc);
  $('#btn-pf-salvar').onclick = salvar;
  $('#btn-pf-excluir').onclick = excluir;
  $('#btn-pf-voltar').onclick = () => voltarInicio();
  $('#pf-importar').onclick = () => $('#in-backup').click();
  return { primeiro: (orfas) => abrirForm('primeiro', null, orfas), abrirFolha, emOnboarding: () => ctx && ctx.modo === 'primeiro' && !perfis.length };
})();

// ---------- data e hora da foto (EXIF) ----------
// Lê DateTimeOriginal (ou DateTimeDigitized / DateTime) do JPEG. Sem EXIF, usa a data do arquivo.
async function dataDaFoto(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const t = lerExif(new DataView(buf));
    if (t && dataPlausivel(t)) return { ts: t, origem: 'exif' };
  } catch (_) { /* segue para a data do arquivo */ }
  if (file.lastModified && dataPlausivel(file.lastModified)) return { ts: file.lastModified, origem: 'arquivo' };
  return { ts: Date.now(), origem: 'agora' };
}
const dataPlausivel = (t) => Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t < Date.now() + 5 * 60000;
function lerExif(dv) {
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;
  let p = 2;
  while (p + 4 <= dv.byteLength) {
    if (dv.getUint8(p) !== 0xFF) return null;
    const marca = dv.getUint8(p + 1), tam = dv.getUint16(p + 2);
    if (marca === 0xE1 && p + 10 <= dv.byteLength && dv.getUint32(p + 4) === 0x45786966 && dv.getUint16(p + 8) === 0) return lerTiff(dv, p + 10, Math.min(dv.byteLength, p + 2 + tam));
    if (marca === 0xDA) return null; // começou a imagem: sem EXIF
    p += 2 + tam;
  }
  return null;
}
function lerTiff(dv, base, fim) {
  const le = dv.getUint16(base) === 0x4949;
  const u16 = (o) => dv.getUint16(base + o, le), u32 = (o) => dv.getUint32(base + o, le);
  if (u16(2) !== 42) return null;
  const txt = (e) => { const n = u32(e + 4), off = n > 4 ? u32(e + 8) : e + 8; let s = ''; for (let i = 0; i < n - 1 && base + off + i < fim; i++) s += String.fromCharCode(dv.getUint8(base + off + i)); return s; };
  const ifd = (off) => { const out = {}; if (!off || base + off + 2 > fim) return out; const n = u16(off); for (let i = 0; i < n; i++) { const e = off + 2 + i * 12; if (base + e + 12 > fim) break; out[u16(e)] = e; } return out; };
  const ifd0 = ifd(u32(4));
  const exifIfd = ifd0[0x8769] ? ifd(u32(ifd0[0x8769] + 8)) : {};
  const bruto = (exifIfd[0x9003] && txt(exifIfd[0x9003])) || (exifIfd[0x9004] && txt(exifIfd[0x9004])) || (ifd0[0x0132] && txt(ifd0[0x0132]));
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(bruto || '');
  if (!m) return null;
  const fuso = exifIfd[0x9011] ? /^([+-])(\d{2}):(\d{2})$/.exec(txt(exifIfd[0x9011])) : null;
  if (fuso) { // horário com fuso conhecido: momento exato
    const min = (fuso[1] === '-' ? -1 : 1) * (+fuso[2] * 60 + +fuso[3]);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - min * 60000;
  }
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); // hora local do aparelho
}

// ====================== foto da galeria ======================
async function lerFoto(file) {
  if (!file) return;
  toast('Lendo a foto…', 1800);
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bmp, 0, 0, cv.width, cv.height);
    const [r, quando] = await Promise.all([Leitor.photo(cx.getImageData(0, 0, cv.width, cv.height)), dataDaFoto(file)]);
    Conferir.nova({ values: r.ok ? r.values : null, confident: r.confident, crop: r.ok ? r.crop : null, source: 'foto', falhou: !r.ok, ts: quando.ts, tsOrigem: quando.origem });
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
  const [ps, all] = await Promise.all([DB.perfis(), DB.all()]);
  baixar(`pressao-backup-${hojeStr()}.json`, 'application/json', JSON.stringify({ app: 'pressao', versao: APP_VERSION, exportadoEm: new Date().toISOString(), perfis: ps, leituras: all }, null, 1));
  toast(`${plural(all.length, 'leitura exportada', 'leituras exportadas')} de ${plural(ps.length, 'pessoa', 'pessoas')}`);
}
async function exportarCSV() {
  const [ps, all] = await Promise.all([DB.perfis(), DB.all()]);
  const nomes = new Map(ps.map((p) => [p.id, p.nome]));
  const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
  const linhas = ['data;hora;pessoa;sistolica;diastolica;pulso;origem;corrigida;' + CATEGORIAS.map((c) => q(c.nome)).join(';') + ';nota livre'];
  for (const r of all.slice().reverse()) {
    const d = new Date(r.ts), n = r.nota || {};
    const cats = CATEGORIAS.map((c) => { const v = n.cats && n.cats[c.k]; return v ? q([...(v.op || []), v.txt || ''].filter(Boolean).join(', ') || 'sim') : ''; });
    linhas.push(`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()};${fmtHora(r.ts)};${q(nomes.get(r.profileId) || '')};${r.sys};${r.dia};${r.pulse};${r.source};${r.edited ? 'sim' : 'não'};${cats.join(';')};${n.livre ? q(n.livre) : ''}`);
  }
  baixar(`pressao-${hojeStr()}.csv`, 'text/csv;charset=utf-8', '\ufeff' + linhas.join('\r\n'));
  toast(`${plural(all.length, 'leitura exportada', 'leituras exportadas')}`);
}
function validarRegistro(r) {
  const int = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
  return r && typeof r.id === 'string' && r.id && Number.isFinite(r.ts) && int(r.sys, 50, 280) && int(r.dia, 30, 200) && int(r.pulse, 30, 240) && r.dia < r.sys;
}
const validarPerfil = (p) => p && typeof p.id === 'string' && p.id && typeof p.nome === 'string' && p.nome.trim();
async function importar(file) {
  if (!file) return;
  try {
    const dados = JSON.parse(await file.text());
    const lista = Array.isArray(dados) ? dados : dados && dados.leituras;
    if (!Array.isArray(lista)) throw new Error('O arquivo não é um backup deste app.');
    const perfisArq = (dados && Array.isArray(dados.perfis) ? dados.perfis : []).filter(validarPerfil);
    const [psAtuais, lsAtuais] = await Promise.all([DB.perfis(), DB.all()]);
    const idsPerfil = new Set(psAtuais.map((p) => p.id));
    const perfisNovos = perfisArq.filter((p) => !idsPerfil.has(p.id)).map((p) => ({ ...p, nome: p.nome.trim().slice(0, 30), cor: Number.isInteger(p.cor) ? p.cor : 0, createdAt: p.createdAt || Date.now(), updatedAt: p.updatedAt || Date.now() }));
    if (psAtuais.length + perfisNovos.length > MAX_PERFIS) throw new Error(`O backup traria ${perfisNovos.length} pessoas novas e passaria do limite de ${MAX_PERFIS}. Nada foi importado.`);
    perfisNovos.forEach((p) => idsPerfil.add(p.id));
    const validos = lista.filter(validarRegistro), invalidos = lista.length - validos.length;
    // quem recebe leituras sem pessoa: a atual; no primeiro acesso, a primeira pessoa do backup;
    // se não houver nenhuma pessoa, ficam sem dono e são associadas à pessoa cadastrada em seguida
    const destino = perfilAtual || (perfisNovos[0] && perfisNovos[0].id) || null;
    let semDono = 0;
    const ajustados = validos.map((r) => { if (!r.profileId || !idsPerfil.has(r.profileId)) { semDono++; const c = { ...r }; if (destino) c.profileId = destino; else delete c.profileId; return c; } return r; });
    const atuais = new Map(lsAtuais.map((r) => [r.id, r]));
    const gravar = []; let novos = 0, atualizados = 0, iguais = 0;
    for (const r of ajustados) {
      const a = atuais.get(r.id);
      if (!a) { gravar.push(r); novos++; }
      else if ((r.updatedAt || 0) > (a.updatedAt || 0)) { gravar.push(r); atualizados++; }
      else iguais++;
    }
    const nomeAtual = (perfilDe(destino) || perfisNovos.find((p) => p.id === destino) || { nome: '' }).nome;
    const partes = [`${plural(novos, 'leitura nova', 'leituras novas')}, ${plural(atualizados, 'atualizada', 'atualizadas')}, ${plural(iguais, 'já existente', 'já existentes')}`];
    if (perfisNovos.length) partes.push(`${plural(perfisNovos.length, 'pessoa nova', 'pessoas novas')}: ${perfisNovos.map((p) => p.nome).join(', ')}`);
    if (semDono) partes.push(destino ? `${plural(semDono, 'leitura sem pessoa definida vai', 'leituras sem pessoa definida vão')} para ${nomeAtual}` : `${plural(semDono, 'leitura será associada', 'leituras serão associadas')} à pessoa que você cadastrar em seguida`);
    if (invalidos) partes.push(`${plural(invalidos, 'ignorada', 'ignoradas')} por estar incompleta`);
    const ok = await dialog({ title: 'Importar backup?', text: partes.join('. ') + '. Nenhuma leitura atual será apagada.', buttons: [{ label: 'Cancelar', value: false }, { label: 'Importar', value: true, cls: 'btn-start' }] });
    if (!ok) return;
    await DB.importar(perfisNovos, gravar);
    const [psDepois, lsDepois] = await Promise.all([DB.perfis(), DB.all()]);
    const idsL = new Set(lsDepois.map((r) => r.id)), idsP = new Set(psDepois.map((p) => p.id));
    const faltando = gravar.filter((r) => !idsL.has(r.id)).length + perfisNovos.filter((p) => !idsP.has(p.id)).length;
    if (faltando) throw new Error(`${faltando} itens não foram gravados.`);
    if (!perfilAtual && perfisNovos.length) { perfilAtual = perfisNovos[0].id; salvarPerfilAtual(perfilAtual); }
    const vinhaDoCadastro = telaAtual === 'perfil' && !psAtuais.length;
    toast(gravar.length || perfisNovos.length ? plural(gravar.length, 'leitura importada', 'leituras importadas') + (perfisNovos.length ? ` · ${plural(perfisNovos.length, 'pessoa', 'pessoas')}` : '') : 'Nada novo para importar');
    if (vinhaDoCadastro && perfisNovos.length) mostrar('inicio', false);
    await carregar();
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
  const st = { periodo: 'semana', ancora: null, modo: 'valores', pulso: true, sel: null, itens: [], filtro: '' };
  const passaFiltro = (r) => !st.filtro || (st.filtro === 'qualquer' ? temNota(r) : !!(r.nota && r.nota.cats && r.nota.cats[st.filtro]));
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
    const asc = registros.filter(passaFiltro).sort((x, y) => x.ts - y.ts);
    const j = janela(st.periodo, st.ancora);
    let todos;
    if (st.periodo === 'mes') {
      const grupos = new Map();
      for (const r of asc) { const k = chaveDia(r.ts); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(r); }
      todos = [...grupos.entries()].map(([k, rs]) => ({ id: 'd-' + k, ts: inicioDia(rs[0].ts) + DIA_MS / 2, sys: media(rs.map((r) => r.sys)), dia: media(rs.map((r) => r.dia)), pulse: media(rs.map((r) => r.pulse)), n: rs.length, notas: rs.filter(temNota) }));
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
  const AX = 36, GT = 34, PH = 172, XB = 30, PGAP = 26, HP = 112;
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
  // caminho estilo monitor cardíaco: linha entre os pontos com um "batimento" logo depois de cada leitura
  function tracadoECG(pts, raio) {
    if (!pts.length) return '';
    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b.x - a.x;
      if (dx > raio * 2 + 16) {
        // P, QRS e T compactos (14 px), logo depois do losango
        const x0 = a.x + raio + 1, y0 = a.y + ((b.y - a.y) * (raio + 1)) / dx;
        d += ` L${x0.toFixed(1)},${y0.toFixed(1)} l2,-3 l2,3 l1.5,4 l2,-18 l2,22 l1.5,-8 l3,-3 l2,3`;
      }
      d += ` L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    }
    return `<path class="ecg" d="${d}" fill="none" stroke="var(--pulso)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  function grafico(itens, j) {
    const box = $('#pn-grafico');
    const disp = Math.max(260, (box.clientWidth || 340) - AX - 2);
    const cs = casas(itens, j);
    let total = cs.reduce((a, c) => a + c.w, 0) + 16;
    const f = total < disp ? disp / total : 1;
    cs.forEach((c) => { c.w *= f; });
    total = Math.max(disp, Math.round(total * f));
    let acc = 8 * f; cs.forEach((c) => { c.x = acc + c.w / 2; acc += c.w; });
    const comPulso = st.pulso;
    const P0 = GT + PH + PGAP;                       // topo do painel do pulso
    const fimPlot = comPulso ? P0 + HP : GT + PH;    // fim da última área de gráfico
    const GH = fimPlot + XB;
    let g = '', eixo = '', marcas = '', alvos = '', fundo = '';
    // painel do pulso: papel de eletrocardiograma
    if (comPulso) {
      fundo += `<defs><pattern id="papel-ecg" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="#F6D9C2" stroke-width="0.6"/></pattern></defs>`;
      fundo += `<rect class="grade-pulso" x="0" y="${P0}" width="${total}" height="${HP}" fill="#FFF7F0"/><rect x="0" y="${P0}" width="${total}" height="${HP}" fill="url(#papel-ecg)"/>`;
      eixo += `<text x="${AX - 4}" y="${P0 - 9}" font-size="9.5" font-weight="700" text-anchor="end" fill="var(--pulso)">♥bpm</text>`;
    }
    // rótulos do eixo X (embaixo de tudo) e divisórias entre dias (atravessam os dois painéis)
    const yRot = GH - 9;
    if (st.periodo === 'dia') cs.forEach((c) => { g += `<text x="${c.x.toFixed(1)}" y="${yRot}" font-size="11" text-anchor="middle" fill="#6B757D">${c.rot}</text>`; });
    else {
      let i = 0;
      while (i < cs.length) {
        let k = i; while (k + 1 < cs.length && cs[k + 1].grupo === cs[i].grupo) k++;
        const x0 = cs[i].x - cs[i].w / 2, x1 = cs[k].x + cs[k].w / 2, xm = (x0 + x1) / 2;
        const temLeitura = cs.slice(i, k + 1).some((c) => c.it);
        if (st.periodo === 'semana' || temLeitura || new Date(cs[i].dia).getDate() % 5 === 1)
          g += `<text x="${xm.toFixed(1)}" y="${yRot}" font-size="${st.periodo === 'semana' ? 11 : 10.5}" text-anchor="middle" fill="${temLeitura ? '#3B4650' : '#A3ACB2'}" font-weight="${temLeitura ? 600 : 400}">${cs[i].rot}</text>`;
        if (i > 0) {
          g += `<line x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${GT}" y2="${GT + PH}" stroke="#EDF0EB"/>`;
          if (comPulso) g += `<line x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${P0}" y2="${P0 + HP}" stroke="#EDC9AA"/>`;
        }
        i = k + 1;
      }
    }
    const comItem = cs.filter((c) => c.it);
    const svgEixo = (conteudo) => `<svg class="eixo" viewBox="0 0 ${AX} ${GH}" width="${AX}" height="${GH}" aria-hidden="true">${conteudo}</svg>`;
    const svgPrincipal = (conteudo, rotulo) => `<div class="gr-wrap">${svgEixo(eixo)}<div class="gr-rolagem"><svg class="principal" viewBox="0 0 ${total} ${GH}" width="${total}" height="${GH}" role="img" aria-label="${rotulo}">${conteudo}</svg></div></div>`;
    if (!comItem.length) {
      g += `<text x="${total / 2}" y="${GT + PH / 2}" text-anchor="middle" font-size="13" fill="#6B757D">Nenhuma leitura neste período</text>`;
      return svgPrincipal(fundo + g, 'Gráfico vazio');
    }
    const menorCasa = Math.min(...comItem.map((c) => c.w));
    const bw = Math.max(16, Math.min(26, menorCasa * 0.5));
    const raio = Math.max(12, bw / 2 + 2);
    // escala própria do pulso
    const pulsos = comItem.map((c) => c.it.pulse);
    let plo = Math.floor((Math.min(...pulsos) - 12) / 10) * 10, phi = Math.ceil((Math.max(...pulsos) + 12) / 10) * 10;
    if (phi - plo < 40) { const m = (phi + plo) / 2; plo = Math.floor((m - 20) / 10) * 10; phi = plo + 40; }
    const YP = (v) => P0 + 16 + ((phi - v) * (HP - 32)) / (phi - plo);
    if (st.modo === 'valores') {
      const fx = faixaDe(perfilDe(perfilAtual));
      let lo = Math.min(fx.dia, ...itens.map((it) => it.dia)), hi = Math.max(fx.sys, ...itens.map((it) => it.sys));
      lo = Math.floor((lo - 12) / 10) * 10; hi = Math.ceil((hi + 12) / 10) * 10;
      const Y = (v) => GT + ((hi - v) * PH) / (hi - lo);
      const passo = hi - lo > 100 ? 40 : 20;
      for (let v = Math.ceil(lo / passo) * passo; v <= hi; v += passo) { g = `<line x1="0" x2="${total}" y1="${Y(v)}" y2="${Y(v)}" stroke="#E6EAE4"/>` + g; if (Math.abs(Y(v) - Y(fx.sys)) > 10 && Math.abs(Y(v) - Y(fx.dia)) > 10) eixo += `<text x="${AX - 6}" y="${Y(v) + 3.5}" font-size="10" text-anchor="end" fill="#6B757D">${v}</text>`; }
      // faixa de referência: amarelo bem suave entre o limite da diastólica e o da sistólica
      const yS = Y(fx.sys), yD = Y(fx.dia);
      g = `<rect class="faixa-ref" x="0" y="${yS.toFixed(1)}" width="${total}" height="${(yD - yS).toFixed(1)}" fill="rgba(240,196,40,0.16)"/><line x1="0" x2="${total}" y1="${yS.toFixed(1)}" y2="${yS.toFixed(1)}" stroke="#E2BE3C" stroke-width="1" stroke-dasharray="5 4"/><line x1="0" x2="${total}" y1="${yD.toFixed(1)}" y2="${yD.toFixed(1)}" stroke="#E2BE3C" stroke-width="1" stroke-dasharray="5 4"/>` + g;
      eixo += `<text x="${AX - 6}" y="${(yS + 3.5).toFixed(1)}" font-size="10" text-anchor="end" fill="#A78712" font-weight="700">${fx.sys}</text><text x="${AX - 6}" y="${(yD + 3.5).toFixed(1)}" font-size="10" text-anchor="end" fill="#A78712" font-weight="700">${fx.dia}</text>`;
      for (const c of comItem) {
        const it = c.it, x = c.x, ys = Y(it.sys), yd = Y(it.dia), sel = it.id === st.sel, fora = foraDaFaixa(it, fx);
        g += `<rect class="barra-pa${fora ? ' fora' : ''}" x="${(x - bw / 2).toFixed(1)}" y="${ys.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, yd - ys).toFixed(1)}" rx="${(bw / 2).toFixed(1)}" fill="${fora ? 'rgba(232,126,40,0.62)' : 'rgba(46,50,114,0.20)'}"${sel ? ' stroke="var(--tinta)" stroke-width="2.5"' : ''}/>`;
        g += `<circle cx="${x.toFixed(1)}" cy="${ys.toFixed(1)}" r="${raio}" fill="var(--sys)" stroke="#fff" stroke-width="2"/><text class="num-sys" x="${x.toFixed(1)}" y="${(ys + 4).toFixed(1)}" font-size="12" font-weight="700" text-anchor="middle" fill="#fff">${abrev(it.sys)}</text>`;
        g += `<circle cx="${x.toFixed(1)}" cy="${yd.toFixed(1)}" r="${raio}" fill="var(--dia)" stroke="#fff" stroke-width="2"/><text class="num-dia" x="${x.toFixed(1)}" y="${(yd + 4).toFixed(1)}" font-size="12" font-weight="700" text-anchor="middle" fill="#fff">${abrev(it.dia)}</text>`;
      }
      if (comPulso) {
        const pp = passoPulso(phi - plo);
        for (let v = Math.ceil(plo / pp) * pp; v <= phi; v += pp) { g += `<line x1="0" x2="${total}" y1="${YP(v).toFixed(1)}" y2="${YP(v).toFixed(1)}" stroke="#E9B98F" stroke-width="0.8"/>`; eixo += `<text x="${AX - 6}" y="${(YP(v) + 3.5).toFixed(1)}" font-size="10" text-anchor="end" fill="var(--pulso)" font-weight="600">${v}</text>`; }
        const pts = comItem.map((c) => ({ x: c.x, y: YP(c.it.pulse) }));
        g += tracadoECG(pts, 15);
        const lado = 21;
        for (const c of comItem) {
          const x = c.x, y = YP(c.it.pulse), sel = c.it.id === st.sel;
          g += `<rect x="${(x - lado / 2).toFixed(1)}" y="${(y - lado / 2).toFixed(1)}" width="${lado}" height="${lado}" rx="3" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})" fill="var(--pulso)" stroke="${sel ? 'var(--ambar)' : '#fff'}" stroke-width="${sel ? 3 : 2}"/><text class="num-pulso" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="${c.it.pulse >= 100 ? 10.5 : 12}" font-weight="700" text-anchor="middle" fill="#fff">${c.it.pulse}</text>`;
        }
      }
    } else {
      const ds = itens.filter((it) => it.prev).flatMap((it) => [it.sys - it.prev.sys, it.dia - it.prev.dia]);
      const m = Math.max(10, Math.ceil((Math.max(0, ...ds.map(Math.abs)) + 2) / 10) * 10);
      const Y = (v) => GT + ((m - v) * PH) / (2 * m);
      for (const v of [-m, -m / 2, 0, m / 2, m]) { const vv = Math.round(v); g = `<line x1="0" x2="${total}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? '#9AA4AB' : '#E6EAE4'}"/>` + g; eixo += `<text x="${AX - 6}" y="${Y(v) + 3.5}" font-size="10" text-anchor="end" fill="#6B757D">${vv > 0 ? '+' + vv : vv < 0 ? '−' + -vv : '0'}</text>`; }
      const sb = Math.max(7, Math.min(13, (menorCasa * 0.7) / 2));
      for (const c of comItem) {
        const it = c.it, x = c.x;
        if (!it.prev) { g += `<circle cx="${x.toFixed(1)}" cy="${Y(0)}" r="4" fill="none" stroke="#9AA4AB" stroke-width="1.5"/>`; continue; }
        [it.sys - it.prev.sys, it.dia - it.prev.dia].forEach((d, k) => {
          const x0 = x - sb + k * sb, y0 = Y(Math.max(0, d)), hh = Math.max(2, Math.abs(Y(d) - Y(0)));
          g += `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(sb - 1.5).toFixed(1)}" height="${hh.toFixed(1)}" rx="1.5" fill="${d > 0 ? 'var(--sobe)' : d < 0 ? 'var(--desce)' : '#9AA4AB'}" opacity="${k === 1 ? 0.65 : 1}"/>`;
        });
      }
      if (comPulso) {
        const dp = itens.filter((it) => it.prev).map((it) => it.pulse - it.prev.pulse);
        const mp = Math.max(10, Math.ceil((Math.max(0, ...dp.map(Math.abs)) + 2) / 10) * 10);
        const Yd = (v) => P0 + 12 + ((mp - v) * (HP - 24)) / (2 * mp);
        for (const v of [-mp, 0, mp]) { g += `<line x1="0" x2="${total}" y1="${Yd(v).toFixed(1)}" y2="${Yd(v).toFixed(1)}" stroke="${v === 0 ? '#C98A57' : '#E9B98F'}" stroke-width="${v === 0 ? 1.2 : 0.8}"/>`; eixo += `<text x="${AX - 6}" y="${(Yd(v) + 3.5).toFixed(1)}" font-size="10" text-anchor="end" fill="var(--pulso)" font-weight="600">${v > 0 ? '+' + v : v < 0 ? '−' + -v : '0'}</text>`; }
        for (const c of comItem) {
          const it = c.it, x = c.x;
          if (!it.prev) { g += `<circle cx="${x.toFixed(1)}" cy="${Yd(0).toFixed(1)}" r="4" fill="none" stroke="#C98A57" stroke-width="1.5"/>`; continue; }
          const d = it.pulse - it.prev.pulse, y0 = Yd(Math.max(0, d)), hh = Math.max(2, Math.abs(Yd(d) - Yd(0)));
          g += `<rect class="barra-pulso" x="${(x - sb / 2).toFixed(1)}" y="${y0.toFixed(1)}" width="${sb.toFixed(1)}" height="${hh.toFixed(1)}" rx="1.5" fill="var(--pulso)"/>`;
        }
      }
    }
    // seleção: guia vertical (atravessa os dois painéis) + etiqueta
    const s = comItem.find((c) => c.it.id === st.sel);
    if (s) {
      const x = s.x, it = s.it, d = new Date(it.ts);
      marcas += `<line x1="${x}" x2="${x}" y1="${GT - 6}" y2="${fimPlot}" stroke="var(--ambar)" stroke-width="2" stroke-dasharray="4 3"/>`;
      const txt = st.periodo === 'mes' ? `${DIAS_CURTOS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} · média ${it.sys}/${it.dia} · ${it.pulse}` : `${DIAS_CURTOS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${fmtHora(it.ts)} · ${it.sys}/${it.dia} · ${it.pulse}`;
      const tw = txt.length * 6.1 + 16, tx = Math.min(total - tw - 2, Math.max(2, x - tw / 2));
      marcas += `<rect x="${tx}" y="5" width="${tw}" height="21" rx="10.5" fill="var(--tinta)"/><text x="${tx + tw / 2}" y="19.5" font-size="11" text-anchor="middle" fill="#fff" font-weight="600">${esc(txt)}</text>`;
    }
    for (const c of comItem) alvos += `<circle class="alvo" data-id="${esc(c.it.id)}" cx="${c.x.toFixed(1)}" cy="${GT + PH / 2}" r="0" fill="transparent"/>`;
    return svgPrincipal(fundo + g + marcas + alvos, `Gráfico de ${comItem.length} ${st.periodo === 'mes' ? 'dias' : 'leituras'}${comPulso ? ', com pulso abaixo' : ''}; toque num ponto para ver na lista`);
  }
  const passoPulso = (span) => (span > 100 ? 40 : span > 40 ? 20 : 10);
  // ---------- lista ----------
  function lista(itens) {
    if (!itens.length) return `<p class="pn-vazio">${st.filtro ? 'Nenhuma leitura com esta nota' : 'Nenhuma leitura'} ${st.periodo === 'dia' ? 'neste dia' : st.periodo === 'semana' ? 'nesta semana' : 'neste mês'}.${registros.filter(passaFiltro).length ? ' Use as setas para ver outros períodos.' : ''}</p>`;
    let html = '', grupo = '';
    for (const it of itens.slice().reverse()) {
      const d = new Date(it.ts);
      if (st.periodo === 'semana') { const gdia = fmtDia(it.ts); if (gdia !== grupo) { if (grupo) html += '</ul>'; html += `<div class="dia-titulo">${esc(gdia)}</div><ul class="lista">`; grupo = gdia; } }
      else if (!grupo) { html += '<ul class="lista">'; grupo = 'x'; }
      const quando = st.periodo === 'mes' ? `<b>${d.getDate()}</b>${DIAS_CURTOS[d.getDay()]}` : `<b>${fmtHora(it.ts)}</b>`;
      const sub = st.periodo === 'mes' ? `média de ${plural(it.n, 'leitura', 'leituras')}` : '';
      let meio, dir;
      if (st.modo === 'valores') {
        const fora = foraDaFaixa(it, faixaDe(perfilDe(perfilAtual)));
        meio = `<span class="valores${fora ? ' fora' : ''}">${it.sys}/${it.dia}${fora ? '<span class="sr"> (fora da faixa)</span>' : ''}${sub ? `<span class="sub">${sub}</span>` : ''}</span>`;
        dir = `${it.pulse} bpm`;
      } else if (!it.prev) {
        meio = `<span class="valores"><span class="sub">primeira leitura registrada</span>${it.sys}/${it.dia}</span>`; dir = `${it.pulse} bpm`;
      } else {
        meio = `<span class="valores">${delta(it.sys, it.prev.sys)}${delta(it.dia, it.prev.dia)}<span class="sub">${it.sys}/${it.dia} ${st.periodo === 'mes' ? 'vs dia anterior com leitura' : 'vs leitura anterior'}</span></span>`;
        dir = `${delta(it.pulse, it.prev.pulse)}<span class="sub">${it.pulse} bpm</span>`;
      }
      const notas = it.rec ? (temNota(it.rec) ? [it.rec] : []) : (it.notas || []);
      let exp = '';
      if (it.id === st.sel && notas.length) exp = `<div class="nota-exp">${notas.map((r) => `${st.periodo === 'mes' ? `<div class="nota-exp-h">${fmtHora(r.ts)} · ${r.sys}/${r.dia}</div>` : ''}${notaLinhas(r.nota).map((l) => `<div><b>${esc(l.nome)}:</b> ${esc(l.texto)}</div>`).join('')}`).join('')}</div>`;
      html += `<li><button class="pn-item${it.id === st.sel ? ' sel' : ''}" data-id="${esc(it.id)}"><span class="quando">${quando}</span>${meio.replace(/<\/span>$/, (notas.length ? ICONE_NOTA : '') + '</span>')}<span class="dir">${dir}</span></button>${exp}</li>`;
    }
    return html + '</ul>';
  }
  // ---------- navegação só por períodos com leituras ----------
  function vizinho(dir) {
    const j = janela(st.periodo, st.ancora);
    const asc = registros.filter(passaFiltro).sort((x, y) => x.ts - y.ts);
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
    // filtro: nome direto da categoria + quantidade; opções vazias ficam desativadas
    const fsel = $('#pn-filtro');
    const conta = (k) => registros.filter((r) => (k === 'qualquer' ? temNota(r) : !!(r.nota && r.nota.cats && r.nota.cats[k]))).length;
    const opcs = [['', 'Todas as leituras', registros.length], ['qualquer', 'Anotação', conta('qualquer')]].concat(CATEGORIAS.map((c) => [c.k, c.nome, conta(c.k)]));
    if (st.filtro && !opcs.some(([k, , n]) => k === st.filtro && n > 0)) st.filtro = '';
    fsel.innerHTML = opcs.map(([k, nome, n]) => `<option value="${k}"${k && !n ? ' disabled' : ''}>${esc(nome)} (${n})</option>`).join('');
    fsel.value = st.filtro;
    const { j, itens, noPeriodo, antes } = montarItens();
    st.itens = itens;
    if (st.sel && !itens.some((it) => it.id === st.sel)) st.sel = null;
    document.querySelectorAll('#painel [data-p]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.p === st.periodo)));
    document.querySelectorAll('#painel [data-m]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.m === st.modo)));
    $('#pn-pulso').setAttribute('aria-pressed', String(st.pulso));
    $('#pn-rotulo-txt').textContent = rotulo(st.periodo, j);
    $('#pn-param-txt').textContent = faixaTexto(faixaDe(perfilDe(perfilAtual)));
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
  // ---------- escolher a faixa de referência ----------
  function abrirFaixas() {
    const p = perfilDe(perfilAtual); if (!p) return;
    const atual = faixaDe(p);
    const pers = p.parametro && p.parametro.id === 'personalizado' ? p.parametro : { sys: 130, dia: 85 };
    const f = document.createElement('div'); f.className = 'fundo';
    f.innerHTML = `<div class="dialogo faixas" role="dialog" aria-modal="true" aria-labelledby="fx-t">
      <h3 id="fx-t">Faixa de referência de ${esc(p.nome)}</h3>
      <p class="fx-dica">Leituras acima do limite aparecem em laranja no gráfico.</p>
      <div class="fx-lista" role="radiogroup">
        ${FAIXAS.map((x) => `<label class="fx-op"><input type="radio" name="fx" value="${x.id}"${atual.id === x.id ? ' checked' : ''}><span><b>${esc(x.nome)}</b><em>${x.inclusivo ? 'Até' : 'Abaixo de'} ${x.sys}/${x.dia}</em><small>${esc(x.desc)}</small></span></label>`).join('')}
        <label class="fx-op"><input type="radio" name="fx" value="personalizado"${atual.id === 'personalizado' ? ' checked' : ''}><span><b>Personalizada</b><small>Para quem tem uma faixa própria definida pelo médico.</small>
          <span class="fx-pers"><span class="campo" id="fx-c-sys"><label for="fx-sys">Sistólica até</label><input id="fx-sys" type="number" inputmode="numeric" min="90" max="200" value="${pers.sys}"></span>
          <span class="campo" id="fx-c-dia"><label for="fx-dia">Diastólica até</label><input id="fx-dia" type="number" inputmode="numeric" min="50" max="130" value="${pers.dia}"></span></span>
          <span class="msg-erro" id="fx-erro" hidden></span></span></label>
      </div>
      <p class="fx-nota">As faixas das diretrizes valem para a medida no consultório. Em casa, a diretriz considera hipertensão a partir de 130/80 (no consultório, 140/90). Na dúvida, use a faixa indicada pelo seu médico.</p>
      <div class="botoes"><button class="btn btn-sec" data-fx="cancelar">Cancelar</button><button class="btn btn-start" data-fx="salvar">Salvar</button></div>
    </div>`;
    const marcarPers = () => { const pe = f.querySelector('input[value="personalizado"]'); f.querySelector('.fx-pers').classList.toggle('ativo', pe.checked); };
    f.addEventListener('change', marcarPers);
    f.addEventListener('focusin', (ev) => { if (ev.target.id === 'fx-sys' || ev.target.id === 'fx-dia') { f.querySelector('input[value="personalizado"]').checked = true; marcarPers(); } });
    f.onclick = async (ev) => {
      if (ev.target === f) { f.remove(); return; }
      const b = ev.target.closest('[data-fx]'); if (!b) return;
      if (b.dataset.fx === 'cancelar') { f.remove(); return; }
      const id = f.querySelector('input[name="fx"]:checked').value;
      let parametro = { id };
      if (id === 'personalizado') {
        const sy = Number(f.querySelector('#fx-sys').value), di = Number(f.querySelector('#fx-dia').value), er = f.querySelector('#fx-erro');
        let msg = '';
        if (!Number.isInteger(sy) || sy < 90 || sy > 200) msg = 'Sistólica entre 90 e 200.';
        else if (!Number.isInteger(di) || di < 50 || di > 130) msg = 'Diastólica entre 50 e 130.';
        else if (di >= sy) msg = 'A diastólica precisa ser menor que a sistólica.';
        if (msg) { er.textContent = msg; er.hidden = false; return; }
        parametro = { id, sys: sy, dia: di };
      }
      b.disabled = true;
      try {
        const novo = { ...p, parametro, updatedAt: Date.now() };
        await DB.putPerfil(novo);
        const conf = (await DB.perfis()).find((x) => x.id === p.id);
        if (!conf || JSON.stringify(conf.parametro) !== JSON.stringify(parametro)) throw new Error('A faixa não foi encontrada no armazenamento depois de salvar.');
        perfis = perfis.map((x) => (x.id === p.id ? conf : x));
        f.remove(); render(); toast(`Faixa: ${faixaTexto(faixaDe(conf))}`);
      } catch (e) {
        b.disabled = false;
        await dialog({ title: 'A faixa NÃO foi salva', detail: String(e && e.message || e), buttons: [{ label: 'Ok', value: 1, cls: 'btn-start' }] });
      }
    };
    $('#camada').appendChild(f);
    marcarPers();
    const sel = f.querySelector('input[name="fx"]:checked'); if (sel) sel.focus();
  }
  // ---------- calendário ----------
  function abrirCalendario() {
    const doFiltro = registros.filter(passaFiltro);
    const diasCom = new Set(doFiltro.map((r) => chaveDia(r.ts)));
    if (!diasCom.size) { toast('Ainda não há leituras registradas'); return; }
    const mesesCom = [...new Set(doFiltro.map((r) => { const d = new Date(r.ts); return d.getFullYear() * 12 + d.getMonth(); }))].sort((a, b) => a - b);
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
    st.ancora = ult ? ult.ts : Date.now(); st.sel = null; st.filtro = '';
    const p = perfilDe(perfilAtual); $('#painel-pessoa').textContent = p ? p.nome : '';
    mostrar('painel');
    render('fim');
  }
  $('#pn-filtro').addEventListener('change', (ev) => {
    st.filtro = ev.target.value; st.sel = null;
    // se o período atual ficou vazio com o filtro, vai para o período mais recente que tenha leituras
    const lst = registros.filter(passaFiltro);
    const j = janela(st.periodo, st.ancora);
    if (lst.length && !lst.some((r) => r.ts >= j.ini && r.ts < j.fim)) st.ancora = lst[0].ts;
    render('fim');
  });
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
  $('#pn-param').onclick = abrirFaixas;
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

// o aviso de erro de um campo some assim que a pessoa corrige
function limparCampo(el) { const c = el.closest('.campo.erro'); if (c) { c.classList.remove('erro'); const m = c.querySelector('.msg-erro'); if (m) m.hidden = true; } }
document.addEventListener('input', (ev) => limparCampo(ev.target));

// ====================== ligações ======================
$('#btn-add').onclick = abrirAdicionar;
$('#btn-perfil').onclick = () => Perfil.abrirFolha();
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
