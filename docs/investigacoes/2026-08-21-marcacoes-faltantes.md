# Investigação: marcações faltantes reportadas em 21/08

**Data da investigação:** 2026-08-22
**Origem:** 8 casos reportados pela operação (Natália) no grupo "DESVIO DE ROTA" em 21/08, incluindo um com 🚨 da Érica (TOS-3C21, 13:09).
**Pergunta:** o ponto de entrega veio da API Unitrac e foi filtrado por nós, ou nunca veio?

## Resumo

Os 8 casos **não têm uma causa única** — o dado separa em pelo menos 3 padrões distintos.
O mais grave, por afetar 4 dos 8 veículos (RQV-7H50, TTI-6E49, RQV-8A12, TTY-1A57), é
**estrutural**: esses veículos ficaram com **zero pendentes durante o dia inteiro** em
`pendentes_snapshot_log`, e isso não é coisa de 21/08 — persiste por 3 a 6 dias seguidos
(um deles, TTY-1A57, mostra o problema *começando* entre 18/08 e 19/08). Não é um ponto
específico sendo filtrado; é a rota inteira desses CVs nunca aparecendo no nosso sistema.
Todos os 4 tiveram um alerta de desvio (ou parada_anômala) real disparado minutos antes do
horário reportado, depois marcado falso_positivo pelo operador — bate exatamente com a queixa.
Um segundo padrão, mais restrito (TTH-6H80, e provavelmente RQV-2F99/TTM-2F99), é a
**exclusão de um único ponto** dentro de uma rota que carregou normalmente (24-33 outros
pontos presentes) — confirmado que o ponto citado não estava na lista no horário exato, com
um alerta de desvio real disparado 5-10 minutos antes, mas **sem log bruto da resposta da
Unitrac daquele ciclo** não dá pra dizer se foi (a) filtrado, (b) nunca veio, ou (c) veio sem
coordenada. Os 2 casos restantes (RQU-0B47, TOS-3C21) não citaram o código do cliente, a
lista de pendentes no horário parecia saudável, e a premissa da queixa não pôde ser
confirmada com o dado disponível.

## Caso a caso

