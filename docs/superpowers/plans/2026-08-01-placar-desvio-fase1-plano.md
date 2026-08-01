# Placar de Desvio — Fase 1 (sombra) — Plano de Implementação

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Calcular o placar acumulativo de desvio (0–100) por veículo a cada ciclo do motor, logar em sombra (tabela própria + contexto dos alertas de desvio atuais) sem mudar NADA na operação, e validar contra os 16 casos rotulados de 01/08.

**Architecture:** Lib pura `src/lib/placar-desvio.ts` (fórmula + helpers de sinal, 100% testável) + wiring no ciclo do motor (`src/app/api/motor/route.ts`) reaproveitando sinais já computados + persistência do estado em `posicoes_atuais` (mesmo padrão dos streaks) + log em `placar_desvio_log`. Spec: `docs/superpowers/specs/2026-08-01-placar-desvio-design.md`.

**Tech Stack:** Next.js/TypeScript, Postgres self-hosted (Contabo, migrations via `ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -f -"`), Vitest.

**Global Constraints:**
- Fase 1 é SOMBRA: nenhum alerta novo, nenhuma supressão, nenhuma mudança de UI. Só cálculo + log.
- Pesos/limiares (fonte única, exportados como constantes da lib):
  - S1 afastamento `+8` · S2 rumo divergente `+6` · S3 fora do corredor `+8` · S4 célula desconhecida `+3` · S5 dia estagnado `+2`
  - D1 parada perto de entrega `−15` · D2 padrão de entrega `−6` · D3 destino alinhado+perto+aproximando `−10` · D4 dentro do corredor `−6`
  - Decaimento `0.90`/ciclo, clamp `[0,100]`, `suspensoPorChegada` → placar = 0
  - `PLACAR_AMARELO = 40` (histerese: desliga <25), `PLACAR_VERMELHO = 70` — na Fase 1 só viram booleans de log
- Sinais só somam sob os guards já existentes do ciclo: `pos.fresco`, `!saltoImplausivel`, `!suspensoPorChegada`, `podeAvancarStreaksDesvio`, `alvosDestinosDisponiveis`, `destinos.length > 0`. Descontos (D1–D4) aplicam sempre que computáveis.
- Números de linha citados podem estar defasados — SEMPRE confirmar com grep/Read fresco antes de editar route.ts.
- Commits frequentes; mensagens em pt-BR seguindo o padrão do repo (`feat:`/`fix:`/`docs:`).

---

### Task 1: Migration 024 (estado + log)

**Files:**
- Create: `scripts/migrations/contabo/024_placar_desvio.sql`

**Step 1: Escrever a migration**

```sql
-- Placar de desvio (Fase 1, sombra) -- ver docs/superpowers/specs/2026-08-01-placar-desvio-design.md
ALTER TABLE posicoes_atuais
  ADD COLUMN IF NOT EXISTS placar_desvio numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS placar_desvio_estado jsonb;

CREATE TABLE IF NOT EXISTS placar_desvio_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  placar numeric NOT NULL,
  componentes jsonb NOT NULL,
  teria_amarelo boolean NOT NULL,
  teria_vermelho boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS placar_desvio_log_veiculo_tempo_idx
  ON placar_desvio_log (veiculo_id, criado_em);
CREATE INDEX IF NOT EXISTS placar_desvio_log_criado_em_idx
  ON placar_desvio_log (criado_em);

GRANT SELECT, INSERT ON placar_desvio_log TO app_service;
GRANT USAGE ON SEQUENCE placar_desvio_log_id_seq TO app_service;
```

Antes de fechar o arquivo: conferir numa migration recente (022/023) como os GRANTs pro `app_service` são feitos e copiar o padrão exato (nome do role, sequence grant).

**Step 2: Aplicar no Contabo**

Run: `ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -f -" < scripts/migrations/contabo/024_placar_desvio.sql`
Expected: ALTER TABLE / CREATE TABLE / CREATE INDEX / GRANT sem erro.

**Step 3: Recarregar PostgREST (gotcha conhecido do projeto)**

Run: `ssh transmonseg-vps "systemctl restart postgrest"`
Verificar: `ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -c '\\d placar_desvio_log'"`

**Step 4: Commit**

```bash
git add scripts/migrations/contabo/024_placar_desvio.sql
git commit -m "feat: migration do placar de desvio (estado em posicoes_atuais + tabela de log sombra)"
```

---

### Task 2: Lib pura `placar-desvio.ts` (TDD)

**Files:**
- Create: `src/lib/placar-desvio.ts`
- Test: `src/lib/placar-desvio.test.ts`

**API da lib (exata):**

