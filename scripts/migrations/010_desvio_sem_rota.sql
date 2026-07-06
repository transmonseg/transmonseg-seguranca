-- 010: desvio sem rota planejada (v2)
-- Remove a infra de corredor OSRM (rota sintetica) e cria o estado do
-- detector comportamental + tapete historico de celulas (~100m).

-- Estado do streak de desvio entre ciclos do motor
alter table posicoes_atuais drop column if exists fora_corredor;
alter table posicoes_atuais add column if not exists desvio_streak integer not null default 0;
alter table posicoes_atuais add column if not exists desvio_inicio jsonb;

-- Rota sintetica OSRM: conceito removido (nao existe rota planejada)
drop table if exists rotas_cache;

-- Tapete historico: celulas (~111m x 102m no RJ) percorridas pela frota
-- nos ultimos 30 dias. Agregado de proposito: nada de posicao crua.
create table if not exists corredor_celulas (
  cliente_id   uuid not null references clientes(id) on delete cascade,
  celula       text not null,
  ultimo_visto date not null default current_date,
  primary key (cliente_id, celula)
);
create index if not exists idx_corredor_ultimo_visto on corredor_celulas(ultimo_visto);
alter table corredor_celulas enable row level security;
