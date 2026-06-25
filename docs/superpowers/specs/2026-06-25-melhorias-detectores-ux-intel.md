# Spec — Melhorias Transmonseg Central: Detectores, UX Operacional e Inteligência

## Contexto

Sistema de monitoramento de frota de carga da Transmonseg. Stack: Next.js 16 App Router + Supabase + PostGIS. Motor de alertas roda a cada ciclo via POST /api/motor, detectores sao funcoes puras em `src/lib/detectores.ts`.

## O que ja existe (nao tocar)

- Poligono da base no mapa: `MapaMonitor.tsx:1518` — GeoJSON azul tracejado, ja renderizado
- `emHorarioOperacao()`: `detectores.ts:79` — ja calculado no motor (linha 225)
- ISP-RJ roubo de carga: overlay por municipio no mapa
- Todos os detectores atuais: panico, bau, jammer, excesso, parada_longa, parada_cliente, parada_anomala, desvio, favela, tiroteio

## Fase 1 — Dois detectores novos no motor

### 1.1 Detector: ignição fora da janela operacional

**Arquivo:** `src/lib/detectores.ts`

Nova funcao exportada `detectarIgnicaoForaJanela`:

```typescript
export function detectarIgnicaoForaJanela(ctx: {
  ignicao: boolean;
  emOperacao: boolean;
  fresco: boolean;
}): Alerta | null {
  if (!ctx.fresco || !ctx.ignicao || ctx.emOperacao) return null;
  return {
    nivel: "critico",
    tipo: "ignicao_noturna",
    motivo: "Motor ligado fora do horario de operacao (possivel movimentacao nao autorizada)",
    score: 85,
  };
}
```

Adicionar na funcao `avaliar()`: chamar `detectarIgnicaoForaJanela` e incluir no array de candidatos.

Registrar no motor (`route.ts`): tipo ja cai no fluxo generico de alertas — sem mudancas no motor alem de adicionar ao `CHIPS_TIPO` do `FiltrosBar.tsx`.

**Chip no FiltrosBar:** `{ label: "Ignicao fora", tipos: ["ignicao_noturna"], cor: "#7c3aed" }`

### 1.2 Detector: saída nao autorizada da base

**Arquivo:** `src/lib/detectores.ts`

Nova funcao `detectarSaidaNaoAutorizada`:

```typescript
export function detectarSaidaNaoAutorizada(ctx: {
  foraDaBase: boolean;
  temPendentes: boolean;
  ignicao: boolean;
  emOperacao: boolean;
  fresco: boolean;
}): Alerta | null {
  if (!ctx.fresco || !ctx.foraDaBase || ctx.temPendentes) return null;
  if (!ctx.ignicao || !ctx.emOperacao) return null;
  return {
    nivel: "critico",
    tipo: "saida_nao_autorizada",
    motivo: "Veiculo saiu da base sem entregas programadas",
    score: 78,
  };
}
```

Chamada no `avaliar()` com `ctx.foraDaBase`, `ctx.temPendentes`, `ctx.ignicao`, `ctx.emOperacao`, `ctx.fresco` (todos ja disponiveis no motor).

**Chip no FiltrosBar:** `{ label: "Saida base", tipos: ["saida_nao_autorizada"], cor: "#0891b2" }`

## Fase 2 — UX operacional (frontend apenas)

### 2.1 Cronometro SLA GR0/GR1/GR2

**Arquivo novo:** `src/app/(app)/components/CronometroSLA.tsx`

Client component (`"use client"`). Recebe `desde: string` (ISO). Calcula minutos decorridos com `useEffect` + `setInterval` a cada 30s.

Protocolo de resposta:
- `< 5 min`: badge cinza "GR0 - Responder"
- `5-14 min`: badge laranja "GR1 - Escalar supervisor"
- `>= 15 min`: badge vermelho pulsante "GR2 - Escalar cliente"

Injetado em `AcoesAlerta.tsx` ao lado do timestamp existente.

**Sem dado novo no banco.** Usa `desde` que ja existe em `alertas`.

### 2.2 Score de risco agregado no card

**Arquivos:** `src/app/(app)/page.tsx` + `src/app/(app)/components/CardVeiculoOperacao.tsx`

A query de alertas em `page.tsx:804` nao inclui `score` e a interface `Alerta` (linha 62) tambem nao tem o campo. Precisa de 2 mudancas:

1. Adicionar `score` ao SELECT: `.select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status, score")`
2. Adicionar `score: number | null` na interface `Alerta` (linha 70)