| Placa | Hora | Cliente citado | Estava no snapshot? | Estava na API Unitrac? | Categoria | Causa |
|---|---|---|---|---|---|---|
| RQV-2F99 | 07:43 | 2786 | Placa **não existe** no cadastro (`veiculos`, com ou sem filtro de cliente). Achado: existe `TTM-2F99` (Nutry Max, 3 letras de diferença) com 24-25 pendentes ao redor do horário e "2786" ausente entre eles. | Não verificável (ver limitação do live-check abaixo) | indeterminado | Provável erro de digitação da placa pelo operador (RQV-2F99 → TTM-2F99). TTM-2F99 teve alerta de `desvio` crítico real às 07:33:30 BRT (falso_positivo), 10min antes do reporte. Mas "2786" (4 dígitos) está fora da faixa de `pontocodigo` observada em toda a frota Nutry Max em 21/08 (52588–960536) — não é seguro assumir que é o mesmo campo que checamos; pode ser um código interno da operação (ex.: `pontoidentificador`, não coletado no nosso log histórico). |
| TTH-6H80 | 07:57 | 163611 | **NÃO** — confirmado ausente nos 2 snapshots mais próximos (07:55 e 08:00 BRT), que tinham 33 outros pontos carregados normalmente. | Não verificável (live-check inconclusivo) | indeterminado entre (a)/(b)/(c) | Ponto ausente confirmado num momento em que o resto da rota estava saudável. Alerta `desvio` crítico real disparado às 07:52:31 BRT ("Afastando de todos os clientes pendentes e da base"), marcado falso_positivo depois. `163611` está dentro da faixa normal de `pontocodigo` da frota — plausível que seja um pontocodigo real. Sem log do array bruto retornado pela Unitrac naquele ciclo (só logamos o array já filtrado), não dá pra saber qual dos 3 filtros agiu, ou se o alvo nunca voltou da API. |
| RQU-0B47 | 08:47 | (não citado) | Lista tinha 34-35 pontos no horário — aparentemente saudável. | Não verificável | indeterminado / premissa não confirmada | Zero alertas de qualquer tipo dispararam nos ±20min ao redor do horário — sugere queixa sobre o marcador visual no mapa, não sobre um alarme de desvio. Sem código de cliente citado, impossível checar qual ponto específico estaria faltando numa lista que parecia normal. |
| RQV-7H50 | 09:36 | (não citado) | **ZERO pendentes o dia inteiro** (267 amostras, 03:00→03:00). Confirmado o mesmo padrão em 19, 20 e 21/08 (todos 0/total). | Não verificável | estrutural — indeterminado entre (b) e (d) | Não é exclusão pontual: o veículo nunca teve nenhum alvo no nosso sistema por pelo menos 3 dias. Alerta `desvio` crítico real às 09:21:01 BRT ("Afastando de todos... corroborado por corredor real fora de rota"), 15min antes do reporte, falso_positivo. Hipótese não confirmada (ver Causa raiz): mismatch entre a string de placa do feed de posições e do feed de alvos da Unitrac quebraria o join que atribui pontos ao veículo. |
| TTI-6E49 | 09:52 | (não citado) | **ZERO pendentes o dia inteiro.** Confirmado por 6 dias seguidos (16 a 21/08, todos 0/total). | Não verificável | estrutural — indeterminado entre (b) e (d) | Mesmo padrão do caso acima, mais crônico. Alerta `desvio` crítico real às 09:49:31 BRT, 3min antes do reporte, falso_positivo. |
| RQV-8A12 | 09:59 | (não citado) | **ZERO pendentes o dia inteiro.** Confirmado por 3 dias (19-21/08). | Não verificável | estrutural — indeterminado entre (b) e (d) | Mesmo padrão. Alerta `desvio` crítico real às 09:55:31 BRT, 4min antes do reporte, falso_positivo. |
| TTY-1A57 | 10:10 | (não citado) | **ZERO pendentes** em 19, 20 e 21/08 — mas tinha pendentes normalmente em 16/08 (84% das amostras), caindo em 17/08 (21%) e 18/08 (3%). | Não verificável | estrutural — indeterminado entre (b) e (d), com início identificável | Regressão, não condição desde sempre: algo quebrou para este veículo entre 18 e 19/08. Alerta `parada_anomala` (não `desvio`) às 10:07:30 BRT — "Parada suspeita de 20min fora de rota **sem ponto de entrega**" — 3min antes do reporte, falso_positivo. |
| TOS-3C21 | 13:06 | (não citado) | Lista tinha 18 pontos no horário — 78% das amostras do dia tinham pendentes (saudável). | Não verificável | indeterminado / premissa não confirmada | O alerta mais próximo do horário (e provavelmente o que gerou o 🚨 da Érica) é `parada_anomala`, não `desvio`, às 13:06:31 BRT: "Parada suspeita de 39min fora de rota sem ponto de entrega", status=resolvido. A coordenada desse alerta fica a ~4km do pendente conhecido mais próximo — compatível com uma parada genuinamente sem cliente por perto, não necessariamente um ponto que sumiu do nosso sistema. Sem código de cliente citado, não dá pra confirmar a premissa. |

## Causa raiz

Dois mecanismos técnicos distintos aparecem no dado, mais um problema de dado/cadastro:

