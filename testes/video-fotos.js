// Modo ao vivo simulado: foto real com tremor da mão, votação entre quadros
const fs=require('fs'),path=require('path'),jpeg=require('jpeg-js'),E=require('../app/engine');
function shift(img,dx,dy){const {width:w,height:h,data}=img;const o=new Uint8ClampedArray(data.length);
 for(let y=0;y<h;y++){const sy=Math.min(h-1,Math.max(0,y-dy));for(let x=0;x<w;x++){const sx=Math.min(w-1,Math.max(0,x-dx));const a=(y*w+x)*4,b=(sy*w+sx)*4;o[a]=data[b];o[a+1]=data[b+1];o[a+2]=data[b+2];o[a+3]=255;}}
 return {width:w,height:h,data:o};}
const dir=path.join(__dirname,'fotos');let falhas=0;
for(const f of fs.readdirSync(dir).filter(f=>/^\d+\.jpg$/.test(f)).sort()){
  const img=jpeg.decode(fs.readFileSync(path.join(dir,f)),{useTArray:true,maxMemoryUsageInMB:1024});
  const exp=f.startsWith('193458')?'135/93/101':'154/97/99';const tr=E.createTracker();const log=[];let acc=null,q=0;
  for(const [dx,dy] of [[0,0],[6,-4],[-8,5],[3,9],[-5,-7],[10,2],[0,-10],[-4,4],[7,7],[-6,-2]]){q++;const r=tr.process(shift(img,dx,dy));log.push((r.mode==='rastreio'?'r':'b')+r.ms+(r.reading?'':'x'));if(r.vote&&r.vote.done){acc=r.vote;break;}}
  const got=acc?`${acc.values.sys}/${acc.values.dia}/${acc.values.pulse}`:'-';if(got!==exp)falhas++;
  console.log(got===exp?'ok   ':'FALHA',f,'aceito',got,acc?(acc.confident?'(alta)':'(baixa)'):'',`${q} quadros:`,log.join(' '));
}
console.log(falhas?`\n${falhas} FALHAS`:'\nTodas aceitas corretamente');process.exit(falhas?1:0);
