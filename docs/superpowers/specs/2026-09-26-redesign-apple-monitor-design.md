# Redesign estilo Apple do monitor (Central Romaneio / Central)

**Data:** 2026-09-26
**Tela:** `MonitorV2` (usada pela Central Romaneio e pela Central) + header global `src/app/(app)/layout.tsx`.
**Pedido do usuário:** "faça uma análise de tudo como pode melhorar o designer, deixar estilo da Apple" → análise aprovada com "monte plano com superpoderes e pode ir".
**Prints do antes:** `~/ClaudeGerado/monitoramento/analise-apple-1-romaneio.png`, `analise-apple-2-focar.png`, `depois-5-seletor.png`.

## Objetivo

Tela calma, legível e hierárquica no espírito do Apple Maps / macOS: conteúdo (mapa + alertas) em primeiro plano, controles raros escondidos, uma cor de destaque, vermelho só para o que é urgente, painéis flutuantes translúcidos, tipografia com poucos tamanhos. Nenhuma mudança de detecção, de dado ou de fluxo de trabalho do operador (Correto/Falso, Resolver todos, Limpar avisos continuam existindo e fazendo a mesma coisa).

## Medições do antes (26/09, tela ao vivo)

- 131 botões visíveis ao mesmo tempo.
- 10 tamanhos de fonte; 204 textos com ≤10px (41 com 9px).
- 7 raios de borda diferentes em botões (0, 2, 5, 6, 7, 8, 999).
- Paleta em 3 cópias divergentes: `globals.css`, `central-v2/tokens.ts`, objeto `T` em `MonitorV2.tsx` (light `bg` diferente).
- Sirene e Bloquear motor disparam sem confirmação.

## Decisões

### 1. Base visual (fonte única)
- Novo módulo `src/app/(app)/central-v2/design.ts` é a ÚNICA fonte de paleta, tipografia, raio, material e mola. `T` do MonitorV2 e `tokens.ts` do Leaflet derivam dele; `globals.css` é atualizado com os mesmos valores (teste garante sincronismo).
- Paleta no espírito das cores de sistema da Apple:
  - Escuro: fundo `#000000`, superfície `#1c1c1e`, superfície 2 `#2c2c2e`, separador `#38383a`, texto `#f5f5f7`, secundário `#98989d`, terciário `#636366`, destaque `#0a84ff`, vermelho `#ff453a`, laranja `#ff9f0a`, verde `#30d158`.
  - Claro: fundo `#f2f2f7`, superfície `#ffffff`, superfície 2 `#f2f2f7`, separador `#d1d1d6`, texto `#1d1d1f`, secundário `#6e6e73`, terciário `#aeaeb2`, destaque `#0066cc` (azul da Apple acessível; `#007aff` dá só 4,0:1 no branco), vermelho `#d70015`, laranja `#c93400`, verde `#248a3d`.
  - "yellow" (atenção) passa a ser o laranja. Veículo parado com motor ligado (`parado`) continua azul `#2563eb` no mapa (legenda existente).
- Tipografia: 5 tamanhos — `title 20/700`, `headline 15/600`, `body 13/400`, `footnote 12/500`, `caption 12/600 uppercase letterSpacing .04em` (rótulos). **Mínimo 12px em toda a tela.** Mono (Geist Mono) só para placa e números (com `font-variant-numeric: tabular-nums`).
- Raios: `control 8`, `panel 14`, `capsule 999`. Nada mais.
- Material translúcido para tudo que flutua sobre o mapa: fundo com alfa + `backdrop-filter: blur(20px) saturate(180%)`, borda hairline, sombra suave.
- Controles segmentados (TODOS/AMBOS/…, TUDO/DESVIOS) usam thumb neutro elevado (escuro `#636366`, claro `#ffffff` com sombra) e texto primário, como o segmented control da Apple — não thumb azul.
- Mola padrão para framer-motion: `{ type: "spring", stiffness: 380, damping: 32 }`.

