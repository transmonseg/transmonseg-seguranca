// Teste do orquestrador: bate o cliente Unitrac contra a API real.
import { buscarVeiculos, buscarPosicoes, normalizar } from "../../src/lib/unitrac";

const veics = await buscarVeiculos("4096");
console.log("veículos Nutry (4096):", veics.length);

const cvs = veics.map((v: any) => String(v.cv));
const posicoes = await buscarPosicoes(cvs);
console.log("posições retornadas:", posicoes.length);

const norm = posicoes.map(normalizar);
console.log("\n3 posições normalizadas:");
for (const p of norm.slice(0, 3)) {
  console.log(`  ${p.placa} lat=${p.lat?.toFixed(4)} lng=${p.lng?.toFixed(4)} vel=${p.velocidade} ign=${p.ignicao} atraso=${p.atraso} fresco=${p.fresco}`);
}
const frescas = norm.filter((p: any) => p.fresco).length;
console.log(`\nfrescas (atraso<60min): ${frescas} de ${norm.length}`);
const comPanico = norm.filter((p: any) => p.panico).length;
const comBau = norm.filter((p: any) => p.bau).length;
console.log(`pânico agora: ${comPanico} | baú aberto: ${comBau}`);
