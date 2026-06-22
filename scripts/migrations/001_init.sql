-- ============================================================
-- Transmonseg Central — Migration 001: fundação
-- Central de inteligência de risco multi-cliente.
-- PostGIS para geofence (favela/zona de risco/base) e posições.
-- ============================================================

create extension if not exists postgis;
create extension if not exists "pgcrypto"; -- gen_random_uuid

-- ─── Clientes (transportadoras monitoradas: Nutry, Benassi...) ───
create table if not exists clientes (
  id                uuid primary key default gen_random_uuid(),
  nome              text not null,
  cod_user_unitrac  text not null unique,      -- ex: "4096" (Nutry)
  empresa_cod_unitrac text,                     -- ex: "722" (áreas)
  ativo             boolean not null default true,
  created_at        timestamptz not null default now()
);

-- ─── Operadores (usuários da central, ligados ao Supabase Auth) ───
-- papel: 'admin' (Transmonseg, vê tudo) | 'operador' | 'cliente' (vê só sua frota)
create table if not exists operadores (
  id          uuid primary key references auth.users(id) on delete cascade,
  nome        text not null,
  papel       text not null default 'operador' check (papel in ('admin','operador','cliente')),
  cliente_id  uuid references clientes(id) on delete set null, -- null = vê todos
  created_at  timestamptz not null default now()
);

-- ─── Veículos (a frota de cada cliente) ───
-- perfil: como classificar a operação para aplicar as regras certas
create table if not exists veiculos (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references clientes(id) on delete cascade,
  cv          text not null,                    -- código do veículo na Unitrac
  placa       text not null,
  grupo       text,
  perfil      text not null default 'auto' check (perfil in ('urbano','estrada','auto')),
  ativo       boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (cliente_id, cv)
);
create index if not exists idx_veiculos_cliente on veiculos(cliente_id);

-- ─── Bases / garagens (ponto seguro de cada cliente) ───
create table if not exists bases (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references clientes(id) on delete cascade,
  nome        text not null,
  geom        geography(point, 4326) not null,
  raio_m      integer not null default 250,
  created_at  timestamptz not null default now()
);
create index if not exists idx_bases_geom on bases using gist(geom);

-- ─── Geofences (favela, zona de risco, ponto seguro) ───
-- cliente_id null = global (ex: favelas valem para todas as frotas do RJ)
create table if not exists geofences (
  id          uuid primary key default gen_random_uuid(),
  tipo        text not null check (tipo in ('favela','risco','ponto_seguro')),
  nome        text,
  fonte       text,                              -- 'sabren' | 'manual' | 'ibge'...
  cliente_id  uuid references clientes(id) on delete cascade,
  geom        geography(polygon, 4326) not null,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists idx_geofences_geom on geofences using gist(geom);
create index if not exists idx_geofences_tipo on geofences(tipo);

-- ─── Posição atual (1 linha por veículo, upsert a cada ciclo do motor) ───
create table if not exists posicoes_atuais (
  veiculo_id   uuid primary key references veiculos(id) on delete cascade,
  lat          double precision,
  lng          double precision,
  geom         geography(point, 4326),
  velocidade   integer,
  ignicao      boolean,
  atraso_min   integer,                          -- min sem comunicar (frescor/jammer)
  panico       boolean default false,
  bau_aberto   boolean default false,
  nivel        text,                             -- verde|amarelo|vermelho|concluido
  motivo       text,
  local        text,
  datagps      timestamptz,
  updated_at   timestamptz not null default now()
);
create index if not exists idx_posatuais_geom on posicoes_atuais using gist(geom);
create index if not exists idx_posatuais_nivel on posicoes_atuais(nivel);

-- ─── Alertas (coração: ativos + histórico) ───
-- status: ativo -> reconhecido -> resolvido | falso_positivo
create table if not exists alertas (
  id           uuid primary key default gen_random_uuid(),
  cliente_id   uuid not null references clientes(id) on delete cascade,
  veiculo_id   uuid not null references veiculos(id) on delete cascade,
  nivel        text not null check (nivel in ('critico','atencao')),
  tipo         text not null,                    -- parada_anomala|panico|bau|jammer|desvio|...
  motivo       text not null,
  score        integer not null default 0,
  status       text not null default 'ativo' check (status in ('ativo','reconhecido','resolvido','falso_positivo')),
  lat          double precision,
  lng          double precision,
  geom         geography(point, 4326),
  contexto     jsonb not null default '{}',
  desde        timestamptz not null default now(),
  resolvido_em timestamptz,
  operador_id  uuid references operadores(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_alertas_status on alertas(status);
create index if not exists idx_alertas_cliente on alertas(cliente_id);
create index if not exists idx_alertas_veiculo on alertas(veiculo_id);
create index if not exists idx_alertas_desde on alertas(desde desc);

-- ─── Eventos (linha do tempo / log bruto) ───
create table if not exists eventos (
  id          bigint generated always as identity primary key,
  veiculo_id  uuid references veiculos(id) on delete cascade,
  alerta_id   uuid references alertas(id) on delete set null,
  tipo        text not null,
  payload     jsonb not null default '{}',
  ts          timestamptz not null default now()
);
create index if not exists idx_eventos_veiculo_ts on eventos(veiculo_id, ts desc);

-- ─── RLS: liga em tudo (default deny). O motor usa service_role (bypassa).
-- Policies de leitura por papel/cliente entram quando montarmos o Auth.
alter table clientes        enable row level security;
alter table operadores      enable row level security;
alter table veiculos        enable row level security;
alter table bases           enable row level security;
alter table geofences       enable row level security;
alter table posicoes_atuais enable row level security;
alter table alertas         enable row level security;
alter table eventos         enable row level security;
