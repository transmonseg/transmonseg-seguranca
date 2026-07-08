# Design: confirmação de entrega por proximidade + desvio baseado no tapete real

Data: 2026-07-08. Status: aprovado pelo cliente em conversa, aguardando plano de implementação.

## Contexto — duas dores reais reportadas pelo cliente

1. O Unitrac às vezes não marca uma entrega como feita mesmo o motorista tendo
   parado no endereço certo — bug do perímetro deles (confirmado: eles têm um
   raio próprio, `pontoraio`, tipicamente 50m, que às vezes não bate por GPS
   impreciso, estacionamento longe da porta, condomínio grande etc.).
2. O detector de desvio "Trajeto Xkm fora de qualquer caminho direto
   plausível" dispara em situações sem sentido nenhum — casos reais
   investigados nesta sessão (ver evidência abaixo) mostram o veículo
   **indo na direção certa**, a poucos km de uma entrega pendente real, e
   mesmo assim sendo marcado como "fora do caminho".

## Parte 1 — Confirmação de entrega por proximidade

### Problema

`agruparAlvosPorPlaca`/`agruparPontosPorPlaca` (`src/lib/unitrac.ts`) tratam
`alvosituacaoservico` como fonte única de verdade pra "entregou ou não". Se o
Unitrac não confirma, o ponto continua como pendente pro sempre (contando
errado no progresso de entregas E entrando na lista de "destinos legítimos"
que alimenta o detector de desvio — um pendente fantasma pode inclusive
contribuir pra falsos positivos de desvio).

### Solução: candidato + confirmação manual (não automático)

O motor já computa, por ciclo e por veículo, `parado_desde` (desde quando
está parado) e já existe a função `alvoMaisProximoQualquer` (ponto de entrega
mais próximo, qualquer status). Vamos reaproveitar os dois:

**Regra de detecção** (calculada no motor, dentro do loop por veículo):
- Veículo parado (`velocidade === 0`) há **>= 5 minutos** (`paradoMin >= 5`),
- a **<= 500m** de um ponto de entrega que o Unitrac ainda mostra como
  pendente (`alvosituacaoservico === 0`),
- e esse ponto ainda não tem um candidato/confirmação registrado.

Quando a regra bate, o motor grava uma linha em uma tabela nova
(`entregas_confirmacao_manual`, migration 012):

```sql
create table entregas_confirmacao_manual (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references clientes(id) on delete cascade,
  veiculo_id    uuid not null references veiculos(id) on delete cascade,
  alvo_codigo   bigint not null,   -- alvocodigo da Unitrac (a entrega especifica)
  ponto_codigo  bigint,            -- pontocodigo (endereco) — pode repetir entre alvos
  lat           double precision not null,
  lng           double precision not null,
  distancia_m   integer not null,
  parado_min    integer not null,
  status        text not null default 'pendente'
                check (status in ('pendente','confirmado','rejeitado')),
  detectado_em  timestamptz not null default now(),
  resolvido_em  timestamptz,
  operador_id   uuid references operadores(id),
  unique (cliente_id, alvo_codigo)
);
alter table entregas_confirmacao_manual enable row level security;
```

`unique(cliente_id, alvo_codigo)`: um alvo só vira candidato uma vez — se o
operador rejeitar, não volta a aparecer sozinho (só se o operador reabrir
manualmente, fora de escopo por ora).

**UI**: uma faixa/lista nova (mesmo padrão visual da faixa de desvios de
hoje) — "Possíveis entregas não confirmadas (N)" — com botões **Confirmar**
/ **Descartar** por item. Confirmar não escreve nada no Unitrac (não dá,
API deles é read-only pra isso); só marca `status='confirmado'` na nossa
tabela.

**Efeito de "confirmado"**: em `agruparPontosPorPlaca` (ou em quem monta
`pontosPorPlaca` no motor), um alvo com `alvo_codigo` presente em
`entregas_confirmacao_manual` com `status='confirmado'` passa a contar como
`feito=true` pro NOSSO sistema — reflete em `entregas_feitas`/`total` e sai
da lista de pendentes que o detector de desvio usa. O Unitrac continua
mostrando pendente (não mexemos lá); só o nosso sistema sabe da confirmação.

**Retenção**: `entregas_confirmacao_manual` cresce devagar (1 linha por
candidato real, não por ciclo) — mas ainda assim, limpar linhas
`resolvido_em < hoje - 60 dias` no bloco de limpeza horária que já existe no
motor (mesmo padrão de `geocode_cache`/`corredor_celulas`).

### Edge cases
- Veículo passa por perto de várias entregas pendentes ao mesmo tempo
  (endereços vizinhos): só o `alvoMaisProximoQualquer` (o mais próximo)
  vira candidato, não todos dentro do raio — evita "confirmar 5 entregas de
  uma vez" por engano.
- Veículo já tinha confirmado antes e o Unitrac finalmente sincroniza
  (`alvosituacaoservico` muda pra 1): não tem problema, os dois concordam,
  a linha na nossa tabela fica órfã mas inofensiva (ou pode ser limpa).

## Parte 2 — Desvio: trocar linha reta por tapete real

### Evidência do bug (dois casos reais investigados nesta sessão)

**TTM-2G01** (16/07 entregas feitas): alerta "Trajeto 4,1km fora de qualquer
caminho direto plausível... mesmo aproximando" — sem perfil de rota
confiável, batendo no teto fixo.

