import { readFileSync } from "node:fs";
import { replayDetectoresTeste } from "./replay-detectores-teste.ts";
import { CANDIDATOS } from "./candidatos.ts";
import { replay } from "./replay.ts";

const corpus = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf-8"));
const temQueDisparar = corpus.filter((c) => c.rotulo === "tem_que_disparar");
const naoPodeDisparar = corpus.filter((c) => c.rotulo === "nao_pode_disparar");

function medir(fn, tq, np) {
  const pos = tq.map(fn);
  const neg = np.map(fn);
  const disparou = pos.filter((r) => r.disparou).length;
  const espurios = neg.filter((r) => r.disparou).length;
  return {
    recall: tq.length > 0 ? disparou / tq.length : 0,
    disparou, tqLen: tq.length,
    taxaEspuria: np.length > 0 ? espurios / np.length : 0,
    espurios, npLen: np.length,
  };
}

const baseline = medir((c) => replay(CANDIDATOS.get("pct80"), c.pontos, c.destinosPorPonto), temQueDisparar, naoPodeDisparar);
console.log(`Baseline pct80: recall ${(baseline.recall*100).toFixed(1)}% (${baseline.disparou}/${baseline.tqLen})  espuria ${(baseline.taxaEspuria*100).toFixed(1)}% (${baseline.espurios}/${baseline.npLen})`);
console.log("");

const GRADE = [
  { margemRuidoM: 30, decay: 0.6, limiar: 1.67, escalaProximidadeM: 1000, raioVisitaM: 100, contribMaxM: 58 },
  { margemRuidoM: 30, decay: 0.6, limiar: 1.67, escalaProximidadeM: 1000, raioVisitaM: 100, contribMaxM: 60 },
  { margemRuidoM: 30, decay: 0.6, limiar: 1.67, escalaProximidadeM: 1000, raioVisitaM: 100, contribMaxM: 62 },
  { margemRuidoM: 30, decay: 0.6, limiar: 1.665, escalaProximidadeM: 1000, raioVisitaM: 100, contribMaxM: 60 },
  { margemRuidoM: 30, decay: 0.6, limiar: 1.665, escalaProximidadeM: 1000, raioVisitaM: 100, contribMaxM: 62 },
  { margemRuidoM: 30, decay: 0.6, limiar: 1.67, escalaProximidadeM: 900, raioVisitaM: 100, contribMaxM: 60 },
  { margemRuidoM: 30, decay: 0.6, limiar: 1.67, escalaProximidadeM: 1100, raioVisitaM: 100, contribMaxM: 60 },
];

for (const p of GRADE) {
  const atual = medir((c) => replayDetectoresTeste(p, c.pontos, c.destinosPorPonto), temQueDisparar, naoPodeDisparar);
  const bateu = atual.recall >= baseline.recall && atual.taxaEspuria <= baseline.taxaEspuria;
  console.log(`margem=${p.margemRuidoM} decay=${p.decay} limiar=${p.limiar} escala=${p.escalaProximidadeM} raioVisita=${p.raioVisitaM} contribMax=${p.contribMaxM}`);
  console.log(`  recall ${(atual.recall*100).toFixed(1)}% (${atual.disparou}/${atual.tqLen})  espuria ${(atual.taxaEspuria*100).toFixed(1)}% (${atual.espurios}/${atual.npLen})  ${bateu ? "BATEU" : ""}`);
}
