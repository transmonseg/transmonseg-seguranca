# Relatório do harness de backtest — afastando-de-tudo

Corpus: 423 casos (222 tem_que_disparar, 201 nao_pode_disparar).

| Candidato | Recall (tem que disparar) | Taxa de disparo espurio (nao pode disparar) | Latencia media ate disparo (ciclos) |
|---|---|---|---|
| all | 73.9% (164/222) | 47.8% (96/201) | 109.3 |
| top3 | 74.8% (166/222) | 48.3% (97/201) | 110.0 |
| top5 | 74.3% (165/222) | 48.3% (97/201) | 110.6 |
| top8 | 73.9% (164/222) | 47.8% (96/201) | 109.3 |
| pct60 | 75.2% (167/222) | 48.8% (98/201) | 107.8 |
| pct80 | 74.8% (166/222) | 47.8% (96/201) | 109.0 |

Critério de decisão (ver spec): candidato vencedor maximiza recall sem
piorar a taxa de disparo espúrio em relação a `all` (baseline, regra
atual em produção). Se nenhum candidato atender aos dois critérios ao
mesmo tempo, decisão fica para o controller/usuário — não decidido
automaticamente por este script.
