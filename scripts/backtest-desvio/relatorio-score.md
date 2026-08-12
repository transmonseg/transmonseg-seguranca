# Relatorio -- score com decaimento vs baseline em producao

Corpus: 444 casos (226 tem_que_disparar, 218 nao_pode_disparar).

## Baseline em producao (pct80, streak binario >=2, piso 2500m) -- tabela agregada e segmentada

| Candidato | Recall | Taxa de disparo espurio |
|---|---|---|
| pct80 (agregado) | 75.2% (170/226) | 50.5% (110/218) |
| pct80 (baixoN <=5) | 75.1% (166/221) | 50.7% (106/209) |
| pct80 (altoN >5) | 80.0% (4/5) | 44.4% (4/9) |

## Score com decaimento -- varredura de parametros

### Agregado (todos os 444 casos)

| Parametros | Recall | Taxa de disparo espurio |
|---|---|---|
| decay=0.7 limiar=1.5 prox=[500,2500] | 86.3% (195/226) | 71.1% (155/218) |
| decay=0.7 limiar=2 prox=[500,2500] | 75.2% (170/226) | 44.5% (97/218) |
| decay=0.8 limiar=1.5 prox=[500,2500] | 88.5% (200/226) | 82.1% (179/218) |
| decay=0.8 limiar=2 prox=[500,2500] | 86.3% (195/226) | 64.7% (141/218) |
| decay=0.8 limiar=2.5 prox=[500,2500] | 73.5% (166/226) | 44.0% (96/218) |
| decay=0.85 limiar=2 prox=[500,2500] | 87.6% (198/226) | 72.0% (157/218) |
| decay=0.85 limiar=2.5 prox=[500,2500] | 85.0% (192/226) | 60.1% (131/218) |
| decay=0.9 limiar=2.5 prox=[500,2500] | 86.3% (195/226) | 67.9% (148/218) |
| decay=0.9 limiar=3 prox=[500,2500] | 82.7% (187/226) | 58.7% (128/218) |
| decay=0.8 limiar=2 prox=[300,1500] | 86.3% (195/226) | 65.1% (142/218) |
| decay=0.8 limiar=2 prox=[800,3000] | 85.4% (193/226) | 64.7% (141/218) |

### baixoN (destinos <= 5) -- 221 tem_que_disparar / 209 nao_pode_disparar

| Parametros | Recall | Taxa de disparo espurio |
|---|---|---|
| decay=0.7 limiar=1.5 prox=[500,2500] | 86.4% (191/221) | 72.7% (152/209) |
| decay=0.7 limiar=2 prox=[500,2500] | 75.6% (167/221) | 45.5% (95/209) |
| decay=0.8 limiar=1.5 prox=[500,2500] | 88.7% (196/221) | 84.2% (176/209) |
| decay=0.8 limiar=2 prox=[500,2500] | 86.4% (191/221) | 66.0% (138/209) |
| decay=0.8 limiar=2.5 prox=[500,2500] | 73.8% (163/221) | 44.5% (93/209) |
| decay=0.85 limiar=2 prox=[500,2500] | 87.8% (194/221) | 73.7% (154/209) |
| decay=0.85 limiar=2.5 prox=[500,2500] | 85.5% (189/221) | 61.2% (128/209) |
| decay=0.9 limiar=2.5 prox=[500,2500] | 86.9% (192/221) | 69.4% (145/209) |
| decay=0.9 limiar=3 prox=[500,2500] | 83.3% (184/221) | 59.8% (125/209) |
| decay=0.8 limiar=2 prox=[300,1500] | 86.4% (191/221) | 66.5% (139/209) |
| decay=0.8 limiar=2 prox=[800,3000] | 85.5% (189/221) | 66.0% (138/209) |

### altoN (destinos > 5) -- 5 tem_que_disparar / 9 nao_pode_disparar

| Parametros | Recall | Taxa de disparo espurio |
|---|---|---|
| decay=0.7 limiar=1.5 prox=[500,2500] | 80.0% (4/5) | 33.3% (3/9) |
| decay=0.7 limiar=2 prox=[500,2500] | 60.0% (3/5) | 22.2% (2/9) |
| decay=0.8 limiar=1.5 prox=[500,2500] | 80.0% (4/5) | 33.3% (3/9) |
| decay=0.8 limiar=2 prox=[500,2500] | 80.0% (4/5) | 33.3% (3/9) |
| decay=0.8 limiar=2.5 prox=[500,2500] | 60.0% (3/5) | 33.3% (3/9) |
| decay=0.85 limiar=2 prox=[500,2500] | 80.0% (4/5) | 33.3% (3/9) |
| decay=0.85 limiar=2.5 prox=[500,2500] | 60.0% (3/5) | 33.3% (3/9) |
| decay=0.9 limiar=2.5 prox=[500,2500] | 60.0% (3/5) | 33.3% (3/9) |
| decay=0.9 limiar=3 prox=[500,2500] | 60.0% (3/5) | 33.3% (3/9) |
| decay=0.8 limiar=2 prox=[300,1500] | 80.0% (4/5) | 33.3% (3/9) |
| decay=0.8 limiar=2 prox=[800,3000] | 80.0% (4/5) | 33.3% (3/9) |

