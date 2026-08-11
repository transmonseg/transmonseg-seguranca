-- 033_alertas_modo_teste.sql
-- Isola alertas gerados pelo motor de desvio do modo teste (mesmo padrao
-- de romaneio_pontos.modo_teste, migration 023): uma linha com
-- modo_teste=true nunca deve aparecer na consulta padrao de /api/alertas
-- nem disparar som/overlay de pancico pro operador.
ALTER TABLE alertas ADD COLUMN modo_teste boolean NOT NULL DEFAULT false;
