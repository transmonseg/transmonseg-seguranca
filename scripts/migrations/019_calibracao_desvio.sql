-- 019: thresholds/pesos calibrados por segmento de contexto, calculados a
-- partir dos rotulos reais dos operadores (Fase 5). Substitui o ajuste no
-- chute que causou o problema de 11/07.
create table if not exists calibracao_desvio (
  segmento text primary key,
  n_amostras int not null default 0,
  n_falso_positivo int not null default 0,
  taxa_falso_positivo double precision not null default 0,
  score_ajustado double precision,
  atualizado_em timestamptz not null default now()
);
