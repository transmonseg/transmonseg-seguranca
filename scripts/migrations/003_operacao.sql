-- ============================================================
-- Transmonseg Central — Migration 003: operacao
-- Adiciona colunas de entregas em posicoes_atuais e tabela de
-- cache de geocodificacao reversa (Nominatim).
-- ============================================================

alter table posicoes_atuais add column if not exists entregas_feitas integer default 0;
alter table posicoes_atuais add column if not exists entregas_total integer default 0;

create table if not exists geocode_cache (
  lat numeric(8,4), lng numeric(8,4), endereco text,
  criado timestamptz not null default now(), primary key (lat, lng)
);
