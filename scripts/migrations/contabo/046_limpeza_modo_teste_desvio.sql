-- 046_limpeza_modo_teste_desvio.sql
--
-- Remove clientes.modo_teste_ativo (migration contabo 035) -- ficou orfa
-- apos o rewrite do detector de desvio v2 (12/08): a coluna so era
-- lida/escrita pela UI/API de "modo teste" (central-v2/modo-teste,
-- api/clientes/modo-teste, api/alvos-teste), que rodava um motor de
-- desvio PARALELO isolado (src/lib/detectores-teste.ts, ja apagado). Esse
-- motor paralelo nunca alimentava o motor principal -- a coluna nao e
-- mais lida por nenhum codigo depois da remocao da UI/API que a consumia.
--
-- Nao confundir com alertas.modo_teste (migration contabo 033-equivalente)
-- nem romaneio_pontos.modo_teste (migration contabo 023-equivalente) --
-- essas continuam ativas, usadas por outra feature ("romaneio modo
-- teste") sem relacao com esta.

ALTER TABLE clientes DROP COLUMN IF EXISTS modo_teste_ativo;

NOTIFY pgrst, 'reload schema';
