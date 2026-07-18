-- 023_romaneio_modo_teste.sql
-- Isola romaneio de teste (spec docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md):
-- uma linha com modo_teste=true nunca deve ser usada pelo motor pra detecção,
-- mesmo que use uma placa real (necessário pra testar o cruzamento com o
-- status real da Unitrac).
ALTER TABLE romaneio_pontos ADD COLUMN modo_teste boolean NOT NULL DEFAULT false;
