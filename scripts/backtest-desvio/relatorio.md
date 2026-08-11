# Relatorio do harness de backtest -- afastando-de-tudo

Corpus: 444 casos (226 tem_que_disparar, 218 nao_pode_disparar).

## Tabela agregada

| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |
|---|---|---|---|
| all | 73.5% (166/226) | 49.5% (108/218) | 109.6 |
| top3 | 75.2% (170/226) | 50.5% (110/218) | 107.3 |
| top5 | 74.8% (169/226) | 50.0% (109/218) | 107.9 |
| top8 | 74.8% (169/226) | 49.5% (108/218) | 107.9 |
| pct60 | 75.7% (171/226) | 51.4% (112/218) | 108.5 |
| pct80 | 75.2% (170/226) | 50.5% (110/218) | 109.2 |
| pct80_piso100 | 74.8% (169/226) | 49.5% (108/218) | 109.7 |
| pct80_piso150 | 74.3% (168/226) | 49.5% (108/218) | 108.4 |
| pct80_piso200 | 74.3% (168/226) | 49.5% (108/218) | 108.4 |

Criterio de decisao (ver spec): candidato vencedor maximiza recall sem
piorar a taxa de disparo espurio em relacao a `all` (baseline, regra
atual em producao). Se nenhum candidato atender aos dois criterios ao
mesmo tempo, decisao fica para o controller/usuario -- nao decidido
automaticamente por este script.

**Esta tabela sozinha NAO decide o vencedor** -- ela empata (ou quase) quase
todos os candidatos, porque o corpus e' dominado por casos de N pequeno
(destinos <= 5: 221 dos 226 casos "tem que disparar"). A
tabela segmentada abaixo e' o que de fato distingue os candidatos -- foi
ela, nao a tabela agregada, que decidiu pct80.

## Tabela segmentada por N de destinos (baixoN <= 5, altoN > 5)

Mesmo corte usado na analise ad-hoc original que motivou a escolha do
candidato vencedor (ver ledger do plano,
.superpowers/sdd/2026-08-10-ponto-seguro-e-afastando-tudo/progress.md).

### baixoN (destinos <= 5) -- 221 tem_que_disparar / 209 nao_pode_disparar

| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |
|---|---|---|---|
| all | 74.7% (165/221) | 50.7% (106/209) | 110.1 |
| top3 | 74.7% (165/221) | 50.7% (106/209) | 110.1 |
| top5 | 74.7% (165/221) | 50.7% (106/209) | 110.1 |
| top8 | 74.7% (165/221) | 50.7% (106/209) | 110.1 |
| pct60 | 75.1% (166/221) | 50.7% (106/209) | 111.4 |
| pct80 | 75.1% (166/221) | 50.7% (106/209) | 111.5 |
| pct80_piso100 | 75.1% (166/221) | 50.7% (106/209) | 111.5 |
| pct80_piso150 | 74.7% (165/221) | 50.7% (106/209) | 110.1 |
| pct80_piso200 | 74.7% (165/221) | 50.7% (106/209) | 110.1 |

Todos os candidatos identicos entre si neste segmento -- confirma que a
propriedade de seguranca contra o incidente de 06/07 esta intacta pra N
pequeno, nenhum candidato regride em relacao a `all`.

### altoN (destinos > 5) -- 5 tem_que_disparar / 9 nao_pode_disparar

Amostra pequena (padrao real dos casos TTM-7C13/TTH-0G95 que motivaram
toda a investigacao, N=12-14), mas e' o unico segmento onde os candidatos
de fato divergem -- e' esse segmento que decide o vencedor: pct80 e' o
unico candidato com recall estritamente maior que `all` E taxa de
disparo espurio nao pior que `all` neste segmento.

| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |
|---|---|---|---|
| all | 20.0% (1/5) | 22.2% (2/9) | 28.0 |
| top3 | 100.0% (5/5) | 44.4% (4/9) | 13.8 |
| top5 | 80.0% (4/5) | 33.3% (3/9) | 15.5 |
| top8 | 80.0% (4/5) | 22.2% (2/9) | 15.5 |
| pct60 | 100.0% (5/5) | 66.7% (6/9) | 13.0 |
| pct80 | 80.0% (4/5) | 44.4% (4/9) | 15.0 |
| pct80_piso100 | 60.0% (3/5) | 22.2% (2/9) | 10.7 |
| pct80_piso150 | 60.0% (3/5) | 22.2% (2/9) | 11.3 |
| pct80_piso200 | 60.0% (3/5) | 22.2% (2/9) | 12.7 |
