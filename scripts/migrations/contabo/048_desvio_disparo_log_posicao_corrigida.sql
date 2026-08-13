-- 046_desvio_disparo_log_posicao_corrigida.sql
--
-- Achado real 13/08 (4 falsos positivos no mesmo dia com assinatura
-- identica -- delta de distancia uniforme entre destinos completamente
-- diferentes, causado por /table encaixando cada ponto independentemente
-- na malha viaria): ver docs/superpowers/specs/2026-08-13-osrm-match-desvio-design.md.
-- Esta coluna registra se um disparo especifico usou posicao corrigida
-- via /match (streak>0, correcao ativa e confiavel) ou bruta (streak==0,
-- ou /match falhou/confianca baixa) -- permite comparar os dois metodos
-- lado a lado com dado real depois do deploy.
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS posicao_corrigida boolean NOT NULL DEFAULT false;
NOTIFY pgrst, 'reload schema';
