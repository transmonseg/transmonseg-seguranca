-- 011: perfil estatistico de rota (fecha o ponto cego do trajeto perpendicular
-- com limiar fixo). Baseline por destino especifico (media/desvio-padrao via
-- EWMA) do desvio perpendicular observado na aproximacao final -- se hoje o
-- desvio foge muito do normal DESSA rota, dispara mais cedo que o teto fixo
-- de 3km; se a rota é naturalmente tortuosa, nao fica mais sensivel que o
-- teto fixo. Agregado de proposito (1 linha por destino ja visitado, nao por
-- ciclo/evento) -- tabela pequena, sem TTL de limpeza (perfil deve acumular
-- historico, ao contrario do tapete).
create table if not exists rota_perfil (
  cliente_id     uuid not null references clientes(id) on delete cascade,
  celula         text not null,
  n_amostras     integer not null default 0,
  media_m        double precision not null default 0,
  variancia_m2   double precision not null default 0,
  atualizado_em  timestamptz not null default now(),
  primary key (cliente_id, celula)
);
alter table rota_perfil enable row level security;
