# Parada fora do tapete (gatilho rápido) + fix do lat/lng na escalação

Contexto: caso real do cliente 27/07 (TTK-4D14, ~12:09 Brasília) — ver
[[project_monitoramento_transmonseg]] memória, entrada de 27/07. Vou registrar
aqui só o essencial pra implementação; a investigação completa (trajetória
minuto a minuto, evidência) já está na memória e não precisa ser repetida.

## Bug 1: "desviou e parou" é invisível

`devAvancarStreaksDesvio` (detectores.ts:687) exige `velocidade > 0` pra
avançar QUALQUER streak de desvio (afastando de tudo, fora do tapete Camada 3,
divergência de rumo). Isso é correto e intencional (anti-jitter de GPS parado,
achado 10/07) — não mexer nisso.

Consequência: um veículo que sai da rota e PARA antes de acumular streak >= 2
nunca dispara nada, porque toda a família de regras de desvio é baseada em
streak que só avança em movimento. `candidatoParadaAnomala` (parada suspeita)
cobre paradas de 12-90min fora da base/cliente, mas não olha se a parada é
especificamente fora do tapete — só cobre paradas LONGAS em geral. Uma parada
de 3-10min já fora do tapete/rua estranha fica no buraco: curta demais pra
parada suspeita, parada demais pra qualquer streak de movimento.

### Fix: novo gatilho rápido, baseado em tempo parado + `dentroTapete`

Reusar sinais já computados no motor (route.ts, mesmo bloco onde
`candidatoParadaAnomala` já existe, ~linha 1529):

```ts
const PARADA_FORA_TAPETE_MIN = 3;
const candidatoParadaForaTapete =
  pos.fresco &&
  pos.velocidade === 0 &&
  paradoMin >= PARADA_FORA_TAPETE_MIN &&
  dentroTapete === false && // já exige TAPETE_MIN_CELULAS de cobertura (route.ts ~1345)
  foraDaBase && !noCliente && emOperacao;
```

Reusar as MESMAS supressões anti-FP já usadas por `candidatoParadaAnomala`:
`temPOI` (posto de gasolina/apoio) e `vizinhosParados`/`vizinhosLentos`
(congestionamento). Nível: `atencao` por padrão, `critico` se
`riscoAreaAtual` alto (mesmo espírito das outras regras de desvio). Tipo:
`"desvio"`, `origemDesvio: "parada_fora_tapete"` (novo valor no union —
seguir o mesmo padrão de `classe_viaria`/`saida_parada`, incluindo
`calibracao-desvio.ts` e o guard de bônus se aplicável). Motivo sugerido:
`"Parado há Nmin fora de qualquer via conhecida da frota, sem ponto de entrega por perto"`.

Piso de 3min é deliberadamente baixo comparado ao piso de 12min da parada
genérica — a condição extra (`dentroTapete === false`, uma corroboração
espacial forte) já reduz risco de falso positivo o bastante pra justificar
confirmar mais rápido. Ajustável com dado real depois (mesmo espírito de todo
limiar deste projeto).

Testes: cobrir em `desvio-cenarios.test.ts` (ou novo arquivo) — cenário
"para poucos minutos fora do tapete, deve disparar" e "para dentro do
tapete, nunca dispara" e "para fora do tapete mas com POI perto, suprime".

## Bug 2: lat/lng da escalação fica dessincronizado do `desde`

`route.ts` ~2299, branch de escalação (`alertaExistente.nivel !== "critico"
&& alerta.nivel === "critico"`): atualiza `lat`/`lng`/`contexto` pro NOVO
`desvioInicio` (novo episódio de streak), mas nunca toca `desde` — que fica
preso no valor da criação original do alerta. Confirmado ao vivo: alerta
`896435f9` tem `desde` de 12:09:30 (Brasília) mas `lat`/`lng` batendo com uma
posição real de 3 HORAS depois.

### Fix: sincronizar `desde` com `desvioInicio.ts` no mesmo UPDATE de escalação

Na mesma branch, quando `ehDesvio` (ou seja, quando lat/lng/contexto já
seriam atualizados pro novo `desvioInicio`), atualizar `desde:
desvioInicio!.ts` junto. Efeito colateral aceito: a idade exibida do alerta
("2h1m" etc, calculada a partir de `desde`) pode "encolher" visivelmente se
escalar bem depois de criado — isso é correto (reflete o início real do
episódio atual), não um bug novo. Sem esse fix, lat/lng e `desde` continuam
contando históricos diferentes do mesmo alerta, o que é estritamente pior
(o operador nem percebe a inconsistência, só vê dado errado).

Não mexer no comportamento de "preserva id" da escalação em si (existe pra
evitar spam de alerta duplicado, achado 22/07) — só o timestamp interno.