```ts
export const PLACAR_PESOS = {
  s1AfastandoDeTudo: 8, s2RumoDivergente: 6, s3ForaDoCorredor: 8,
  s4CelulaDesconhecida: 3, s5DiaEstagnado: 2,
  d1ParadaPertoDeEntrega: -15, d2PadraoEntrega: -6,
  d3DestinoAlinhadoAproximando: -10, d4DentroDoCorredor: -6,
} as const;
export const PLACAR_DECAIMENTO = 0.9;
export const PLACAR_AMARELO = 40;
export const PLACAR_AMARELO_DESLIGA = 25;
export const PLACAR_VERMELHO = 70;
export const D1_RAIO_EXTRA_M = 300;
export const D1_PARADA_MIN_SEG = 120;
export const D2_VEL_MEDIA_MAX_KMH = 25;
export const D2_PARADA_MIN_SEG = 60;
export const D2_MIN_PARADAS = 2;
export const D3_DIST_MAX_M = 1500;
export const D3_RUMO_MAX_GRAUS = 100;
export const S5_ESTAGNADO_MIN = 45;

export type SinaisPlacar = {
  s1AfastandoDeTudo: boolean; s2RumoDivergente: boolean;
  s3ForaDoCorredor: boolean | null;  // null = corredor indisponível neste ciclo (nem soma nem desconta)
  s4CelulaDesconhecida: boolean; s5DiaEstagnado: boolean;
  d1ParadaPertoDeEntrega: boolean; d2PadraoEntrega: boolean;
  d3DestinoAlinhadoAproximando: boolean;
};

// Retorna o placar novo + o detalhamento do ciclo (pra log/auditoria).
// suspensoPorChegada === true -> { placar: 0, componentes: { zeradoPorChegada: true } }.
export function atualizarPlacar(
  placarAnterior: number,
  sinais: SinaisPlacar,
  suspensoPorChegada: boolean
): { placar: number; componentes: Record<string, number | boolean> };

// Janela = posições dos últimos 10min (ordem cronológica), mesma shape do
// que o motor já tem em memória: { lat, lng, velocidade, criadoEm (ISO) }.
export type PontoJanela = { lat: number; lng: number; velocidade: number; criadoEm: string };
export type DestinoPlacar = { lat: number; lng: number; raio: number; codigo: string };

export function paradaRecentePertoDeEntrega(janela: PontoJanela[], destinos: DestinoPlacar[]): boolean;
export function padraoEntrega(janela: PontoJanela[]): boolean;
// distAnteriorPorCodigo: mapa codigo->dist_m persistido do ciclo anterior (estado jsonb)
export function destinoAlinhadoAproximando(
  posAtual: { lat: number; lng: number },
  rumoDivergenciaPorDestino: { codigo: string; divergenciaGraus: number; distM: number }[],
  distAnteriorPorCodigo: Record<string, number>
): boolean;
```

Reusar `distanciaM`/haversine já exportado em `unitrac.ts` (grep antes; não duplicar).

**Step 1: Testes primeiro (casos obrigatórios):**

- `atualizarPlacar`: aplica decaimento (100 → 90 sem sinais); clampa em 0 e 100; zera com `suspensoPorChegada`; `s3ForaDoCorredor: null` não altera nada.
- Cenário entrega normal (D1+D2 true, todos S false) por 5 ciclos partindo de 30 → termina 0.
- Cenário desvio real (S1+S2+S3 true, descontos false) partindo de 0 → cruza 40 até o 3º ciclo e 70 até o 5º.
- `paradaRecentePertoDeEntrega`: run de velocidade 0 por 119s NÃO conta; 120s conta; parada a raio+299m conta, raio+301m não; janela vazia → false.
- `padraoEntrega`: média 24 km/h + 2 paradas de 60s → true; média 26 → false; 1 parada só → false.
- `destinoAlinhadoAproximando`: divergência 99° + dist 1400m + dist caindo (anterior 1600) → true; divergência 1° mas dist 2400m → **false** (caso real RQV-6C22 de 01/08); dist subindo → false; código sem dist anterior → false (primeiro ciclo não desconta).

**Step 2:** Rodar `npx vitest run src/lib/placar-desvio.test.ts` → tudo falha (lib não existe).
**Step 3:** Implementar a lib mínima até passar.
**Step 4:** `npx vitest run` (suite inteira) → verde.
**Step 5:** Commit `feat: lib pura do placar de desvio (formula + sinais D1/D2/D3)`.

---

### Task 3: Wiring no ciclo do motor

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Passos (grep fresco antes de cada edição — o arquivo muda toda hora):**

