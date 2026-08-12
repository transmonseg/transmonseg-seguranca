-- 041_desvio_estado.sql
-- Estado do detector de desvio v2 (spec 2026-08-12-desvio-de-rota-v2-design.md).
-- 1 linha por veiculo. Substitui TODAS as colunas de desvio antigas em
-- posicoes_atuais (removidas na migration 043) -- tabela propria, isolada.
CREATE TABLE desvio_estado (
  veiculo_id uuid PRIMARY KEY REFERENCES veiculos(id) ON DELETE CASCADE,
  afastando_streak int NOT NULL DEFAULT 0,
  rua_rara_streak int NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
