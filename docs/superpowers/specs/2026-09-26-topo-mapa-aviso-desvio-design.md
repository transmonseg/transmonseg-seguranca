# Topo do mapa: aviso de desvio que aparece, apita e minimiza

**Data:** 2026-09-26
**Tela:** `MonitorV2` (usada pela Central Romaneio e pela Central — a mudança vale nas duas; o foco do produto é a Central Romaneio).
**Mockups aprovados:** `.superpowers/brainstorm/74356-1790424491/content/fluxo-desvio-v4.html`.

## Objetivo

A tela está poluída: em 26/09 de manhã o topo do mapa empilhava 6 chips de desvio + "+64". O operador quer uma tela calma que só chame atenção quando um desvio acontece de verdade, sem roubar o mapa dele.

## O que o usuário pediu (literal)

1. Tirar do topo do mapa a lista de desvios (a faixa de chips).
2. Desvio novo aparece em cima, apita alguns segundos e depois minimiza.
3. Minimizado vira "Ver mais desvios"; clicar abre a lista.
4. Zoom no caminhão **só quando o operador clica**. Nada de escurecer o mapa nem zoom automático.
5. Sem os quadrados "Desvios"/"Avisos" (rejeitados no mockup v3).
6. Lateral esquerda fica como está.

## Comportamento

### Estado normal
- Acima do mapa: só o seletor TODOS / AMBOS / SELECIONADOS / ROMANEIO (inalterado).
- Se há algum alerta aberto dos tipos notificáveis (ver abaixo) dentro do escopo atual do mapa, aparece logo abaixo do seletor uma pílula discreta **"Ver mais desvios (n)"**. Se n = 0, nada aparece.

### Desvio novo chega
- Um alerta notificável novo (mesma detecção de "novo" que já existe: id ativo que não estava no poll anterior, `novosIdsArr`) faz a pílula virar um **aviso destacado**: `● RQU-9D10 em desvio agora` (vermelho, pulsando).
- Vários no mesmo poll viram um aviso só: `● 2 desvios novos: RQU-9D10, TOS-4J82` (até 3 placas + "e mais N").
- O apito existente (`AlertaSonoro`, botão "Ativar apito") continua sendo quem toca — mesma regra de hoje (só se o operador ativou o apito). Nenhum som novo.
- Clicar no aviso enquanto ele está destacado abre a lista (igual clicar na pílula).

### Minimiza
- Após **8 s** o aviso volta a ser a pílula "Ver mais desvios (n)", com n já atualizado.
- Se chegar outro desvio durante os 8 s, o aviso é substituído pelo novo e os 8 s reiniciam.

### Clicou em "Ver mais desvios"
- Abre um painel logo abaixo, sobre o mapa, com os alertas notificáveis abertos no escopo atual, mais novo primeiro: placa, rótulo do tipo ("Desvio em movimento", "Parada suspeita", etc.), há quanto tempo, e "ver no mapa".
- "Ver no mapa" usa o mesmo foco que o chip de hoje usa (`painel.setAlertaAtivoId` + `painel.selecionarVeiculo`) — é a ÚNICA forma de o mapa se mover.
- Painel fecha clicando fora, clicando de novo na pílula, ou com Esc.

### Tipos notificáveis
Os mesmos de hoje para a Nutry (`TIPOS_NOTIFICAM_POR_CLIENTE["4096"]`): `desvio`, `parada_fora_tapete`, `parada_sem_marcacao`, `parada_anomala`. A lista do painel usa esse mesmo conjunto, para que tudo que o aviso anunciou esteja no painel. (Hoje a faixa só mostrava `desvio` + `parada_fora_tapete`.) Pânico continua com o overlay próprio, intocado.

### Escopo (TODOS / SELECIONADOS / ROMANEIO / AMBOS)
- A contagem e a lista respeitam os mesmos filtros que a faixa respeita hoje (selecionados, romaneio, grupos ocultos).
- AMBOS (split): cada painel tem sua própria pílula/lista, como a faixa tem hoje.

## O que sai
- `renderFaixaDesvio` e o estado `mostrarTodosDesvios*` (chips + "+N"). Substituídos pelo componente novo.

## Fora do escopo
- Lateral esquerda, cards, botões Correto/Falso, "Outros avisos".
- Mudanças de detecção (motor) e o gate de romaneio da Central Romaneio — outro sub-projeto.
- Reabertura de episódio (existe só na Central): um alerta reaberto mantém o mesmo id e **não** dispara o aviso. Aceito por ora, já que o foco é a Central Romaneio.

## Implementação (desenho)
- Novo componente `src/app/(app)/central-v2/AvisoDesvioTopo.tsx`: recebe a lista de alertas notificáveis do escopo, os ids novos do último poll, o tema e o callback de foco. Guarda internamente só `modo: "pilula" | "aviso" | "lista"` e o timer de 8 s.
- Lógica pura separada (`aviso-desvio.ts`): montar o texto do aviso a partir dos novos, e decidir o estado. Testada com vitest.
- `MonitorV2.tsx`: troca as 3 chamadas de `renderFaixaDesvio` pelo componente novo; remove `renderFaixaDesvio` e os estados associados.

## Testes
- vitest da lógica pura: texto do aviso (1, 2, 3, 5 novos), timer/reinício, contagem por escopo.
- Verificação visual obrigatória antes de mostrar: print real da tela (conta QA) nos 4 estados, em dark, e AMBOS.
