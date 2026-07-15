-- 021_presenca_confirmada.sql
-- Presenca confirmada por permanencia -- ver
-- docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md
ALTER TABLE romaneio_pontos ADD COLUMN presenca_confirmada_em timestamptz;
