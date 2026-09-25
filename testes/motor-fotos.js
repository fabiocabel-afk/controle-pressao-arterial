// Motor x fotos reais: cada foto precisa dar a leitura esperada
const fs=require('fs'),path=require('path'),jpeg=require('jpeg-js'),E=require('../app/engine');
const dir=path.join(__dirname,'fotos');const esperado={'193458':[135,93,101]};const padrao=[154,97,99];
let ok=0,n=0;
for(const f of fs.readdirSync(dir).filter(f=>/^\d+\.jpg$/.test(f)).sort()){
  const id=f.replace('.jpg','');const img=jpeg.decode(fs.readFileSync(path.join(dir,f)),{useTArray:true,maxMemoryUsageInMB:1024});
  const t0=Date.now();const {best}=E.readImage(img);const ms=Date.now()-t0;const e=esperado[id]||padrao;const v=best.values;
  const bom=best.ok&&v.sys===e[0]&&v.dia===e[1]&&v.pulse===e[2];n++;if(bom)ok++;
  console.log(bom?'ok   ':'FALHA',f,`${v.sys}/${v.dia}/${v.pulse}`,best.confident?'confiança alta':'confiança baixa',ms+'ms');
}
const neg=jpeg.decode(fs.readFileSync(path.join(dir,'sem-visor.jpg')),{useTArray:true,maxMemoryUsageInMB:1024});
const nb=E.readImage(neg).best;const negOk=!nb.ok;console.log(negOk?'ok   ':'FALHA','sem-visor.jpg não gera leitura');
console.log(`\n${ok}/${n} fotos corretas${negOk?'':' + FALHA no negativo'}`);process.exit(ok===n&&negOk?0:1);