**1. Padrão estrutural (4 casos, o mais frequente).** O filtro de pendentes em
`src/app/api/motor/route.ts:1585-1594` roda sobre `pontosVeiculo`, que vem de
`pontosVeiculoBruto = pontosPorPlacaFallback.get(pos.placa)` (`route.ts:1564`).
`pontosPorPlacaFallback` é populado por `agruparPontosPorPlaca` (`src/lib/unitrac.ts:138-174`),
que agrupa os alvos retornados por `buscarAlvos` usando o campo `a.placa` **retornado pela
própria Unitrac**. Do outro lado, `pos.placa` vem de `normalizar()` (`src/lib/unitrac.ts:671-687`),
que usa `p.veicuplaca`, também vindo da Unitrac, mas do endpoint de **posições**
(`buscarPosicoes`), não do de alvos. Os dois `.get()` só funcionam se a Unitrac devolver a
mesma string de placa nos dois endpoints para o mesmo `cv`. Para RQV-7H50, TTI-6E49,
RQV-8A12 e TTY-1A57, `pendentes_snapshot_log` mostra posição sendo recebida normalmente
(o snapshot é gravado a cada ciclo) mas **zero pontos atribuídos**, por dias seguidos — o
sintoma bate com esse join falhando silenciosamente para esses 4 CVs especificamente, mas
**isso é hipótese, não confirmado**: não consegui comparar ao vivo o campo `placa` dos dois
endpoints pra esses `cv`s porque a checagem rodou às 00:32 BRT de sábado (ver limitação
abaixo). A alternativa (a Unitrac genuinamente não tem nenhum alvo pra esses `cv`s há dias)
também não pode ser descartada com o dado disponível.

**2. Padrão de ponto único (TTH-6H80, confirmado; RQV-2F99/TTM-2F99, com ressalva).**
O mesmo filtro (`route.ts:1585-1594`: `!pt.feito && temCoordenadaValida(pt) && !presença`)
exclui pontos individuais por 3 motivos possíveis — `pt.feito` verdadeiro,
`temCoordenadaValida` (`src/lib/detectores.ts:661-663`) falso, ou presença detectada
(`ENTREGA_PRESENCA_ATIVA`, `route.ts:211` + `buscarPresencaEntregaCliente`, `route.ts:1117-1141`).
`pendentes_snapshot_log` só grava o array **já filtrado** (ver
`scripts/migrations/contabo/029_pendentes_snapshot_log.sql` e a gravação em
`route.ts:1600-1617`) — nunca o array bruto nem os pontos excluídos. Por isso dá pra
confirmar QUE o ponto 163611 sumiu (não está entre os 33 outros que carregaram
normalmente), mas não dá pra dizer POR QUAL dos 3 motivos.

**3. Cadastro/comunicação (RQV-2F99).** A placa reportada não existe em `veiculos` — nem
para Nutry Max nem para nenhum outro cliente. Existe `TTM-2F99` em Nutry Max (3 letras de
diferença), com sinal técnico compatível (desvio falso-positivo real 10min antes do
reporte). O código "2786" citado pela operação está fora da faixa de `pontocodigo`
observada na frota inteira em 21/08 (mín. 52588, máx. 960536) — não é o mesmo namespace,
então não é seguro cruzar contra o campo `codigo` do snapshot.

## Proposta de fix

**Nenhuma das opções abaixo foi implementada — só descritas, para decisão.**

1. **Log de auditoria do array bruto (ou dos pontos excluídos, com motivo).** Adicionar ao
   ciclo do motor (perto de `route.ts:1585`) um registro de quais pontos de
   `pontosVeiculoBruto` foram excluídos e por qual dos 3 filtros, além do que já é
   gravado. Puro observability, zero mudança de comportamento — mesmo padrão de
   `pendentes_snapshot_log`. Trade-off: nenhum risco de mascarar desvio real, só custo de
   armazenamento. Sem isso, todo caso do "padrão de ponto único" (item 2 acima) continua
   indeterminado da próxima vez que acontecer.
2. **Investigar o mismatch de placa nos 4 veículos do padrão estrutural.** Antes de
   qualquer fix, confirmar ao vivo (em horário comercial) se `buscarPosicoes` e
   `buscarAlvos` devolvem a mesma string de placa pros CVs 24025 (RQV-7H50), 18520
   (TTI-6E49), 23937 (RQV-8A12) e 18705 (TTY-1A57). Se confirmado, normalizar a comparação
   de placa no join (`route.ts:1564`) resolveria. **Trade-off importante**: esse fix
   ADICIONARIA pontos reais e válidos (entregas pendentes de verdade, já confirmadas pela
   própria Unitrac) à lista de destinos desses 4 veículos — isso é diferente de afrouxar
   `pt.feito`/`temCoordenadaValida`/presença (que SÃO os filtros que decidem o que conta
   como pendente e que arriscam mascarar desvio real se relaxados). Aqui os filtros ficam
   intocados; corrige-se apenas QUAL veículo recebe os pontos que já existem. Risco de
   mascarar desvio real: baixo. Risco de regressão: mexe num join usado pela frota
   inteira, então precisa validar que a normalização não cria colisão entre placas
   diferentes (improvável dado o formato padronizado, mas testável).
