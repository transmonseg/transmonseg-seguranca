-- 045_desvio_disparo_log.sql
--
-- Achado real 13/08 (casos TTH-3C94 e RQU-1G17, reportados no grupo
-- "DESVIO DE ROTA" como falso positivo): tentativa de reconstruir o
-- disparo via posicoes_historico + pendentes_snapshot_log nao reproduziu
-- o gatilho -- pendentes_snapshot_log e' throttled (amostragem periodica
-- via SNAPSHOT_PENDENTES_INTERVALO_MS), entao o conjunto exato de
-- destinos/distancias no ciclo real do disparo pode ja ter mudado antes
-- do proximo snapshot. E o alertas.contexto e' zerado por STRIP_PESADO
-- assim que o alerta e' resolvido/marcado falso positivo (mesmo problema
-- que ja tinha custado tempo no caso TTM-7C13).
--
-- Esta tabela grava, em TODO disparo do detector de desvio v2 (sinal A
-- ou B), um snapshot imutavel e completo do que decidiu o disparo:
-- destinos completos (pendentes+base+escala) com distancia atual e
-- anterior de cada um, streak, celula, n_visitas. Nunca e' tocada por
-- STRIP_PESADO (tabela separada de `alertas`) -- serve so pra diagnostico
-- futuro, nao alimenta nenhuma decisao do motor.
CREATE TABLE IF NOT EXISTS desvio_disparo_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  tipo_disparo text NOT NULL CHECK (tipo_disparo IN ('afastando_geral', 'rua_rara_frota')),
  destinos jsonb NOT NULL,
  streak_afastando integer NOT NULL,
  streak_rua_rara integer NOT NULL,
  celula text,
  n_visitas_celula integer,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_desvio_disparo_log_veiculo_tempo
  ON desvio_disparo_log (veiculo_id, criado_em DESC);

NOTIFY pgrst, 'reload schema';
