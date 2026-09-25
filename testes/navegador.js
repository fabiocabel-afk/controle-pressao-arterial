// Testes ponta a ponta do PWA (Chrome headless + câmera falsa com foto real do visor)
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');

const URL_APP = process.env.URL_APP || 'http://localhost:8765/';
const DL = path.join(__dirname, 'saida', 'downloads'); const OUT = path.join(__dirname, 'saida');
if (!fs.existsSync(path.join(OUT, 'cam.y4m'))) { console.error('Gere o vídeo da câmera falsa primeiro (veja LEIA-ME.md).'); process.exit(2); }
fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });

let passou = 0, falhou = 0; const erros = [];
function check(nome, cond, extra) { if (cond) { passou++; console.log('  ok  ', nome); } else { falhou++; console.log('  FALHA', nome, extra !== undefined ? JSON.stringify(extra) : ''); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: 'new',
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(OUT, 'cam.y4m')],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }));
  const vis = (sel) => page.$eval(sel, (e) => !e.hidden && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  const txt = (sel) => page.$eval(sel, (e) => e.textContent);
  const val = (sel) => page.$eval(sel, (e) => e.value);
  const setVal = async (sel, v) => { await page.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, String(v)); };

  console.log('1. Abertura');
  await page.goto(URL_APP, { waitUntil: 'networkidle0' });
  check('tela inicial visível', await vis('#inicio'));
  check('estado vazio orienta o usuário', (await txt('#ultimo')).includes('Nenhuma leitura'));
  await page.screenshot({ path: path.join(OUT, 's1-vazio.png') });

  console.log('2. Leitura pela câmera (foto real 154/97/99)');
  const t0 = Date.now();
  await page.click('#btn-medir');
  await page.waitForFunction(() => !document.querySelector('#camera').hidden, { timeout: 5000 });
  await sleep(500); await page.screenshot({ path: path.join(OUT, 's2-camera.png') });
  await page.waitForFunction(() => !document.querySelector('#conferir').hidden, { timeout: 45000 }).catch(() => {});
  const conf = await vis('#conferir');
  check('câmera chegou à tela de conferência', conf, await txt('#cam-status').catch(() => ''));
  console.log('     tempo até a conferência:', Date.now() - t0, 'ms');
  check('valores lidos 154/97/99', (await val('#in-sys')) === '154' && (await val('#in-dia')) === '97' && (await val('#in-pul')) === '99', [await val('#in-sys'), await val('#in-dia'), await val('#in-pul')]);
  check('câmera desligada após a leitura', await page.$eval('#video', (v) => !v.srcObject));
  check('recorte do visor exibido', await page.$eval('#recorte', (c) => !c.hidden));
  await page.screenshot({ path: path.join(OUT, 's3-conferir.png') });

  console.log('3. Ler novamente e salvar');
  await page.click('#btn-reler');
  await page.waitForFunction(() => !document.querySelector('#conferir').hidden && document.querySelector('#in-sys').value === '154', { timeout: 45000 }).catch(() => {});
  check('"Ler novamente" volta à câmera e lê de novo', (await val('#in-sys')) === '154');
  await page.click('#btn-salvar');
  await page.waitForFunction(() => !document.querySelector('#inicio').hidden && document.querySelectorAll('.item').length === 1, { timeout: 5000 }).catch(() => {});
  check('leitura aparece no histórico', (await page.$$('.item')).length === 1);
  check('visor da última leitura mostra 154', (await page.$eval('#ultimo', (e) => e.innerHTML)).includes('Sistólica 154'));

  console.log('4. Persistência após recarregar');
  await page.reload({ waitUntil: 'networkidle0' });
  check('leitura continua salva após recarregar', (await page.$$('.item')).length === 1);

  console.log('5. Digitação manual e validação');
  await page.click('#btn-digitar');
  await setVal('#in-sys', 80); await setVal('#in-dia', 90); await setVal('#in-pul', 70);
  await page.click('#btn-salvar'); await sleep(300);
  check('bloqueia diastólica maior que sistólica', await vis('#conferir') && (await page.$eval('#c-dia .msg-erro', (e) => !e.hidden)));
  await setVal('#in-sys', 999); await page.click('#btn-salvar'); await sleep(200);
  check('bloqueia valor fora da faixa', await page.$eval('#c-sys .msg-erro', (e) => !e.hidden));
  await setVal('#in-sys', 128); await setVal('#in-dia', 84); await setVal('#in-pul', 70);
  const ontem = await page.evaluate(() => { const d = new Date(Date.now() - 86400000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T08:15`; });
  await setVal('#in-data', ontem);
  await page.click('#btn-salvar');
  await page.waitForFunction(() => document.querySelectorAll('.item').length === 2, { timeout: 5000 }).catch(() => {});
  check('leitura manual salva', (await page.$$('.item')).length === 2);
  check('gráfico aparece com 2 leituras', await vis('#bloco-grafico'));
  check('agrupado por dia (Hoje e Ontem)', (await page.$$eval('.dia-titulo', (a) => a.map((e) => e.textContent))).join('|') === 'Hoje|Ontem');
  check('marcada como digitada', (await txt('#lista')).includes('digitada'));
  await page.screenshot({ path: path.join(OUT, 's4-inicio.png'), fullPage: true });

  console.log('6. Edição');
  await page.click('.item'); // a mais recente (câmera)
  await page.waitForFunction(() => !document.querySelector('#conferir').hidden);
  check('tela de edição', (await txt('#conf-titulo')) === 'Editar leitura' && await vis('#btn-excluir'));
  await setVal('#in-pul', 98); await page.click('#btn-salvar');
  await page.waitForFunction(() => !document.querySelector('#inicio').hidden, { timeout: 5000 });
  await sleep(200);
  check('alteração salva e marcada como corrigida', (await txt('#lista')).includes('98 bpm') && (await txt('#lista')).includes('corrigida'));

  console.log('7. Exportar e importar backup');
  await page.click('#btn-menu'); await page.click('[data-a="json"]'); await sleep(1500);
  const arqs = fs.readdirSync(DL).filter((f) => f.endsWith('.json'));
  check('arquivo de backup baixado', arqs.length === 1, arqs);
  let backup = null; try { backup = JSON.parse(fs.readFileSync(path.join(DL, arqs[0]), 'utf8')); } catch (_) {}
  check('backup contém as 2 leituras', backup && backup.leituras && backup.leituras.length === 2);
  await page.click('#btn-menu'); await page.click('[data-a="csv"]'); await sleep(1200);
  const csv = fs.readdirSync(DL).find((f) => f.endsWith('.csv'));
  check('CSV baixado com cabeçalho e 2 linhas', csv && fs.readFileSync(path.join(DL, csv), 'utf8').trim().split(/\r?\n/).length === 3);

  console.log('8. Exclusão');
  await page.click('.item');
  await page.waitForFunction(() => !document.querySelector('#conferir').hidden);
  await page.click('#btn-excluir'); await sleep(200);
  const bts = await page.$$('.dialogo .btn'); await bts[bts.length - 1].click();
  await page.waitForFunction(() => document.querySelectorAll('.item').length === 1, { timeout: 5000 }).catch(() => {});
  check('leitura excluída', (await page.$$('.item')).length === 1);

  console.log('9. Importar o backup de volta (restaura a excluída sem duplicar)');
  const inp = await page.$('#in-backup'); await inp.uploadFile(path.join(DL, arqs[0]));
  await page.waitForSelector('.dialogo', { timeout: 5000 });
  check('resumo da importação: 1 nova', (await txt('.dialogo')).includes('1 leitura nova'), await txt('.dialogo'));
  const bi = await page.$$('.dialogo .btn'); await bi[bi.length - 1].click();
  await page.waitForFunction(() => document.querySelectorAll('.item').length === 2, { timeout: 5000 }).catch(() => {});
  check('backup restaurou a leitura (2 no total)', (await page.$$('.item')).length === 2);

  console.log('10. Leitura de foto com reflexo forte');
  const fi = await page.$('#in-foto'); await fi.uploadFile(path.join(__dirname, 'fotos', '193486.jpg'));
  await page.waitForFunction(() => !document.querySelector('#conferir').hidden, { timeout: 30000 }).catch(() => {});
  check('foto lida: 154/97/99', (await val('#in-sys')) === '154' && (await val('#in-dia')) === '97' && (await val('#in-pul')) === '99', [await val('#in-sys'), await val('#in-dia'), await val('#in-pul')]);
  check('aviso de reflexo exibido (baixa confiança)', await vis('#conf-aviso'));
  await page.screenshot({ path: path.join(OUT, 's5-foto-reflexo.png') });
  await page.click('#btn-conf-fechar'); await sleep(300);
  check('fechar não salva nada', (await page.$$('.item')).length === 2);

  console.log('11. Foto sem visor não inventa leitura');
  const fi2 = await page.$('#in-foto'); await fi2.uploadFile(path.join(__dirname, 'fotos', 'sem-visor.jpg'));
  await page.waitForFunction(() => !document.querySelector('#conferir').hidden, { timeout: 30000 }).catch(() => {});
  check('campos vazios e aviso de falha', (await val('#in-sys')) === '' && (await txt('#conf-aviso')).includes('Não consegui ler'));
  await page.click('#btn-conf-fechar'); await sleep(300);

  console.log('12. Service worker, versão do cache e modo offline');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 10000 }).catch(() => {});
  const cacheKeys = await page.evaluate(() => caches.keys());
  const appVer = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8').match(/APP_VERSION = '([^']+)'/)[1];
  check(`cache com a versão do app (pressao-v${appVer})`, cacheKeys.includes('pressao-v' + appVer), cacheKeys);
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(800);
  check('abre offline com os dados', (await page.$$('.item')).length === 2);
  await page.setOfflineMode(false);

  check('nenhum erro de JavaScript no console', erros.length === 0, erros);
  await browser.close();
  console.log(`\nResultado: ${passou} ok, ${falhou} falhas`);
  process.exit(falhou ? 1 : 0);
})().catch((e) => { console.error('ERRO NO TESTE', e); process.exit(2); });
