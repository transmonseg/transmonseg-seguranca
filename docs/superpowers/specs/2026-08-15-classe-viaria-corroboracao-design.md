# Classe viária (queda de via) como corroboração do desvio, Design

**Data:** 2026-08-15
**Status:** em revisão com o usuário

## Contexto

Depois de trazer o corredor real via OSRM de volta como corroboração (14/08,
`docs/superpowers/specs/2026-08-14-desvio-corredor-corroboracao-design.md`), o usuário pediu uma
auditoria completa do histórico do projeto (~1000 commits nos dois repos) pra achar qual regra,
entre TODAS as que já existiram, tinha o melhor histórico documentado de pegar desvio real —
não só supor, medir contra o que já foi confirmado no passado.

O resultado da auditoria (14-15/08) é inequívoco: **classe_viária** (detector que dispara quando
o veículo sai de uma via principal/intermediária e entra numa rua estreita, longe de qualquer
destino conhecido) tem, de longe, o histórico mais forte de todo o projeto — **16 casos reais
confirmados individualmente em 272** (clique um a um do operador, não resolução em massa),
incluindo **2 confirmados pelo próprio cliente por telefone** (RQV-6C22 e TUC-1D15, 31/07). Nenhum
outro detector chega perto desse volume de confirmação individual:

- corredor/rota real: 2/18 (proporção maior, amostra pequena) — e a medição de ontem (14/08,
  já em produção) mostrou que o sinal atual NÃO discrimina bem (corrobora 92,1% dos falso
  positivo vs 68,0% dos casos reais confirmados) — mesmo conceito, evidência mais fraca na prática.
- afastando_de_tudo (único detector ativo hoje): vários casos nomeados, nunca teve contagem
  consolidada "N/M" — sobreviveu por filosofia (recall > precisão), não por número comprovado.
- rumo_diverge: 1/38. saída_parada: 0/1. rua_rara_frota: 0/14 (desligado 13/08). Todos
  corretamente desligados.

classe_viária também foi, historicamente, a maior fonte bruta de falso positivo do projeto (~69%
medido em 27/07, chegando a 77% num dia isolado) — os dois fatos não se contradizem: o volume
bruto de disparos dela sempre foi muito maior que o de qualquer outra regra, então tem mais
acerto real E mais ruído bruto ao mesmo tempo. O padrão de decisão do usuário nesta sessão inteira
(corredor de ontem, mesma lógica aqui) resolve exatamente essa tensão: **corroboração, nunca
supressão/regra primária** — o volume bruto de "falso positivo" da classe_viária deixa de importar,
porque ela nunca mais decide sozinha se um alerta existe.

## Decisão

Trazer classe_viária de volta, no mesmo papel e com a mesma disciplina do corredor de ontem:

- Roda **depois** que `afastando_geral` já decidiu disparar (nunca antes, nunca decide SE
  dispara). Só soma score.
- Fail-open total: qualquer falha (sem célula classificada, sem histórico suficiente, erro de
  banco) resulta em nenhum ajuste, nunca em bloqueio do alerta.
- Reaproveita o mesmo `BONUS_CORROBORACAO_POR_SINAL` (+15) e o mesmo ponto de wiring em
  `route.ts` já usado pelo corredor (logo depois que `alertaDesvioV2` existe, antes do INSERT em
  `desvio_disparo_log`) — os dois bônus podem se somar no mesmo ciclo se ambos confirmarem
  (mesma composição aditiva já documentada e aceita para corredor + trânsito inferido).

Isso resolve diretamente o pedido do usuário ("impedir que dê desvio no cliente"): como a
corroboração só roda depois que `afastando_geral` já decidiu disparar, e esse detector já
suspende toda avaliação quando o veículo está dentro do raio de chegada de um destino conhecido
(`suspenderPorChegada`, `RAIO_CHEGADA_MIN_M=300m`), o caso mais comum de falso positivo antigo
("chegou e parou pouco depois", ~69% dos casos revisados em 27/07) já fica estruturalmente
filtrado antes da classe_viária sequer ser avaliada.

## O que é portado do sistema antigo, e o que é redesenhado

O detector original (`src/lib/classificacao-viaria.ts` + lógica em `src/lib/detectores.ts` +
4 gates de contexto em `src/app/api/motor/route.ts`, todos apagados por completo no commit
`6643bee`/`f695308..492f140`, 12/08) tinha 4 sinais de contexto. Dois são portados quase
intactos, um é simplificado, um é descartado:

### 1. Taxonomia viária — portada sem mudança

```typescript
const TAXONOMIA_VIARIA: Record<string, ClasseViaria> = {
  motorway: "principal", motorway_link: "principal",
  trunk: "principal", trunk_link: "principal",
  primary: "principal", primary_link: "principal",
  secondary: "principal", secondary_link: "principal",
  tertiary: "intermediaria", tertiary_link: "intermediaria",
  unclassified: "intermediaria", living_street: "intermediaria",
  residential: "estreita", service: "estreita", track: "estreita",
};
```

Já materializada na tabela `vias_celulas` (célula → classe), **1.322.207 linhas, ainda existe no
banco de produção, não foi apagada** — não precisa reingestão via Overpass. Reaproveitada como
está.

### 2. `quedaClasseViaria` — redesenhada sem estado novo no banco

Original: célula atual = "estreita" E o veículo esteve numa célula "principal" nos últimos 10
minutos, rastreado por uma coluna de estado (`ultima_via_principal_em`) atualizada a cada ciclo.

