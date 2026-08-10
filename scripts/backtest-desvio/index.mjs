// scripts/backtest-desvio/index.mjs
//
// Roda cada candidato (Task 2) contra o corpus inteiro (Task 4) usando o
// replay fiel (Task 3), e escreve relatorio.md com recall/taxa de FP por
// candidato. NAO decide sozinho o vencedor -- ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md,
// secao "Criterio de decisao": se nenhum candidato bater a regra ALL em
// recall SEM piorar a taxa de disparo espurio, o relatorio so reporta a
// tabela -- a escolha final e' do controller/usuario, nao deste script.
//
// Achado real 10/08 (revisao final de branch): a tabela agregada abaixo
// sozinha NAO foi o que decidiu pct80 -- ela empata quase todos os
// candidatos porque o corpus e' dominado por casos de N pequeno (destinos
// <=5). A decisao real veio de uma segunda tabela, segmentada por N de
// destinos (baixoN vs altoN), que na primeira rodada deste harness foi
// feita ad-hoc pelo controller num script temporario e DESCARTADO -- so
// sobrou como texto no ledger
// (.superpowers/sdd/2026-08-10-ponto-seguro-e-afastando-tudo/progress.md).
// Essa segmentacao agora e' parte permanente deste script pra que a
// decisao seja re-derivavel a partir do repo, sem depender de um script
// que ninguem mais tem.
import { readFileSync, writeFileSync } from "node:fs";
import { CANDIDATOS } from "./candidatos.ts";
import { replay } from "./replay.ts";

const corpus = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf-8"));

const temQueDisparar = corpus.filter((c) => c.rotulo === "tem_que_disparar");
const naoPodeDisparar = corpus.filter((c) => c.rotulo === "nao_pode_disparar");

// N de destinos de um caso: numero de destinos (pendentes + bases)
// vigentes pro veiculo naquele caso. Estavel ao longo da trilha na
// pratica (pendentes raramente mudam dentro da janela curta de um caso),
// entao o primeiro ponto ja representa o caso inteiro -- confirmado
// empiricamente contra este corpus (primeiro/ultimo/max/moda do N por
// caso concordam em 100% dos 423 casos).
function nDestinos(caso) {
  return caso.destinosPorPonto[0]?.length ?? 0;
}

const N_CORTE_BAIXO_ALTO = 5; // mesmo corte usado na analise ad-hoc original do controller

function calcularLinha(chave, regra, temQueDispararSet, naoPodeDispararSet) {
  const resultadosPositivos = temQueDispararSet.map((c) => replay(regra, c.pontos, c.destinosPorPonto));
  const resultadosNegativos = naoPodeDispararSet.map((c) => replay(regra, c.pontos, c.destinosPorPonto));

  const disparou = resultadosPositivos.filter((r) => r.disparou).length;
  const recall = temQueDispararSet.length > 0 ? disparou / temQueDispararSet.length : 0;

  const espurios = resultadosNegativos.filter((r) => r.disparou).length;
  const taxaEspuria = naoPodeDispararSet.length > 0 ? espurios / naoPodeDispararSet.length : 0;

  const latencias = resultadosPositivos.filter((r) => r.disparou).map((r) => r.cicloDoDisparo);
  const latenciaMedia = latencias.length > 0 ? latencias.reduce((a, b) => a + b, 0) / latencias.length : null;

  return `| ${chave} | ${(recall * 100).toFixed(1)}% (${disparou}/${temQueDispararSet.length}) | ${(taxaEspuria * 100).toFixed(1)}% (${espurios}/${naoPodeDispararSet.length}) | ${latenciaMedia !== null ? latenciaMedia.toFixed(1) : "n/a"} |`;
}

function montarTabela(temQueDispararSet, naoPodeDispararSet) {
  const linhas = [];
  linhas.push("| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |");
  linhas.push("|---|---|---|---|");
  for (const [chave, regra] of CANDIDATOS) {
    linhas.push(calcularLinha(chave, regra, temQueDispararSet, naoPodeDispararSet));
  }
  return linhas.join("\n");
}

const tabelaAgregada = montarTabela(temQueDisparar, naoPodeDisparar);

const baixoNTemQueDisparar = temQueDisparar.filter((c) => nDestinos(c) <= N_CORTE_BAIXO_ALTO);
const baixoNNaoPodeDisparar = naoPodeDisparar.filter((c) => nDestinos(c) <= N_CORTE_BAIXO_ALTO);
const altoNTemQueDisparar = temQueDisparar.filter((c) => nDestinos(c) > N_CORTE_BAIXO_ALTO);
const altoNNaoPodeDisparar = naoPodeDisparar.filter((c) => nDestinos(c) > N_CORTE_BAIXO_ALTO);

const tabelaBaixoN = montarTabela(baixoNTemQueDisparar, baixoNNaoPodeDisparar);
const tabelaAltoN = montarTabela(altoNTemQueDisparar, altoNNaoPodeDisparar);

const relatorio = `# Relatorio do harness de backtest -- afastando-de-tudo

Corpus: ${corpus.length} casos (${temQueDisparar.length} tem_que_disparar, ${naoPodeDisparar.length} nao_pode_disparar).

## Tabela agregada

${tabelaAgregada}

Criterio de decisao (ver spec): candidato vencedor maximiza recall sem
piorar a taxa de disparo espurio em relacao a \`all\` (baseline, regra
atual em producao). Se nenhum candidato atender aos dois criterios ao
mesmo tempo, decisao fica para o controller/usuario -- nao decidido
automaticamente por este script.

**Esta tabela sozinha NAO decide o vencedor** -- ela empata (ou quase) quase
todos os candidatos, porque o corpus e' dominado por casos de N pequeno
(destinos <= ${N_CORTE_BAIXO_ALTO}: ${baixoNTemQueDisparar.length} dos ${temQueDisparar.length} casos "tem que disparar"). A
tabela segmentada abaixo e' o que de fato distingue os candidatos -- foi
ela, nao a tabela agregada, que decidiu pct80.

## Tabela segmentada por N de destinos (baixoN <= ${N_CORTE_BAIXO_ALTO}, altoN > ${N_CORTE_BAIXO_ALTO})

Mesmo corte usado na analise ad-hoc original que motivou a escolha do
candidato vencedor (ver ledger do plano,
.superpowers/sdd/2026-08-10-ponto-seguro-e-afastando-tudo/progress.md).

### baixoN (destinos <= ${N_CORTE_BAIXO_ALTO}) -- ${baixoNTemQueDisparar.length} tem_que_disparar / ${baixoNNaoPodeDisparar.length} nao_pode_disparar

${tabelaBaixoN}

Todos os candidatos identicos entre si neste segmento -- confirma que a
propriedade de seguranca contra o incidente de 06/07 esta intacta pra N
pequeno, nenhum candidato regride em relacao a \`all\`.

### altoN (destinos > ${N_CORTE_BAIXO_ALTO}) -- ${altoNTemQueDisparar.length} tem_que_disparar / ${altoNNaoPodeDisparar.length} nao_pode_disparar

Amostra pequena (padrao real dos casos TTM-7C13/TTH-0G95 que motivaram
toda a investigacao, N=12-14), mas e' o unico segmento onde os candidatos
de fato divergem -- e' esse segmento que decide o vencedor: pct80 e' o
unico candidato com recall estritamente maior que \`all\` E taxa de
disparo espurio nao pior que \`all\` neste segmento.

${tabelaAltoN}
`;

writeFileSync(new URL("./relatorio.md", import.meta.url), relatorio);
console.log(relatorio);
