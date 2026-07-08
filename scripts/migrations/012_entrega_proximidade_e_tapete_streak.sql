-- 012: confirmacao manual de entrega por proximidade (compensa bug de
-- perimetro do Unitrac) + streak de "fora do tapete" pra nova Camada 3
-- do desvio (ver docs/plans/2026-07-08-entrega-proximidade-e-desvio-tapete-design.md).
create table if not exists entregas_confirmacao_manual (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references clientes(id) on delete cascade,
  veiculo_id    uuid not null references veiculos(id) on delete cascade,
  alvo_codigo   bigint not null,
  ponto_codigo  bigint,
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
create index if not exists idx_entregas_confirmacao_status on entregas_confirmacao_manual (cliente_id, status);

alter table posicoes_atuais add column if not exists fora_tapete_streak integer not null default 0;