Hoje: **sem coluna nova**, mesmo padrão usado pela âncora do corredor ontem — busca em
`posicoes_historico` os últimos 10 minutos do veículo, calcula a célula (`celulaDe`, já existe em
`src/lib/celulas.ts`, não mudou) de cada posição, consulta `vias_celulas` em lote, e confirma:
célula da posição atual = "estreita" E alguma célula do histórico de 10min = "principal". Mesmo
resultado lógico, sem persistir estado por ciclo.

### 3. `saiuParadaConfirmadaRecentemente` — mantido, adaptado à fonte de dado atual

Gate mais valioso do sistema antigo depois da taxonomia em si: achado real de 28/07 mostrava que
**36% dos falso positivo revisados manualmente** eram o veículo saindo de uma parada de entrega
LEGÍTIMA (dwell confirmado ≥120s) e pegando uma rua estreita logo em seguida — comportamento
normal, não desvio. Suprime só esse branch quando o veículo saiu de uma parada confirmada há
menos de 5 minutos.

Reaproveita o mesmo estado de dwell/raio que o `bypass_entrega` de hoje já calcula no loop do
motor (`alvoNoRaioAgora`, dwell acumulado, `saiuDoRaioAgora`) — sem duplicar essa lógica, só lê o
resultado já computado no ponto certo do ciclo.

### 4. `classeViariaSuprimidaPorEntrega` — descartado

Dependia do sistema de placar D1-D6/S1-S6 inteiramente removido em 12/08 (nunca chegou a virar
detector de produção — reprovado em revisão independente por ter limiar estruturalmente
inalcançável, `923c033`). Decisão explícita: não reconstruir. Como a corroboração já é
estritamente aditiva e já roda atrás do gate de chegada do `afastando_geral` (ver seção
"Decisão" acima), o caso que esse gate evitava (contar erroneamente uma entrega em andamento como
suspeita) já está coberto por outra camada — reconstruir um gate novo só pra isso seria
complexidade sem redução de risco real proporcional.

## Arquitetura

Novo módulo puro `src/lib/classe-viaria-confirmacao.ts` (mesmo padrão de
`src/lib/corredor-confirmacao.ts`, sem I/O direto — recebe dados já buscados):

```
avaliarQuedaClasseViaria(
  celulaAtual: string,
  historico10min: { celula: string }[],
  classesPorCelula: Map<string, "principal" | "intermediaria" | "estreita">
): { quedaDetectada: boolean }
```

Wiring em `route.ts`, no mesmo bloco onde o corredor já roda hoje (logo após `alertaDesvioV2`
existir, antes do INSERT em `desvio_disparo_log`):

```typescript
if (alertaDesvioV2 && !saiuParadaConfirmadaRecentemente) {
  try {
    const { quedaDetectada } = avaliarQuedaClasseViaria(
      celulaAtualDesvio, // já calculada mais acima no ciclo, reaproveitada
      historicoPosicoes10min,
      classesViariasCliente
    );
    if (quedaDetectada) {
      alertaDesvioV2 = {
        ...alertaDesvioV2,
        score: Math.min(100, alertaDesvioV2.score + BONUS_CORROBORACAO_POR_SINAL),
        motivo: `${alertaDesvioV2.motivo} (corroborado por: saiu de via principal para rua estreita)`,
      };
    }
  } catch (errClasseViaria) {
    erros.push(`Aviso: falha ao avaliar classe viaria pro veiculo ${veiculo_id}: ${String(errClasseViaria)}`);
  }
}
```

`desvio_disparo_log` ganha uma coluna nova, `classe_viaria_confirmou boolean`, mesmo padrão de
`corredor_confirmou` (migration de ontem) — pra medir depois quantos disparos reais esse sinal de
fato corrobora, sem precisar reconstruir do texto de `motivo`.

## Erros / fail-open

- Célula sem classificação em `vias_celulas` (área não coberta pela ingestão original) →
  `quedaDetectada: false`, sem ajuste. Nunca bloqueia o alerta.
- Sem histórico suficiente em `posicoes_historico` (veículo muito recente na frota) → mesmo
  efeito.
- Todo o bloco em try/catch, mesmo padrão do corredor — falha aqui nunca aborta o ciclo do
  veículo nem impede o alerta de gravar.

## Testes e validação

- TDD na função pura nova (`avaliarQuedaClasseViaria`), casos sintéticos primeiro.
- **Obrigatório antes de considerar pronto** (lição direta de ontem, onde o corredor passou nos
  testes mas a validação contra produção revelou que ele não discrimina bem): rodar contra os
  disparos reais dos últimos 14 dias, com os MESMOS 2 grupos de controle já usados pro corredor —
  (a) `falso_positivo` vs `resolvido`, (b) amostra de ciclos sem streak formado. Reportar os
  números reais antes de declarar a feature funcionando, sem tirar conclusão prescritiva
  automática — a decisão de manter/ajustar o bônus depois de ver os números é do usuário, mesmo
  padrão de ontem.
- Confirmar que nenhum alerta deixa de disparar por causa desta mudança — mesmo tipo de garantia
  já verificada pro corredor (o bloco só ajusta score de um alerta que já existe).

## Fora de escopo (não decidido/adiado)

- Reconstruir o placar D1-D6/S1-S6 ou qualquer gate de "prova de entrega" equivalente — decidido
  contra, ver seção 4 acima.
- Revisitar o bônus do corredor de ontem (a medição de 14/08 mostrou discriminação invertida,
  falso positivo corrobora mais que caso real) — o usuário decidiu explicitamente manter como
  está por enquanto ("deixa aí"), fora do escopo desta rodada.
- Qualquer outro detector do ranking da auditoria (rumo_diverge, saída_parada, rua_rara_frota,
  placar D1-D6) — todos com evidência real fraca ou nula, não justificam trazer de volta nesta
  rodada.