3. **Alerta interno proativo de "veículo grupo=DISTRIBUIÇÃO com pendentes=0 por período
   anormal".** Pegaria esse padrão estrutural em horas, não em dias, sem esperar a
   operação reportar no WhatsApp. Trade-off: precisa de baseline por veículo/grupo pra não
   gerar ruído — grupo VIAGEM, por exemplo, tem pendentes=0 o tempo todo e isso é esperado
   (`534` amostras, `0` com pendentes, ver diagnóstico do script).
4. **RQV-2F99: ação operacional, não código.** Confirmar com a operação se o veículo
   correto é TTM-2F99. Separadamente, considerar logar também `pontoidentificador` nos
   snapshots futuros — hoje só `pontocodigo` é gravado, e o código que a operação usa no
   dia a dia ("cliente 2786") claramente não é o mesmo namespace, o que impede cruzar a
   queixa contra o dado técnico.

## O que foi descartado

- **Causa única para os 8 casos** — descartada. Há pelo menos 2 mecanismos técnicos
  distintos (estrutural por veículo vs. exclusão de ponto único) mais um problema de
  cadastro/placa, e 2 casos onde a premissa não pôde nem ser confirmada.
- **RQV-2F99 ser um bug de filtro de pendentes** — descartado. O problema não é sobre um
  ponto de entrega: a placa reportada não existe no cadastro. O veículo real,
  provavelmente TTM-2F99, teve comportamento técnico normal (rota carregada, 24-25
  pendentes).
- **O alerta do 🚨 da Érica (TOS-3C21) ter sido um `desvio` disparado por marcação
  faltante** — não confirmado. O alerta mais próximo do horário é `parada_anomala`, com
  coordenada a ~4km do pendente conhecido mais próximo — compatível com parada
  genuinamente sem cliente por perto.
- **"2786" ser um `pontocodigo` da Unitrac** — descartado. Nenhum `pontocodigo` da frota
  Nutry Max em 21/08 chega perto de 4 dígitos (faixa observada: 52588–960536); o único
  valor abaixo de 10000 encontrado foi `0` (placeholder de ausência).
- **A chamada AO VIVO à API Unitrac (pedida pelo brief) como evidência para diferenciar
  os 8 casos** — descartada. Rodou às 00:32 BRT de um sábado, fora do horário
  operacional: TODOS os 8 veículos testados (inclusive TTH-6H80, TOS-3C21 e RQU-0B47, que
  tinham histórico saudável em 21/08) retornaram zero alvos. Isso não distingue nada —
  é esperado que não haja rota carregada de madrugada de fim de semana. Repetir esse
  passo em horário comercial é pré-requisito pra validar a hipótese de mismatch de placa
  do item 1 da Causa raiz.

## Limitações desta investigação

- `pendentes_snapshot_log` só grava o array já filtrado, nunca o bruto nem os excluídos —
  o maior fator que impede fechar (a)/(b)/(c) com certeza nos casos de ponto único.
- 6 dos 8 casos não vieram com o código do cliente/ponto citado pela operação — só deu
  pra checar presença/ausência específica em 2 (TTH-6H80, e com ressalva RQV-2F99).
- O passo de chamada ao vivo pedido pelo brief não produziu evidência utilizável (ver "O
  que foi descartado").
- A hipótese de mismatch de placa (padrão estrutural) é a explicação mais coerente com o
  código e o sintoma observado, mas não foi verificada diretamente — fica como próximo
  passo recomendado, não como conclusão.
