-- 027_vias_nomes.sql
-- Geocodificacao local do romaneio via extrato OSM -- ver
-- docs/superpowers/specs/2026-07-22-geocodificacao-local-romaneio-design.md.
-- Multiplas linhas com o mesmo nome_normalizado sao esperadas (candidatos
-- pra desambiguacao por cidade na hora da busca) -- sem PK composta.
CREATE TABLE vias_nomes (
  id bigint generated always as identity primary key,
  nome_normalizado text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL
);
CREATE INDEX idx_vias_nomes_nome ON vias_nomes (nome_normalizado);
