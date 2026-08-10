// scripts/backtest-desvio/index.mjs
//
// Roda cada candidato (Task 2) contra o corpus inteiro (Task 4) usando o
// replay fiel (Task 3), e escreve relatorio.md com recall/taxa de FP por
// candidato. NAO decide sozinho o vencedor -- ver
// docs/superpowers/specs/2026-08-10-afastando-tudo-harness-design.md,
// secao "Criterio de decisao": se nenhum candidato bater a regra ALL em
// recall SEM piorar a taxa de disparo espurio, o relatorio so reporta a
// tabela -- a escolha final e' do controller/usuario, nao deste script.
import { readFileSync, writeFileSync } from "node:fs";
import { CANDIDATOS } from "./candidatos.ts";
import { replay } from "./replay.ts";

const corpus = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf-8"));

const temQueDisparar = corpus.filter((c) => c.rotulo === "tem_que_disparar");
const naoPodeDisparar = corpus.filter((c) => c.rotulo === "nao_pode_disparar");

const linhas = [];
linhas.push("| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |");
linhas.push("|---|---|---|---|");

for (const [chave, regra] of CANDIDATOS) {
  const resultadosPositivos = temQueDisparar.map((c) => replay(regra, c.pontos, c.destinosPorPonto));
  const resultadosNegativos = naoPodeDisparar.map((c) => replay(regra, c.pontos, c.destinosPorPonto));

  const disparou = resultadosPositivos.filter((r) => r.disparou).length;
  const recall = temQueDisparar.length > 0 ? disparou / temQueDisparar.length : 0;

  const espurios = resultadosNegativos.filter((r) => r.disparou).length;
  const taxaEspuria = naoPodeDisparar.length > 0 ? espurios / naoPodeDisparar.length : 0;

  const latencias = resultadosPositivos.filter((r) => r.disparou).map((r) => r.cicloDoDisparo);
  const latenciaMedia = latencias.length > 0 ? latencias.reduce((a, b) => a + b, 0) / latencias.length : null;

  linhas.push(
    `| ${chave} | ${(recall * 100).toFixed(1)}% (${disparou}/${temQueDisparar.length}) | ${(taxaEspuria * 100).toFixed(1)}% (${espurios}/${naoPodeDisparar.length}) | ${latenciaMedia !== null ? latenciaMedia.toFixed(1) : "n/a"} |`
  );
}

const relatorio = `# Relatório do harness de backtest — afastando-de-tudo

Corpus: ${corpus.length} casos (${temQueDisparar.length} tem_que_disparar, ${naoPodeDisparar.length} nao_pode_disparar).

${linhas.join("\n")}

Critério de decisão (ver spec): candidato vencedor maximiza recall sem
piorar a taxa de disparo espúrio em relação a \`all\` (baseline, regra
atual em produção). Se nenhum candidato atender aos dois critérios ao
mesmo tempo, decisão fica para o controller/usuário — não decidido
automaticamente por este script.
`;

writeFileSync(new URL("./relatorio.md", import.meta.url), relatorio);
console.log(relatorio);
