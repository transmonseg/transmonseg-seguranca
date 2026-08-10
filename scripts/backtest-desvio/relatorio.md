# Relatorio do harness de backtest -- afastando-de-tudo

Corpus: 423 casos (222 tem_que_disparar, 201 nao_pode_disparar).

## Tabela agregada

| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |
|---|---|---|---|
| all | 73.9% (164/222) | 47.8% (96/201) | 109.3 |
| top3 | 74.8% (166/222) | 48.3% (97/201) | 110.0 |
| top5 | 74.3% (165/222) | 48.3% (97/201) | 110.6 |
| top8 | 73.9% (164/222) | 47.8% (96/201) | 109.3 |
| pct60 | 75.2% (167/222) | 48.8% (98/201) | 107.8 |
| pct80 | 74.8% (166/222) | 47.8% (96/201) | 109.0 |

Criterio de decisao (ver spec): candidato vencedor maximiza recall sem
piorar a taxa de disparo espurio em relacao a `all` (baseline, regra
atual em producao). Se nenhum candidato atender aos dois criterios ao
mesmo tempo, decisao fica para o controller/usuario -- nao decidido
automaticamente por este script.

**Esta tabela sozinha NAO decide o vencedor** -- ela empata (ou quase) quase
todos os candidatos, porque o corpus e' dominado por casos de N pequeno
(destinos <= 5: 218 dos 222 casos "tem que disparar"). A
tabela segmentada abaixo e' o que de fato distingue os candidatos -- foi
ela, nao a tabela agregada, que decidiu pct80.

## Tabela segmentada por N de destinos (baixoN <= 5, altoN > 5)

Mesmo corte usado na analise ad-hoc original que motivou a escolha do
candidato vencedor (ver ledger do plano,
.superpowers/sdd/2026-08-10-ponto-seguro-e-afastando-tudo/progress.md).

### baixoN (destinos <= 5) -- 218 tem_que_disparar / 196 nao_pode_disparar

| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |
|---|---|---|---|
| all | 74.8% (163/218) | 48.0% (94/196) | 109.8 |
| top3 | 74.8% (163/218) | 48.0% (94/196) | 109.8 |
| top5 | 74.8% (163/218) | 48.0% (94/196) | 109.8 |
| top8 | 74.8% (163/218) | 48.0% (94/196) | 109.8 |
| pct60 | 74.8% (163/218) | 48.0% (94/196) | 109.8 |
| pct80 | 74.8% (163/218) | 48.0% (94/196) | 109.8 |

Todos os candidatos identicos entre si neste segmento -- confirma que a
propriedade de seguranca contra o incidente de 06/07 esta intacta pra N
pequeno, nenhum candidato regride em relacao a `all`.

### altoN (destinos > 5) -- 4 tem_que_disparar / 5 nao_pode_disparar

Amostra pequena (padrao real dos casos TTM-7C13/TTH-0G95 que motivaram
toda a investigacao, N=12-14), mas e' o unico segmento onde os candidatos
de fato divergem -- e' esse segmento que decide o vencedor: pct80 e' o
unico candidato com recall estritamente maior que `all` E taxa de
disparo espurio nao pior que `all` neste segmento.

| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |
|---|---|---|---|
| all | 25.0% (1/4) | 40.0% (2/5) | 28.0 |
| top3 | 75.0% (3/4) | 60.0% (3/5) | 124.7 |
| top5 | 50.0% (2/4) | 60.0% (3/5) | 183.5 |
| top8 | 25.0% (1/4) | 40.0% (2/5) | 28.0 |
| pct60 | 100.0% (4/4) | 80.0% (4/5) | 26.5 |
| pct80 | 75.0% (3/4) | 40.0% (2/5) | 66.0 |
