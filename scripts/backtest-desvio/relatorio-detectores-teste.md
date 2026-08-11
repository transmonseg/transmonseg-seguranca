# Validacao final -- src/lib/detectores-teste.ts vs baseline pct80

Corpus: 444 casos (226 tem_que_disparar, 218 nao_pode_disparar).

| | Recall | Taxa de disparo espurio |
|---|---|---|
| Baseline (pct80, producao) | 75.2% (170/226) | 50.5% (110/218) |
| detectores-teste.ts (PARAMS_DESVIO_TESTE_PADRAO) | 76.1% (172/226) | 47.2% (103/218) |

Criterio de aceite (spec, secao 2): recall >= baseline E taxa de disparo
espurio <= baseline, ao mesmo tempo.

**Resultado: BATEU o criterio de aceite.**