O `CardVeiculoOperacao.tsx` existe (importado em page.tsx:13). Recebe props do veiculo — o alerta ativo com `score` e passado via prop e o badge e renderizado inline.

Badge por score:
- `>= 80`: vermelho `score/100`
- `50-79`: laranja `score/100`
- `< 50`: amarelo `score/100`

### 2.3 Filtro de turno (ultimas 8h)

**Arquivo:** `src/app/(app)/components/FiltrosBar.tsx`

Novo chip no grupo Visao: "Turno (8h)" → `?turno=1` na URL.

**Arquivo:** `src/app/(app)/page.tsx`

Ler `turno` de searchParams. Se `turno=1`, adicionar `.gte("desde", desde8h)` na query de alertas. Zero novo componente.

## Fase 3 — Inteligência no mapa

### 3.1 Mapa de calor de incidentes

**Arquivo:** `src/app/api/mapa/route.ts`

Adicionar ao retorno: `alertas_geo: { lat, lng }[]` — posicoes dos alertas dos ultimos 30 dias para o cliente.

Query:
```sql
SELECT lat, lng FROM alertas
WHERE cliente_id = $1
  AND lat IS NOT NULL
  AND lng IS NOT NULL
  AND desde >= now() - interval '30 days'
LIMIT 2000
```

**Arquivo:** `src/app/(app)/components/MapaMonitor.tsx`

Instalar `leaflet.heat` (já disponível como CDN via `<Script>` ou npm `leaflet.heat`). Adicionar `LayersControl.Overlay "Calor (30d)"` que renderiza os pontos como heatmap.

Alternativa sem nova lib: `CircleMarker` com `fillOpacity: 0.15` e `radius: 20` acumulados nos mesmos pontos visualmente similar a um heatmap.

### 3.2 Score H3 por bairro (ISP-RJ)

**Tabela nova:** `risco_h3 (h3_index TEXT PK, score INT, fonte TEXT, updated_at TIMESTAMPTZ)`

**Script ETL:** `scripts/etl-isp-rj-h3.ts`
- Baixa CSV do ISP-RJ (AISP)
- Converte municipio/AISP para lat/lng via BrasilAPI ou Nominatim
- Mapeia para H3 resolucao 8 via `h3-js`
- Upsert em `risco_h3`

**API:** `/api/risco-h3` — retorna GeoJSON de hexagonos com `score`

**Mapa:** Novo overlay `LayersControl.Overlay "Risco regional"` com cores por score.

**Execucao:** Manual primeiro (rodar script localmente), depois cron mensal.

## Arquivos modificados por fase

### Fase 1
| Arquivo | Acao |
|---|---|
| `src/lib/detectores.ts` | Adicionar 2 funcoes + chamar em `avaliar()` |
| `src/lib/detectores.test.ts` | Adicionar testes unitarios para os 2 detectores |
| `src/app/(app)/components/FiltrosBar.tsx` | Adicionar 2 chips em `CHIPS_TIPO` |

### Fase 2
| Arquivo | Acao |
|---|---|
| `src/app/(app)/components/CronometroSLA.tsx` | CRIAR |
| `src/app/(app)/components/AcoesAlerta.tsx` | Injetar `CronometroSLA` |
| `src/app/(app)/components/CardVeiculoOperacao.tsx` | Adicionar badge de score |
| `src/app/(app)/components/FiltrosBar.tsx` | Chip "Turno (8h)" |
| `src/app/(app)/page.tsx` | Ler `?turno=1` e filtrar query |

### Fase 3
| Arquivo | Acao |
|---|---|
| `src/app/api/mapa/route.ts` | Adicionar `alertas_geo` ao retorno |
| `src/app/(app)/components/MapaMonitor.tsx` | Overlay calor + overlay H3 |
| `scripts/etl-isp-rj-h3.ts` | CRIAR script ETL |
| `src/app/api/risco-h3/route.ts` | CRIAR API |

## Restrições

- Free tier only: `leaflet.heat` (MIT), `h3-js` (Apache 2.0), Nominatim (gratuito), BrasilAPI (gratuito)
- Repo publico: nenhum secret no codigo
- Sem travessao (—) em display text
- Portugues com acentos em tudo exceto identificadores de codigo/banco

## Criterios de conclusao

- Fase 1: `npx tsc --noEmit` passa; testes do detectores.ts passam; motor roda sem erro; chips aparecem no FiltrosBar
- Fase 2: CronometroSLA muda de cor ao simular `desde` com 6/16 min atras; filtro turno reduz alertas visiveis; score aparece nos cards
- Fase 3: Overlay de calor aparece no mapa com dados; ETL script roda sem erro localmente
