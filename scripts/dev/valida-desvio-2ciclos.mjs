// Valida o AFASTAMENTO (núcleo do detector de desvio) com 2 ciclos reais.
// Coleta posições, dorme ~75s, coleta de novo, e aplica a mesma regra do motor:
// desvio = em movimento, com pendentes, e distância ao pendente mais próximo
// AUMENTOU desde o ciclo anterior. Não grava nada.
const BASE = "https://datalayer.portalunitrac.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jget(u){const r=await fetch(u,{headers:{accept:"application/json"}});return r.ok?r.json():null;}
async function jpost(u,b){const r=await fetch(u,{method:"POST",headers:{accept:"application/json","content-type":"application/json"},body:JSON.stringify(b)});return r.ok?r.json():null;}
function hav(aLat,aLng,bLat,bLng){const R=6371000,t=d=>d*Math.PI/180;const dLat=t(bLat-aLat),dLng=t(bLng-aLng);const h=Math.sin(dLat/2)**2+Math.cos(t(aLat))*Math.cos(t(bLat))*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(h));}

async function snap(cod){
  const vb = await jget(`${BASE}/veiculos/masn/${cod}`);
  const cvs = (vb?.veiculos ?? []).map(v=>String(v.cv ?? v.veicucodigo));
  const pos = await jpost(`${BASE}/mapa_servicos/posicoes/N/N`, cvs);
  const alvos = await jpost(`${BASE}/mapa_servicos/alvos`, cvs);
  const pend = {};
  for (const a of (alvos?.alvos ?? [])) {
    if (a.alvosituacaoservico!==0) continue;
    const lat=+a.pontolatitude,lng=+a.pontolongitude;
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||(lat===0&&lng===0))continue;
    (pend[a.placa] ??= []).push({lat,lng});
  }
  const m={};
  for (const p of (pos?.Posicoes ?? [])) {
    const lat=+p.posiclatitude,lng=+p.posiclongitude;
    m[p.veicuplaca]={lat,lng,vel:parseInt(p.posicvelocidade)||0,atraso:parseInt(p.atraso)||0,pend:pend[p.veicuplaca]||[]};
  }
  return m;
}
function dmin(lat,lng,pts){let d=null;for(const q of pts){const x=hav(lat,lng,q.lat,q.lng);if(d===null||x<d)d=x;}return d;}

for (const [nome,cod] of [["Nutry","4096"],["Benassi","4586"]]) {
  const c1 = await snap(cod);
  await sleep(75000);
  const c2 = await snap(cod);
  let crit=0,aten=0,ok=0; const ex=[];
  for (const placa of Object.keys(c2)) {
    const a=c2[placa], b=c1[placa];
    if(!a||a.atraso>=60||a.vel<=0||!a.lat||!a.pend.length) continue;
    const dNow=dmin(a.lat,a.lng,a.pend);
    if(dNow===null) continue;
    const dPrev = (b&&b.lat)?dmin(b.lat,b.lng,a.pend):null;
    const afast = dPrev!==null && dNow>dPrev+200;
    if(!afast){ok++;continue;}
    if(dNow>=5000){crit++; if(ex.length<8)ex.push(`CRIT ${placa} ${(dNow/1000).toFixed(1)}km (era ${(dPrev/1000).toFixed(1)}) vel=${a.vel}`);}
    else if(dNow>=2500){aten++; if(ex.length<8)ex.push(`aten ${placa} ${(dNow/1000).toFixed(1)}km (era ${(dPrev/1000).toFixed(1)}) vel=${a.vel}`);}
    else ok++;
  }
  console.log(`\n=== ${nome} === critico(desvio): ${crit} | atencao: ${aten} | sem desvio: ${ok}`);
  if(ex.length) console.log(ex.join("\n")); else console.log("(ninguém se afastando o suficiente neste intervalo)");
}
