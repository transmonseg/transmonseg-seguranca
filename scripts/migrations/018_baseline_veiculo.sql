-- 018: baseline comportamental incremental por veiculo (substitui a ideia
-- original de historico por rota especifica -- dado real mostrou que so
-- 1,2% dos pares origem-destino repetem em 2+ dias, insuficiente). Mesmo
-- padrao ja usado em rota_perfil (media/variancia incremental, algoritmo de
-- Welford), agora por (veiculo, tipo_viagem, feature).
create table if not exists baseline_veiculo (
  veiculo_id uuid not null,
  tipo_viagem text not null,
  feature text not null,
  n_amostras bigint not null default 0,
  media double precision not null default 0,
  variancia double precision not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (veiculo_id, tipo_viagem, feature)
);

-- Baseline da FROTA INTEIRA por tipo_viagem (fallback de cold start,
-- enquanto o veiculo especifico nao acumula amostras suficientes).
create table if not exists baseline_frota (
  cliente_id uuid not null,
  tipo_viagem text not null,
  feature text not null,
  n_amostras bigint not null default 0,
  media double precision not null default 0,
  variancia double precision not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (cliente_id, tipo_viagem, feature)
);
