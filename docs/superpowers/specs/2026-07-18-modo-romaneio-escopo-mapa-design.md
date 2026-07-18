# Modo "ROMANEIO" no seletor de escopo do mapa, Design

**Data:** 2026-07-18
**Status:** aprovado pelo usuário, indo para plano

## Problema

O romaneio (importação de manifesto de entrega, spec
`docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md`) já alimenta a
detecção ao vivo assim que importado — o motor troca os pontos de entrega da Unitrac
pelos pontos do romaneio pra qualquer placa com romaneio geocodificado hoje. O
usuário perguntou se isso afeta a tela central de produção (afeta, imediatamente) e
pediu uma forma de **ver visualmente**, na própria tela central, quais veículos estão
sendo rastreados via romaneio hoje — sem misturar com a frota toda e sem precisar
confiar só em log/contagem.

## Decisão

Adicionar um 4º modo **"ROMANEIO"** ao `EscopoMapaSwitcher` já existente na tela
`central-v2` (hoje: TODOS / AMBOS / SELECIONADOS). É um modo exclusivo — não combina
com "AMBOS" (visão lado a lado) — que filtra mapa, lista de alertas e faixa de
desvios ativos pra mostrar só os veículos com **pelo menos um ponto de romaneio
geocodificado hoje** (`romaneio_data = dataHojeSP` E `lat`/`lng` não nulos — o mesmo
critério que o motor usa pra efetivamente considerar o romaneio na detecção; linhas
sem geocode são ignoradas pelo motor, então não fazem sentido contar aqui).

Se nenhum veículo tiver romaneio hoje, o botão continua clicável — mapa/lista
simplesmente ficam vazios, sinal visual claro de "nada importado ainda" (sem popup,
sem desabilitar o botão).

## Escopo

1. **Backend (`src/app/api/mapa/route.ts`)**: adiciona um `EXISTS` contra
   `romaneio_pontos` na query principal de veículos, casando por `veiculo_id = v.id`
   (usa o índice já existente `romaneio_pontos_veiculo_data_idx (veiculo_id,
   romaneio_data)` — mais barato que casar por `placa`, que não tem índice
   dedicado), filtrando `romaneio_data = $N` (parâmetro `dataHojeSP` calculado em JS
   com `Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" })`, mesmo
   padrão do motor — não usar `current_date` do Postgres pra evitar drift de fuso
   perto da meia-noite) e `lat is not null and lng is not null`. Resultado vira
   campo `tem_romaneio_hoje: boolean` em cada linha retornada.
2. **Tipo `VeiculoMapa`** (`src/app/(app)/central-v2/MapaLeafletV2.tsx`): ganha o
   campo `tem_romaneio_hoje: boolean`.
3. **`EscopoMapaSwitcher.tsx`**: generaliza de 3 pra 4 segmentos.
   - `export type EscopoMapa = "todos" | "ambos" | "selecionados" | "romaneio"`.
   - Largura alargada proporcionalmente: `LARGURA` 320→~427 (mantém ~107px por
     segmento, mesmo tamanho de fonte/estilo dos 3 segmentos atuais — não
     espreme os rótulos existentes).
   - `TERCO` vira `QUARTO = (LARGURA - PAD*2) / 4`; `POSICAO` ganha a 4ª posição;
     lógica de snap do drag (`onDragEnd`) generaliza de 3 pra 4 zonas.
   - Novo botão "ROMANEIO", mesmo estilo visual dos outros (cor reativa à posição
     do thumb via `useTransform`, badge de contagem igual o que "SELECIONADOS" já
     tem — mostra `totalComRomaneio` quando > 0).
   - Novo prop `totalComRomaneio: number` (contagem de veículos com
     `tem_romaneio_hoje`, calculada em `MonitorV2.tsx` a partir de `veiculosMapa`).
4. **`MonitorV2.tsx`**:
   - `escolherEscopoMapa` (hoje traduz modo→2 booleans `splitView`/`modoSelecionados`)
     passa a ter um 3º estado possível: quando `modo === "romaneio"`, seta um novo
     state `modoRomaneio = true` (e desliga `splitView`/`modoSelecionados`); os
     outros 3 modos desligam `modoRomaneio`.
   - `aplicarFiltrosVeiculos`: quando `modoRomaneio` ativo, filtra
     `veiculosMapa.filter(v => v.tem_romaneio_hoje)` em vez do filtro por
     `veiculosSelecionados`. Mesmo ponto de aplicação que já filtra mapa + lista de
     alertas (`alertasFiltrados`) + faixa de desvios ativos hoje pro modo
     "selecionados" — reaproveita o mesmo caminho, só troca o critério de inclusão.
   - `modo={...}` passado ao switcher ganha o 4º ramo:
     `modoRomaneio ? "romaneio" : (splitView ? "ambos" : (modoSelecionados ?
     "selecionados" : "todos"))`.
   - `modoRomaneio`, assim como `modoSelecionados`/`splitView` hoje, **não
     persiste** em localStorage entre sessões (mesma decisão de segurança de
     06/07 documentada no código-fonte: um filtro ligado escondendo a frota sem o
     operador perceber é um risco ao vivo).

Fora de escopo: qualquer indicação visual extra no mapa (ex.: cor diferente pro
marcador de veículo com romaneio) — o modo "ROMANEIO" só filtra a lista, não muda a
aparência dos marcadores; modo "AMBOS" combinado com "ROMANEIO" (ex.: comparar
romaneio vs frota toda lado a lado) — não pedido, pode ser um refinamento futuro se
o usuário sentir falta.

## Testes

- Query nova de `/api/mapa` validada isoladamente (fora do caminho de produção)
  contra dados reais: confirma que `tem_romaneio_hoje` bate com o que
  `romaneio_pontos` tem pra hoje, e que placas sem geocode NÃO contam.
- Teste manual na tela: sem nenhum romaneio hoje → botão clicável, mapa vazio;
  depois de um upload real → veículo aparece só no modo ROMANEIO, contagem no badge
  bate.
- `tsc`/`eslint`/`vitest`/`build` limpos nos dois repos antes do push (mesma
  disciplina de sempre nesta sessão).
