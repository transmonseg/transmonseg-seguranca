# Reduzir ruído da tela + melhorar sinal do desvio, Design

**Data:** 2026-08-20
**Status:** aprovado pelo usuário (decisões tomadas em conversa — 2 perguntas de fork respondidas + análise fria com dado real de 14 dias), pronto pra virar plano.

## Contexto

Análise fria de 14 dias de alertas reais (Nutry Max, `cliente_id=cfcb52f5-fd01-47c7-988c-d13a10f0d8fd`) mostrou 3 problemas concretos, com dado por trás de cada um:

1. **Ruído dominando a tela do operador.** Em 14 dias: ~12.250 alertas no total, dos quais `favela` (3.610) e `baseline_veiculo` (2.881) sozinhos são **67%** — com taxa de "correto" manual de 97-99%, ou seja, não são falsos positivos, são sinais de baixo valor acionável que competem por atenção com `desvio` (só 10% do volume). Padrão clássico de rubber-stamp: operador clica "correto" sem examinar de verdade porque aparece o tempo todo.
2. **Sinal real sendo descartado sem tratamento.** O tipo `parada_sem_marcacao` (implementado 28/07 — "carro parou perto de um destino conhecido sem confirmar entrega") já cobre exatamente o cenário que a operadora Érica descreveu em áudio no grupo (20/08): "carro parado sem marcação deveria contar como suspeita de desvio". Mas hoje ele não tem rótulo amigável nem prioridade de exibição no código ativo (`MonitorV2.tsx`) — aparece com slug cru (`parada_sem_marcacao`) e cai pro fim da lista (prioridade default `0`). 68 de 77 ocorrências recentes foram fechadas no botão "Limpar" em massa, não avaliadas uma a uma.
3. **Cadastro de frota fica desatualizado silenciosamente.** Causa raiz confirmada e corrigida manualmente hoje (20/08): quando a Unitrac reemplaca um caminhão (mesmo `cv`/rastreador, placa nova — reemplacamento pro padrão Mercosul), o script de seed (`scripts/seed/02_veiculos.mjs`) nunca atualiza a placa local (`ON CONFLICT DO NOTHING`), porque só roda manualmente. Isso quebrou silenciosamente o casamento placa→veículo do romaneio de hoje (Escala do Pão) até alguém notar no grupo do WhatsApp.

## Decisão

Três mudanças independentes, cada uma resolvendo um problema isolado. (1) e (3) são puramente exibição/automação, sem tocar lógica de disparo/detecção. (2) muda um valor real usado pela arbitragem do motor (ver nota na seção 2 abaixo, achado da revisão final de 20/08) — não é só cosmético como o texto original desta seção afirmava.

### 1. "Outros avisos" — seção colapsada por padrão pra favela/baseline_veiculo

Único arquivo ativo pra essa tela: `src/app/(app)/central-v2/MonitorV2.tsx` (confirmado por exploração de código: `PainelCentral.tsx` e `FiltrosBar.tsx` não são importados em lugar nenhum — código morto, não tocar).

- Nova constante `TIPOS_OUTROS_AVISOS = new Set(["favela", "baseline_veiculo"])` (ao lado de `TIPO_PRIORITY`, linha ~76).
- Novo helper puro `separarOutrosAvisos(lista)` que devolve `{ principais, outros }` filtrando por essa constante.
- Aplicado nos dois pontos que hoje renderizam a lista "TODOS": `alertasOrdenados` (linha 1110, view normal) e `alertasOrdenadosSplitTodos` (linha 1127, coluna TODOS do split view). A coluna SELECIONADOS do split view **não** entra no escopo — é uma seleção deliberada do operador, tratamento diferente de "ruído ambiente".
- UI: nova seção colapsável, mesmo padrão visual do bloco "FILTROS" já existente (linha 2270-2290, cabeçalho com label + contador + seta ▾/▸), posicionada **depois** da lista principal de alertas (fora do fluxo de atenção primário). Título: `OUTROS AVISOS (N)`. Estado `outrosAbertos` (boolean, default `false`, **não** persistido em localStorage — sempre começa fechado a cada carregamento, decisão deliberada pra nunca ficar "aberto por engano" e voltar a competir por atenção). Quando aberto, renderiza os cards de `outros` com o mesmo `renderCardAlerta` já usado pra lista principal — nenhum componente de card novo.
- Nada muda no backend (`/api/alertas`, `route.ts` do motor, detectores) — puramente visual/client-side, reversível trocando 1 linha se não funcionar bem na prática.

### 2. Badge "Possível desvio" + nível crítico pra parada_sem_marcacao

