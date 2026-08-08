# Anotação de confiabilidade histórica do detector no card do alerta — Design

**Contexto:** análise da tabela `calibracao_desvio` (dado real, agregado por
segmento, já em produção) mostrou que os 3 detectores de desvio não são
igualmente confiáveis: `afastando_de_tudo` (bucket genérico `tipo:desvio`)
está bem calibrado (~9% de falso positivo, ~2900 amostras), mas
`classe_viaria` ("saiu de via principal... rua estreita") erra **66% das
vezes** (139-168 amostras, sample grande, número confiável). Tentei achar um
sinal nos dados já coletados (placar sombra, D1/D2/D3, risco de área,
streaks, corredor concorrente, veículo familiar) que discriminasse os casos
certos dos errados de `classe_viaria` — nenhum discrimina; as médias são
praticamente idênticas entre os dois grupos. Dois comentários no código
(achados de investigações anteriores, 27/07 e 01/08) já haviam concluído a
mesma coisa por outros caminhos: não existe hoje um sinal seguro pra
suprimir `classe_viaria` automaticamente sem, na prática, desligar o
detector inteiro.

Decisão do usuário: não inventar um sinal novo agora (trabalho maior, não
de uma sessão). Em vez disso, dar ao operador o número real e honesto —
exatamente o que ele teria pedido pra "detector com histórico ruim, sei que
é ruim, mas não sei consertar hoje": mostrar a taxa de falso positivo
histórica direto no card. É informação, não decisão automática — o operador
deprioriza mentalmente sozinho, o sistema não decide por ele.

**Goal:** exibir, no card do alerta, a taxa de falso positivo histórica do
segmento de calibração que gerou aquele alerta — quando existir.

**Arquitetura:** ZERO mudança no motor (`route.ts`). O campo
`contexto.calibracao: { segmento: string | null, taxa_falso_positivo: number }`
já é gravado na criação/escalação de todo alerta de desvio que passa por
`montarContextoDesvio` — isso inclui `afastando_de_tudo` (chamado com
`ehDesvio`) e `classe_viaria`/`saida_parada` (via `contextoClasseViaria`/
`contextoSaidaParada`, mesmo objeto `calibracao` embutido, linhas
3860-3874 de `route.ts`). `taxa_falso_positivo: -1` significa "sem dado de
calibração ainda" (poucas amostras) — ver `p.taxaFp ?? -1` em
`montarContextoDesvio`. Só falta: 1 função pura de formatação em
`detectores.ts` + wiring nos 3 pontos de leitura de alerta do frontend
(mesmo padrão de `progresso_destino`/`placar_sombra`, já em produção).

## Escopo

Qualquer alerta tipo `desvio` cujo `contexto.calibracao.taxa_falso_positivo`
seja `>= 0` (isto é, existe dado real — `-1` é "sem amostra suficiente" e
não deve aparecer, mostrar um número artificial seria mentir). Não é
restrito a `classe_viaria`: `afastando_de_tudo` também tem o campo
(via o bucket `tipo:desvio` ou `corredor_veredito:X`) e também deve exibir
— um número BAIXO de falso positivo é informação real e útil também (o
operador ganha confiança extra num alerta bem calibrado, não é uma
reassurance fabricada, é dado histórico real).

**Fora do escopo, explicitamente:** nenhuma mudança em `nivel`, `status`,
disparo, auto-resolução, ordenação da lista de alertas, ou cor/estilo do
card que sugira severidade diferente da real. O texto nunca usa
"resolvido"/"seguro" — mostra o número e deixa a leitura com o operador,
mesmo quando o número é alto (66%) ou baixo (9%).

## Dados

Campo já existente, nenhuma mudança de escrita:

```typescript
contexto.calibracao: {
  segmento: string | null;       // ex: "origem:classe_viaria", "tipo:desvio"
  taxa_falso_positivo: number;   // 0-1, ou -1 = sem dado
}
```

## Exibição (frontend)

Nova função pura em `detectores.ts`, mesmo padrão de
`formatarProgressoDestino`/`formatarPlacarSombra`:

```typescript
export function formatarConfiabilidadeDetector(taxaFalsoPositivo: number): string | null {
  if (taxaFalsoPositivo < 0) return null;
  const pct = Math.round(taxaFalsoPositivo * 100);
  return `Histórico: ${pct}% de falso positivo neste tipo de alerta`;
}
```

`page.tsx`: extrair `contexto.calibracao` no `enriquecer()`, mesmo padrão de
`progressoDestinoM`/`placarSombra`. `MonitorV2.tsx`: renderizar a linha nova
(chamando `formatarConfiabilidadeDetector(a.calibracao.taxa_falso_positivo)`,
só quando o retorno não for `null`) logo abaixo da linha de
`placar_sombra` existente. `api/alertas/route.ts`: replicar a mesma
extração (mesmo cuidado de sempre — as 3 rotas de leitura precisam do
campo, esquecer uma já causou o bug "+NaNm" numa task anterior).

**Cor**: `T.dim` (mesma cor neutra de `progresso_destino`/`placar_sombra`)
— não varia por valor. Não usa vermelho pra "66%" nem verde pra "9%": o
texto já é claro por si, cor extra seria o sistema opinando por trás de um
disfarce visual, o oposto do objetivo desta feature.

## Testes

`detectores.test.ts`: `formatarConfiabilidadeDetector` — valor `-1` retorna
`null`; valor `0` retorna "0% de falso positivo..."; valor `0.661`
arredonda pra "66%"; valor `1` retorna "100%".

## Replicação e deploy

Mesmo processo de sempre: replicar pro repo espelho `MONITORAMENTO
transmonseg`, deploy manual via PM2 nos dois processos, verificar em
produção real contra um alerta `classe_viaria` ativo (deve mostrar
"Histórico: 66% de falso positivo...") e um `afastando_de_tudo` ativo
(deve mostrar um número bem menor).