1. **Carregar estado**: onde o ciclo já lê os streaks de `posicoes_atuais` (grep `divergencia_rumo_streak`), incluir `placar_desvio` e `placar_desvio_estado` no select e no tipo do `anterior`.
2. **Janela de 10min**: UMA query batched por ciclo em `posicoes_historico` (`criado_em > now() - interval '10 minutes'`, `veiculo_id = ANY(...)` dos veículos com destinos pendentes), agrupada em memória por veículo. NÃO uma query por veículo.
3. **Montar `SinaisPlacar`** por veículo, reaproveitando o que o ciclo já computou:
   - S1: a MESMA condição booleana que incrementa o streak de afastamento (grep `desvio_streak`/`afastando`) — extrair pra variável se preciso, não recalcular.
   - S2: `divergenciaGrausAtual !== null && divergenciaGrausAtual > 100`.
   - S3/D4: resultado do corredor quando disponível neste ciclo (grep `dentroDoCorredor`); indisponível → `null`.
   - S4: célula atual (grep `celulaDe`) não existente em `corredor_celulas_veiculo` pro veículo — UMA query batched com os pares (veiculo_id, celula) do ciclo.
   - S5: comparar `entregas_feitas` com `placar_desvio_estado.entregasFeitasRef`/`entregasFeitasDesde`; inalterado há ≥45min com ≥2 pendentes e velocidade > 0 → true; mudou → atualizar ref+timestamp.
   - D1/D2: helpers da lib com a janela do passo 2 e os destinos pendentes do ciclo.
   - D3: montar `rumoDivergenciaPorDestino` a partir do loop de `divergenciaRumoMinima` (por destino) + `distDestinosM`; `distAnteriorPorCodigo` vem de `placar_desvio_estado.distPorCodigo` (gravar o atual pro próximo ciclo).
4. **Atualizar e persistir**: `atualizarPlacar(...)`; gravar `placar_desvio` + `placar_desvio_estado` no MESMO update que já persiste os streaks.
5. **Log sombra**: se `placar > 0`, inserir em `placar_desvio_log` (batched, um insert de várias rows por ciclo) com `teria_amarelo`/`teria_vermelho` calculados com histerese (estado `amareloAtivo` no jsonb).
6. **Sombra nos alertas**: onde os alertas de desvio são emitidos (grep `rumo_coerente_sombra` pra achar o padrão), adicionar `contexto.placar_desvio_sombra = { placar, componentes }`.
7. Guards: veículo sem destinos pendentes ou sem posição fresca → placar só decai (aplicar `atualizarPlacar` com todos os sinais false), sem query de janela pra ele.

**Verificação:** `npx tsc --noEmit` + `npx vitest run` (556+ testes) verdes.
**Commit:** `feat: placar de desvio em sombra no ciclo do motor (log + contexto dos alertas)`.

---

### Task 4: Backtest com os 16 casos de 01/08

**Files:**
- Create: script descartável no scratchpad da sessão (NÃO commitar; pasta única, limpar depois)

**Passos:**
1. Buscar os 16 casos em `casos_desvio_revisao` de 01/08 (join `alertas`/`veiculos` — placa, rótulo `status_final`, horário).
2. Pra cada caso: puxar `posicoes_historico` do veículo (janela 60min ao redor do alerta) + destinos pendentes atuais (melhor aproximação disponível — os alvos de hoje via cache/API).
3. Simular o placar ciclo a ciclo com a lib real (importar de `src/lib/placar-desvio.ts` via `npx tsx`), aproximando S3/S4 como `null`/false quando o dado histórico não permitir.
4. Imprimir tabela: placa · rótulo do operador · placar máximo · minuto em que cruzaria 40 · minuto em que cruzaria 70.
5. Critério de sanidade: nenhum caso rotulado real fica abaixo de 40; maioria dos falsos fica abaixo de 40. Se falhar grosseiramente → ajustar pesos na lib (com teste atualizado) e re-rodar. Ajuste fino fica pra sombra.
6. Reportar a tabela no chat. Se pesos mudaram: commit `fix: ajuste de pesos do placar pos-backtest 01/08`.

---

### Task 5: Replicar + deploy + verificação

**Steps:**
1. Replicar TEMP → definitivo: `git format-patch` dos commits novos + `git am` no repo `MONITORAMENTO transmonseg` (padrão da sessão; resolver conflito manual se houver).
2. Push nos DOIS repos (regra do projeto: sempre juntos).
3. Deploy Contabo nos DOIS processos: `ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull && npm ci && npm run build && pm2 restart transmonseg-temp --update-env"` e o equivalente em `/srv/transmonseg/definitivo` (`transmonseg-definitivo`).
4. Verificação em produção (10-15min depois): `select count(*), max(placar) from placar_desvio_log where criado_em > now() - interval '15 minutes'` — tem que estar populando; conferir 2-3 rows de `componentes` a olho (sinais coerentes com veículos em movimento).
5. Registrar no chat: placar rodando em sombra, próxima parada = 3 dias úteis de coleta antes de avaliar critério da Fase 2.
