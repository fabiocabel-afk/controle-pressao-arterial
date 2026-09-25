// uso: node synthtest2.js N persp maxRot seedBase
const E=require('../app/engine'),S=require('./synth');
const N=+process.argv[2]||30,persp=+process.argv[3]||0.08,maxRot=+process.argv[4]||30,base=+process.argv[5]||5000;
let pass=0,wrongOk=0,noread=0;const t0=Date.now();const R=(()=>{let s=base;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296}})();
for(let i=0;i<N;i++){
  const sys=90+Math.floor(R()*150),dia=40+Math.floor(R()*Math.min(100,sys-45)),pulse=40+Math.floor(R()*140);
  const v=[sys,dia,pulse];const img=S.render(v,base+i,{persp,maxRot});const {best}=E.readImage(img);const r=best.values;
  const good=best.ok&&r.sys===sys&&r.dia===dia&&r.pulse===pulse;
  if(good)pass++;else if(best.ok){if(best.confident)wrongOk++;console.log(best.confident?'ERRADO-CONFIANTE':'errado-baixa-confianca',v.join('/'),'->',[r.sys,r.dia,r.pulse].join('/'),'marg',best.minMargin.toFixed(2),'fix',best.fixes);}else{noread++;console.log('SEM-LEITURA',v.join('/'),best.pattern.join('|'));}
}
console.log(`acertos ${pass}/${N}  leituras erradas aceitas ${wrongOk}  sem leitura ${noread}  ${((Date.now()-t0)/N|0)}ms/img`);
