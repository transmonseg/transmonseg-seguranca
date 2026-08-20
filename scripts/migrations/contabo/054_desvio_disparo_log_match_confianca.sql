-- 054_desvio_disparo_log_match_confianca.sql
--
-- Achado real 19/08: posicao_corrigida (booleano existente) nao distingue
-- "gate do /match nao satisfeito" (streak zerado entrando no ciclo, sem
-- leitura anterior valida, ou teto MAX_CORRECOES_MATCH_POR_CICLO do ciclo
-- estourado) de "o /match rodou de verdade mas a confianca ficou abaixo do
-- piso" (quirk ja documentado 13/08, caso TTH-6G37 -- confianca degenera
-- pra ~0 em trajetos com muitos pontos parados/duplicados na janela de
-- 5min). Sem essa distincao, cada falso positivo com posicao_corrigida=false
-- exige reconstrucao manual (mesmo trabalho feito hoje pros casos
-- TUS-1A47/TOS-3C21/TOS-4J82/TUG-9D18) so' pra saber qual dos 2 motivos foi.
--
-- match_tentado: true so' quando /match de fato rodou e devolveu confidence
-- (com ou sem passar do piso de 0.5) -- false cobre os 3 motivos de gate
-- nao satisfeito de uma vez (nao tem como distinguir esses 3 sem mais
-- instrumentacao, decisao consciente de nao expandir mais agora).
-- match_confianca: valor bruto da confidence, gravado mesmo quando abaixo
-- do piso -- NULL quando match_tentado=false (nunca rodou).
ALTER TABLE desvio_disparo_log
  ADD COLUMN IF NOT EXISTS match_tentado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS match_confianca double precision;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON desvio_disparo_log TO app_service;
NOTIFY pgrst, 'reload schema';
