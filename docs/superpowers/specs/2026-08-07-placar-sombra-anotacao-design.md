# Anotação do placar de desvio sombra no card do alerta — Design

**Contexto:** investigação de 4 casos reais de falso positivo relatados pelo
usuário no grupo de WhatsApp "DESVIO DE ROTA" hoje (07/08) — 2 deles
(RQU-9D10, afastando_de_tudo; TUS-0F04, classe_viaria/rua estreita) já foram
confirmados `falso_positivo` pelo operador. Nos dois, o placar de desvio
sombra (rodando desde 01/08, hoje com 6+ dias de dados) já tinha dado nota
baixa (2/100 e 0/100) puxada por sinais que os detectores binários não têm
acesso ("parado perto de entrega", "destino alinhado aproximando"). Duas
hipóteses de fix direto no detector `afastando_de_tudo` foram investigadas e
descartadas com evidência: filtrar destino a >50km não muda o resultado
desses casos (o destino distante já vota "afastando" quase sempre,
independente de qualquer coisa real acontecer); ampliar a lista de destinos
pra incluir pontos já entregues no dia (paralelo ao fix já aplicado ao
placar em 03/08, achado UBO-5E01) foi mapeado como PERIGOSO — abriria
brecha pra um sequestro/roubo em andamento se "resgatar sozinho" por
coincidência de malha viária perto de um endereço já riscado da lista horas
atrás.

**Goal:** dar ao operador, no próprio card do alerta, o mesmo sinal que já
existe internamente e já teria acertado esses 2 casos — sem tocar em quando
o alerta dispara, escala ou fecha.

**Arquitetura:** mesmo padrão já em produção de `progresso_destino`
(construído ontem/hoje, mesmo arquivo): coleta por ciclo → flush em lote
puramente aditivo no `contexto` JSONB do alerta → leitura/exibição no
frontend. Reaproveita `placarNovo`/`componentesPlacar`
(`src/app/api/motor/route.ts:3339-3343`), já calculados todo ciclo por
veículo — nenhum cálculo novo.

## Escopo