- `src/lib/detectores.ts:872` — `detectarParadaSemMarcacao`: `nivel: "atencao"` → `nivel: "critico"`. Motivo do texto do alerta não muda.
- `MonitorV2.tsx`:
  - `NOME_TIPO` (linha 59-65): adiciona `parada_sem_marcacao: "Parada sem marcação"`.
  - `TIPO_PRIORITY` (linha 72-76): adiciona `parada_sem_marcacao: 14` (logo abaixo de `desvio`/`parada_fora_tapete`=15 — sinaliza "quase tão urgente quanto desvio", sem *ser* desvio pra não reabrir o bug de colisão de vaga já documentado no código pra `parada_fora_tapete`).
  - `renderCardAlerta` (linha ~1381-1386): logo depois do chip `{nomeT(a.tipo)}`, badge condicional extra quando `a.tipo === "parada_sem_marcacao"`:
    ```tsx
    {a.tipo === "parada_sem_marcacao" && (
      <span style={{
        fontSize: 8, fontWeight: 800, padding: "1px 5px", borderRadius: 4,
        background: `${T.red}22`, color: T.red, letterSpacing: ".03em",
      }}>
        POSSÍVEL DESVIO
      </span>
    )}
    ```
- Tipo continua próprio no banco (não vira `tipo="desvio"`) — mantém o auto-resolve/dedup/`TIPOS_NAO_GERENCIADOS` como já está.
- **Achado da revisão final de branch (20/08), correção deste texto**: subir `parada_sem_marcacao` pra `nivel: "critico"` NÃO é puramente cosmético. `arbitrarCandidatos` (`detectores.ts`) sempre faz crítico vencer atenção independente do score — então, em qualquer ciclo do motor onde `parada_sem_marcacao` e um candidato `atencao` (`favela`, `baseline_veiculo`, `parada_longa`, etc.) valem pro mesmo veículo, `parada_sem_marcacao` agora vence a arbitragem, onde antes nunca venceria. O tipo persistido/exibido nesses ciclos muda, e o tipo perdedor (se já tinha alerta ativo) é auto-resolvido como obsoleto. Decisão: manter o efeito (alinhado com o objetivo de priorizar sinal de desvio sobre ruído `favela`/`baseline_veiculo`), documentar aqui, e travar com teste em `detectores.test.ts` (`describe("arbitrarCandidatos"...)`) em vez de reverter.

### 3. Cron de re-sync automático de veículos

- `scripts/seed/02_veiculos.mjs`: troca o `INSERT ... ON CONFLICT (cliente_id, cv) DO NOTHING` por `DO UPDATE SET placa = EXCLUDED.placa WHERE veiculos.placa IS DISTINCT FROM EXCLUDED.placa` — só atualiza `placa`; `grupo`/`perfil`/`ativo` nunca são tocados no UPDATE (podem ter ajuste manual que não deve ser sobrescrito). Contador separado: "N inseridos, M atualizados" no log (hoje só reporta inseridos).
- Agendamento: crontab real no Contabo (mesmo padrão de `confirmar-presenca-romaneio.mjs` — standalone `.mjs`, `node --env-file=.env.production`, sem depender de build/PM2), 1x/dia às 05h BRT (antes do romaneio do dia ser processado). Comando: `node --env-file=.env.production scripts/seed/02_veiculos.mjs >> /var/log/transmonseg/sync-veiculos.log 2>&1`.
- Roda pros dois cod_user_unitrac já hardcoded no script (4096 Nutry Max, 4586 Benassi) — sem mudança de escopo aí.

## Testes

- (1) e (2): `npx tsc --noEmit`, `npx eslint`, `npx vitest run`, smoke test real via chrome-devtools MCP (confirmar seção colapsada aparece fechada, expande, badge aparece só no tipo certo, prioridade de ordenação muda).
- (2) backend: teste unitário pra `detectarParadaSemMarcacao` confirmando `nivel === "critico"` (arquivo de teste já existe em `detectores.test.ts`, só ajustar a asserção).
- (3): rodar o script manualmente uma vez contra produção antes de agendar (mesmo padrão usado hoje pra corrigir os 9 veículos), confirmar idempotência rodando 2x seguidas sem gerar diff. Crontab confirmado com `crontab -l` depois de instalado.

## Fora de escopo

- Mexer em `LIMIAR_CONFIANCA_MATCH`/correção `/match` do desvio — decisão já tomada na análise fria: esperar mais dias de dado pós-categorização (18/08) antes de mexer, não é o gargalo dominante confirmado.
- Qualquer mudança em `PainelCentral.tsx`/`FiltrosBar.tsx`/`CardAlertaCritico.tsx` (código morto, fora da tela ativa) — não tocar, não vale o esforço.
- Coluna SELECIONADOS do split view — fora do escopo da seção "outros avisos" (ver decisão 1).
- Threshold/lógica de disparo de `favela`/`baseline_veiculo`/`parada_anomala` — não mudam, só a exibição de 2 desses tipos.