### 2. Header global
- Sai: tagline "Inteligência de risco em tempo real", badge "CENTRAL", texto "sistema operacional", separadores.
- Fica: logo + "Transmonseg", abas Central / Central Romaneio, engrenagem, status do romaneio, relógio (peso normal, sem negrito mono gigante), ponto verde "Ao vivo", avatar/nome, Sair.
- Altura menor (≈52px).

### 3. Toolbar do monitor
- Fica visível: clientes (NUTRY/BENASSI), busca de placa no centro (estilo Spotlight, cápsula), botão **"Mapa ▾"**, engrenagem, apito.
- Dentro do popover "Mapa": zoom RUA/QUADRA/BAIRRO/CIDADE, "Enquadrar frota" (antigo VEÍCULOS), Satélite, Trânsito (toggles).
- COMM 10/30/60min sai da toolbar e vai para o bloco FILTROS da lateral (mesma lógica `filtroComm`).
- Popover com material translúcido, fecha com Esc / clique fora.

### 4. Lateral e cards
- Contadores (CRÍTICO / VEÍC.) em estilo "stat" limpo: número grande `title`, rótulo `caption`; sem fundo vermelho no bloco (só o número vermelho quando >0).
- TUDO/DESVIOS vira controle segmentado (cápsula) com thumb.
- Card de alerta:
  - Fundo `surface`, raio `panel`, sem borda vermelha em volta; status por **bolinha** de cor + faixa fina de 3px à esquerda (vermelho crítico / laranja atenção).
  - Tipo como texto colorido `footnote` (sem caixa com fundo).
  - Motivo em cor secundária (texto não muda — o "próximo cliente" precisa de dado novo do motor, fora deste escopo).
  - **Clicar no card foca o veículo** (o botão "Focar" sai). Botões Correto/Falso aparecem **só no card ativo e no hover** do card; com o mesmo `handleResolver`/`MenuMotivoFalso` de hoje.
  - Idade à direita em `footnote` mono, mantendo a cor por idade (`corIdadeAlerta`).
- Botões Resolver todos / Limpar avisos mantêm o fluxo de confirmação; ganham estilo de botão secundário (cápsula).

### 5. Sobre o mapa
- Seletor TODOS/AMBOS/SELECIONADOS/ROMANEIO, "Ver mais desvios", badge de veículos e Legenda com material translúcido e raios do sistema.
- Painel do veículo deixa de ser faixa de largura total e vira **cartão flutuante** (canto inferior esquerdo do mapa, margem 12px, largura `min(760px, 100% - 24px)`), material translúcido, com placa em destaque, métricas em grade, ações (Rastro, Paradas, Seguir, Centralizar, Maps, Atualizar) como botões cápsula.
- **Sirene** e **Bloquear/Desbloquear motor** ficam separados à direita e passam a pedir confirmação em linha (1º clique → "Confirmar sirene?" / "Confirmar bloqueio?" com Confirmar e Cancelar; volta sozinho ao normal após 5 s sem resposta).
- Split (AMBOS) continua com dois cartões independentes.

## Fora do escopo (próximo plano)
- "Próximo cliente X a 3,2 km, se afastando há 6 min" no card (precisa o motor gravar destino/nome/distância no `contexto`).
- Mapa: agrupar pontos de entrega, desenhar rota planejada + trajeto real ao clicar num desvio.
- Tela "Falta o romaneio de hoje" sem bloquear o mapa.
- Outras páginas (Análise, Escala, Configurar Romaneio) — herdam só a paleta nova via `globals.css`.

## Testes
- vitest da lógica pura: `design.ts` (tamanho mínimo 12, contraste WCAG ≥ 4.5 texto/fundo e ≥ 3 secundário/fundo nos dois temas, `globals.css` sincronizado com `design.ts`, `tokens.ts` derivado), máquina de confirmação da Sirene/Bloqueio.
- Verificação visual obrigatória: prints reais (conta QA) nos dois temas, com card ativo, popover Mapa aberto, cartão do veículo aberto e AMBOS.