## Casos especificos (TOS-2B69, TTM-7C13, TTH-0G95, TTT-1E20 -- se presentes no corpus)

- **TOS-2B69** (rotulo: nao_pode_disparar, N=30): baseline pct80 disparou=true
  - decay=0.7 limiar=1.5 prox=[500,2500]: disparou=false (scoreMaximo=1.27)
  - decay=0.7 limiar=2 prox=[500,2500]: disparou=false (scoreMaximo=1.27)
  - decay=0.8 limiar=1.5 prox=[500,2500]: disparou=false (scoreMaximo=1.40)
  - decay=0.8 limiar=2 prox=[500,2500]: disparou=false (scoreMaximo=1.40)
  - decay=0.8 limiar=2.5 prox=[500,2500]: disparou=false (scoreMaximo=1.40)
  - decay=0.85 limiar=2 prox=[500,2500]: disparou=false (scoreMaximo=1.47)
  - decay=0.85 limiar=2.5 prox=[500,2500]: disparou=false (scoreMaximo=1.47)
  - decay=0.9 limiar=2.5 prox=[500,2500]: disparou=false (scoreMaximo=1.54)
  - decay=0.9 limiar=3 prox=[500,2500]: disparou=false (scoreMaximo=1.54)
  - decay=0.8 limiar=2 prox=[300,1500]: disparou=false (scoreMaximo=1.46)
  - decay=0.8 limiar=2 prox=[800,3000]: disparou=false (scoreMaximo=1.08)
- **TTM-7C13** (rotulo: tem_que_disparar, N=2): baseline pct80 disparou=true
  - decay=0.7 limiar=1.5 prox=[500,2500]: disparou=true (scoreMaximo=2.05)
  - decay=0.7 limiar=2 prox=[500,2500]: disparou=true (scoreMaximo=2.05)
  - decay=0.8 limiar=1.5 prox=[500,2500]: disparou=true (scoreMaximo=2.72)
  - decay=0.8 limiar=2 prox=[500,2500]: disparou=true (scoreMaximo=2.72)
  - decay=0.8 limiar=2.5 prox=[500,2500]: disparou=true (scoreMaximo=2.72)
  - decay=0.85 limiar=2 prox=[500,2500]: disparou=true (scoreMaximo=3.21)
  - decay=0.85 limiar=2.5 prox=[500,2500]: disparou=true (scoreMaximo=3.21)
  - decay=0.9 limiar=2.5 prox=[500,2500]: disparou=true (scoreMaximo=3.86)
  - decay=0.9 limiar=3 prox=[500,2500]: disparou=true (scoreMaximo=3.86)
  - decay=0.8 limiar=2 prox=[300,1500]: disparou=true (scoreMaximo=2.80)
  - decay=0.8 limiar=2 prox=[800,3000]: disparou=true (scoreMaximo=2.67)
- **TTH-0G95** (rotulo: tem_que_disparar, N=2): baseline pct80 disparou=true
  - decay=0.7 limiar=1.5 prox=[500,2500]: disparou=false (scoreMaximo=1.06)
  - decay=0.7 limiar=2 prox=[500,2500]: disparou=false (scoreMaximo=1.06)
  - decay=0.8 limiar=1.5 prox=[500,2500]: disparou=false (scoreMaximo=1.21)
  - decay=0.8 limiar=2 prox=[500,2500]: disparou=false (scoreMaximo=1.21)
  - decay=0.8 limiar=2.5 prox=[500,2500]: disparou=false (scoreMaximo=1.21)
  - decay=0.85 limiar=2 prox=[500,2500]: disparou=false (scoreMaximo=1.34)
  - decay=0.85 limiar=2.5 prox=[500,2500]: disparou=false (scoreMaximo=1.34)
  - decay=0.9 limiar=2.5 prox=[500,2500]: disparou=false (scoreMaximo=1.56)
  - decay=0.9 limiar=3 prox=[500,2500]: disparou=false (scoreMaximo=1.56)
  - decay=0.8 limiar=2 prox=[300,1500]: disparou=false (scoreMaximo=1.86)
  - decay=0.8 limiar=2 prox=[800,3000]: disparou=false (scoreMaximo=0.87)
- TTT-1E20: nao encontrado no corpus atual
