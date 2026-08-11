import { readFileSync, writeFileSync } from "node:fs";
import { replayDetectoresTeste } from "./replay-detectores-teste.ts";
import { CANDIDATOS } from "./candidatos.ts";
import { replay } from "./replay.ts";
import { PARAMS_DESVIO_TESTE_PADRAO } from "../../src/lib/detectores-teste.ts";

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
const atual = medir((c) => replayDetectoresTeste(PARAMS_DESVIO_TESTE_PADRAO, c.pontos, c.destinosPorPonto), temQueDisparar, naoPodeDisparar);

const bateuCriterio = atual.recall >= baseline.recall && atual.taxaEspuria <= baseline.taxaEspuria;

const relatorio = `# Validacao final -- src/lib/detectores-teste.ts vs baseline pct80

Corpus: ${corpus.length} casos (${temQueDisparar.length} tem_que_disparar, ${naoPodeDisparar.length} nao_pode_disparar).

| | Recall | Taxa de disparo espurio |
|---|---|---|
| Baseline (pct80, producao) | ${(baseline.recall * 100).toFixed(1)}% (${baseline.disparou}/${baseline.tqLen}) | ${(baseline.taxaEspuria * 100).toFixed(1)}% (${baseline.espurios}/${baseline.npLen}) |
| detectores-teste.ts (PARAMS_DESVIO_TESTE_PADRAO) | ${(atual.recall * 100).toFixed(1)}% (${atual.disparou}/${atual.tqLen}) | ${(atual.taxaEspuria * 100).toFixed(1)}% (${atual.espurios}/${atual.npLen}) |

Criterio de aceite (spec, secao 2): recall >= baseline E taxa de disparo
espurio <= baseline, ao mesmo tempo.

**Resultado: ${bateuCriterio ? "BATEU o criterio de aceite." : "NAO bateu o criterio -- PARAMS_DESVIO_TESTE_PADRAO precisa de ajuste (ver Step 3 desta task)."}**
`;

writeFileSync(new URL("./relatorio-detectores-teste.md", import.meta.url), relatorio);
console.log(relatorio);