Só os 2 detectores hoje ativos que o placar cobre, identificados pelo
`motivo` do alerta:
- `MOTIVO_AFASTANDO_PREFIXO` ("Afastando-se de todos...")
- `MOTIVO_RUA_ESTRANHA` ("Saiu de via principal recentemente e está em rua
  estreita...")

`rumo_diverge` (3º detector que o placar cobre) fica de fora na prática —
hoje desligado por `DESVIO_SO_AFASTANDO_OU_FORA_DO_TAPETE`, sem alertas
reais em produção, sem constante de motivo exportada pra identificá-lo com
segurança.

**Fora do escopo, explicitamente:** o detector de corredor ("Fora da rota
esperada", caso RQU-1G17 desta investigação) — o placar sombra não cobre
esse detector, não tem sinal pra mostrar ali. Nenhuma mudança em
`nivel`/`status`/disparo/auto-resolução de nenhum alerta. Nenhuma promoção
do placar a mecanismo de decisão (isso é a discussão separada, maior, de
"Fase 2", não decidida agora).

## Dados

Novo campo no `contexto` JSONB do alerta, mesmo mecanismo de merge aditivo
(`update alertas set contexto = contexto || $2::jsonb where id = $1`) já
usado por `progresso_destino`/`proximidadeDesvioCiclo`/`rotaConcluidaCiclo`:

```typescript
placar_sombra: {
  placar: number;          // placarNovo do ciclo, 0-100
  componentes: Record<string, number | boolean | string>; // componentesPlacar do ciclo, como já é hoje
  atualizado_em: string;   // ISO timestamp do ciclo
}
```

`componentes` é gravado como vem de `atualizarPlacar` — mesmo shape que já
existe hoje em `casos_desvio_revisao.contexto_detector` (chaves como
`s1AfastandoDeTudo`, `d1ParadaPertoDeEntrega`, etc., ver
`PLACAR_PESOS` em `src/lib/placar-desvio.ts`), nenhuma transformação na
gravação — a tradução pra texto humano acontece só na exibição (Task de
frontend), igual `formatarProgressoDestino` fez pro delta de distância.

## Coleta e flush (route.ts)

Mesma posição no código de `progressoDestinoCiclo`/`proximidadeDesvioCiclo`
(dentro do loop por veículo, depois que `placarNovo`/`componentesPlacar` já
foram calculados na linha 3339-3343):

```typescript
const placarSombraCiclo: { alerta_id: string; placar: number; componentes: Record<string, unknown> }[] = [];
```

Coleta (nova função pura em `detectores.ts`, mesmo padrão de
`elegivelParaAutoResolveAfastando`):

```typescript
export function elegivelParaAnotarPlacarSombra(alerta: { tipo: string; motivo: string; status: string }): boolean {
  return (
    alerta.status === "ativo" &&
    alerta.tipo === "desvio" &&
    (alerta.motivo.startsWith(MOTIVO_AFASTANDO_PREFIXO) || alerta.motivo === MOTIVO_RUA_ESTRANHA)
  );
}
```

No loop, logo depois de `placarDesvioSombraContexto` ser montado
(~linha 3422), pra cada alerta aberto elegível deste veículo:

```typescript
for (const d of alertasAbertos.filter((a) => elegivelParaAnotarPlacarSombra(a))) {
  placarSombraCiclo.push({ alerta_id: d.id, placar: placarNovo, componentes: componentesPlacar });
}
```

Sem guard de `saltoImplausivel`/`pos.fresco` (diferente de
`progresso_destino`): o placar já tem seus próprios guards internos
(`podeSomarSinaisPlacar`, Guard 7 em `temPendentes`/`pos.fresco` na linha
3272) — reflete o valor real que o placar calculou pra este ciclo, sem
duplicar lógica de confiabilidade.

Flush em lote (mesmo bloco de `route.ts` onde `progressoDestinoCiclo` é
descarregado, ~linha 4442), dedupe por `alerta_id` mantendo o último valor
do ciclo:

```typescript
if (placarSombraCiclo.length > 0) {
  const porAlertaPlacar = new Map(placarSombraCiclo.map((p) => [p.alerta_id, p]));
  const resultadosPlacar = await Promise.allSettled(
    [...porAlertaPlacar.values()].map((p) =>
      pool.query(
        `update alertas set contexto = contexto || $2::jsonb where id = $1`,
        [
          p.alerta_id,
          JSON.stringify({
            placar_sombra: {
              placar: Math.round(p.placar),
              componentes: p.componentes,
              atualizado_em: new Date().toISOString(),
            },
          }),
        ]
      )
    )
  );
  const falhasPlacar = resultadosPlacar.filter((r) => r.status === "rejected").length;
  if (falhasPlacar > 0) console.warn(`Aviso: ${falhasPlacar} falha(s) ao anotar placar sombra neste ciclo`);
}
```

(Cópia literal do padrão `Promise.allSettled` + contagem de falhas já usado
pelo flush de `progressoDestinoCiclo`, linhas 4442-4462 — mesma função,
mesmo `pool`, mesmo tratamento de erro parcial.)

## Exibição (frontend)

Nova função pura em `detectores.ts`, mesmo padrão de
`formatarProgressoDestino`:

```typescript
const LABEL_COMPONENTE_PLACAR: Record<string, string> = {
  s1AfastandoDeTudo: "afastando de tudo",
  s2RumoDivergente: "rumo divergente",
  s3ForaDoCorredor: "fora do corredor",
  s4CelulaDesconhecida: "célula desconhecida",
  s5DiaEstagnado: "dia estagnado",
  s6ParadoLongeDeTudo: "parado longe de tudo",
  d1ParadaPertoDeEntrega: "parado perto de entrega",
  d2PadraoEntrega: "padrão de entrega",
  d3DestinoAlinhadoAproximando: "destino alinhado e aproximando",
  d4DentroDoCorredor: "dentro do corredor",
};

export function formatarPlacarSombra(placar: number, componentes: Record<string, unknown>): string {
  const ativos = Object.keys(componentes)
    .filter((k) => LABEL_COMPONENTE_PLACAR[k] && componentes[k] !== false)
    .map((k) => LABEL_COMPONENTE_PLACAR[k]);
  const sufixo = ativos.length > 0 ? ` — sinais: ${ativos.join(", ")}` : "";
  return `Placar sombra: ${Math.round(placar)}/100${sufixo}`;
}
```

Chaves de auditoria que não são pesos reais de score
(`classeViariaSuprimida`, `classeViariaSuprimidaPor`, `zeradoPorChegada`)
ficam de fora de `LABEL_COMPONENTE_PLACAR` de propósito — o filtro
`LABEL_COMPONENTE_PLACAR[k]` já as exclui automaticamente (chave ausente no
mapa = ignorada), sem precisar de uma lista de exclusão separada.

**Sem cor de "seguro"/"resolvido"**, mesma disciplina de
`formatarProgressoDestino`: texto plano, cor neutra (`T.dim`), nunca verde,
nunca a palavra "seguro" ou "resolvido". O número e os sinais falam por si
— quem decide é o operador.

`page.tsx`: extrair `contexto.placar_sombra` no `enriquecer()`, mesmo padrão
de `progressoDestinoM`. `MonitorV2.tsx`: renderizar a linha nova logo abaixo
da linha de `progresso_destino` existente, só quando `placar_sombra` estiver
presente. `api/alertas/route.ts`: **replicar a mesma extração** — achado da
Task 2 de ontem foi exatamente esquecer essa rota de polling de 30s e gerar
"+NaNm" em todo card; não repetir o mesmo buraco aqui.

## Testes

`detectores.test.ts`: `elegivelParaAnotarPlacarSombra` (afastando_de_tudo
elegível, rua_estranha elegível, outro motivo não elegível, status≠ativo
não elegível, tipo≠desvio não elegível) e `formatarPlacarSombra` (zero
componentes ativos, 1 componente, múltiplos componentes, componente
`false` excluído, chave de auditoria desconhecida excluída, placar
fracionário arredondado).

## Replicação e deploy

Mesmo processo de sempre: replicar pro repo espelho `MONITORAMENTO
transmonseg`, deploy manual via PM2 nos dois processos
(`transmonseg-temp`/`transmonseg-definitivo`), verificar em produção real
contra um alerta ativo de um dos 2 tipos cobertos.