**TUK-0H45** (26/37 entregas feitas, caso mais claro): a
`~4,2km` da entrega pendente mais próxima ("JOSE DE SOUZA LIMA FILHO"),
**indo na direção dela** (velocidade 31km/h, sem sinal de afastamento — Camada
1 não disparou). A base do cliente fica a **45km** dali. Reconstruí o cálculo
exato (`distanciaAoSegmentoM` entre a base e cada pendente): a distância
perpendicular mínima encontrada foi **4224m — quase idêntica à distância
direta até a própria entrega (4226m)**.

Esse é o defeito: quando o veículo está perto o bastante do destino mas
chegando por um ângulo fora da reta base→destino (praticamente garantido
quando a base fica a dezenas de km e a entrega é numa rua de bairro/serra), a
projeção perpendicular "clampa" no próprio ponto de destino — a métrica vira,
na prática, **distância crua até a entrega**, não "quão fora do caminho" o
veículo está. Resultado: qualquer entrega não perfeitamente alinhada numa
reta com a base dispara, mesmo em aproximação 100% normal. Numa operação
espalhada (serra, entregas a dezenas de km da base), isso é a maioria dos
casos — não é uma exceção rara.

### Solução: Camada 3 vira "fora do tapete, mesmo aproximando"

Em vez de comparar contra uma reta idealizada, reaproveita o que a Camada 2
já calcula todo ciclo: `dentroTapete` (o veículo está numa célula que a
frota já percorreu nos últimos 30 dias?). O motor já busca isso de forma
restrita e barata (fix de egress de hoje mais cedo).

**Nova regra da Camada 3** (fecha o mesmo "ponto cego" de antes — veículo
tecnicamente aproximando de algum destino, mas por caminho implausível):

- Pré-condição igual a hoje: `afastandoDeTudo === false` (Camada 1 não
  disparou — o veículo está de fato aproximando de pelo menos 1 destino).
- Novo gatilho: `dentroTapete === false` (fora de qualquer via que a frota já
  percorreu, com cobertura mínima confirmada — reaproveita
  `TAPETE_MIN_CELULAS` que já existe) **por 2 leituras seguidas** (streak
  próprio, novo, mesmo padrão do `desvio_streak` — persistido em
  `posicoes_atuais` via migration 012).
- Sem essas 2 condições ao mesmo tempo, não dispara.

**Motivo do alerta fica**: `"Aproximando de uma entrega, mas por caminho que
a frota nunca percorreu antes (fora de via conhecida há N leituras)"`.

**O que é removido**: `desvioTrajetoM`, `distanciaAoSegmentoM` (uso no
desvio — a função em si pode continuar existindo se usada em outro lugar,
confirmar no plano), `TRAJETO_PERPENDICULAR_LIMIAR_M`, e o mecanismo de
perfil de rota (`rota_perfil`, `rotaperfil.ts`, `PERFIL_ROTA_*`) — ele existia
só pra afinar o teto fixo da reta por destino; sem a reta, não tem mais o que
afinar. A tabela `rota_perfil` pode ficar (dado histórico, sem custo
relevante) ou ser dropada — decidir no plano.

### Motivo detalhado ("ver motivo completo")

Pedido do cliente: o texto expandido do alerta deve mostrar mais contexto,
não só a frase seca. Novo formato do motivo (Camada 1, a mais comum) passa
a incluir fase + números:

```
Afastando-se de todos os 4 destinos há 3 leituras seguidas (~3min),
+1,2km acumulado desde 14:32. Fora de via conhecida da frota. Área: risco
elevado (favela a 400m).
```

Ou seja: fase (leituras seguidas = "em andamento"; tempo aproximado),
distância acumulada, se está fora do tapete, e quais sinais de risco de área
contribuíram (favela/tiroteio/roubo de carga) — hoje o motivo só menciona
"área de risco elevado" sem dizer QUAL sinal. Isso é só formatação de texto
(os dados já existem em `CtxDesvio`/`calcularRiscoArea`), não precisa de
dado novo.

## Testes
- `detectores.test.ts`: reescrever os testes de Camada 3 (hoje testam
  `desvioTrajetoM`/perfil) pra testar a nova regra (`dentroTapete` + streak
  próprio). Remover testes de `perfilRotaMedia` no contexto de desvio.
- Cenário novo: veículo aproximando de destino real só que fora do tapete
  por 2 leituras → dispara. Aproximando E dentro do tapete → não dispara
  (esse é exatamente o caso TUK-0H45/TTM-2G01, vira teste de regressão).
- `unitrac.test.ts`: função de "candidato a entrega por proximidade"
  (pura, testável sem rede: dado posição + lista de pendentes + parado_min,
  retorna candidato ou null).

## Riscos / rollback
- Camada 3 nova depende de tapete com cobertura mínima (`TAPETE_MIN_CELULAS`)
  — em rotas MUITO novas (cliente novo, sem 30 dias de histórico), ela nunca
  dispara (mesmo comportamento seguro de hoje: sem tapete confiável, nunca
  crítico só por isso).
- Migration 012 é aditiva (nova tabela + 1 coluna nova em `posicoes_atuais`)
  — não quebra nada existente; remover uso de `rota_perfil` no detector é
  reversível (a tabela continua existindo).
- Rollback: reverter o commit volta pro teto fixo de 5km; não há mudança de
  schema destrutiva.
