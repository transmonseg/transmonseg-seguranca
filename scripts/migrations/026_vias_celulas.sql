-- 026_vias_celulas.sql
-- Classificacao viaria (via principal x rua estreita) como reforco de
-- desvio -- ver docs/superpowers/specs/2026-07-21-classe-viaria-desvio-design.md.
-- Mesmo shape/filosofia de corredor_celulas: grade de celulas ~100m,
-- ingestao unica/manual a partir de extrato estatico do OpenStreetMap
-- (sem chamada de API recorrente). Sem RLS -- tabela interna do motor.
CREATE TABLE vias_celulas (
  celula text PRIMARY KEY,
  classe text NOT NULL CHECK (classe IN ('principal', 'intermediaria', 'estreita'))
);

-- Estado persistido por veiculo: quando foi a ultima vez que a posicao
-- caiu numa celula classe='principal'. NULL = nunca visto (ou fora da
-- cobertura do extrato OSM ingerido).
ALTER TABLE posicoes_atuais ADD COLUMN ultima_via_principal_em timestamptz NULL;
