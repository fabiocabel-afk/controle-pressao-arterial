const E=require('../app/engine'),S=require('./synth');
function shift(img,dx,dy){const {width:w,height:h,data}=img;const o=new Uint8ClampedArray(data.length);
 for(let y=0;y<h;y++){const sy=Math.min(h-1,Math.max(0,y-dy));for(let x=0;x<w;x++){const sx=Math.min(w-1,Math.max(0,x-dx));const a=(y*w+x)*4,b=(sy*w+sx)*4;o[a]=data[b];o[a+1]=data[b+1];o[a+2]=data[b+2];o[a+3]=255;}}
 return {width:w,height:h,data:o};}
const R=(()=>{let s=4242;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296}})();
let ok=0,wrong=0,none=0;const N=+process.argv[2]||12;
for(let i=0;i<N;i++){
  const sys=90+Math.floor(R()*150),dia=40+Math.floor(R()*Math.min(100,sys-45)),pulse=40+Math.floor(R()*140);
  const img=S.render([sys,dia,pulse],8000+i,{persp:0.1,maxRot:35});const tr=E.createTracker();let acc=null;
  for(let k=0;k<10&&!acc;k++){const r=tr.process(shift(img,Math.round((R()-.5)*20),Math.round((R()-.5)*20)));if(r.vote&&r.vote.done)acc=r.vote.values;}
  const exp=[sys,dia,pulse].join('/'),got=acc?[acc.sys,acc.dia,acc.pulse].join('/'):'-';
  if(got===exp)ok++;else if(acc){wrong++;console.log('ERRADO',exp,got);}else{none++;console.log('sem leitura',exp);}
}
console.log(`video sintetico: ${ok}/${N} corretos, ${wrong} errados aceitos, ${none} sem leitura`);
