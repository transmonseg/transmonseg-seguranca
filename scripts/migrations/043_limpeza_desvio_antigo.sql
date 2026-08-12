-- 043_limpeza_desvio_antigo.sql
-- Remove tabelas/colunas do sistema de desvio ANTIGO, orfas apos o
-- redesign v2 (docs/superpowers/specs/2026-08-12-desvio-de-rota-v2-design.md).
-- cerca_sombra e rumo_diverge_sombra tambem removidas: nada mais escreve
-- nelas depois da remocao da cerca virtual/rumo_diverge (confirmado por
-- grep, zero uso restante em src/).
DROP TABLE IF EXISTS placar_desvio_log;
DROP TABLE IF EXISTS desvio_teste_estado;
DROP TABLE IF EXISTS corredor_celulas_veiculo;
DROP TABLE IF EXISTS cerca_sombra;
DROP TABLE IF EXISTS rumo_diverge_sombra;

ALTER TABLE posicoes_atuais
  DROP COLUMN IF EXISTS desvio_streak,
  DROP COLUMN IF EXISTS desvio_inicio,
  DROP COLUMN IF EXISTS fora_tapete_streak,
  DROP COLUMN IF EXISTS divergencia_rumo_streak,
  DROP COLUMN IF EXISTS divergencia_rumo_inicio,
  DROP COLUMN IF EXISTS divergencia_rumo_caminho_m,
  DROP COLUMN IF EXISTS aproximando_streak,
  DROP COLUMN IF EXISTS origem_celula,
  DROP COLUMN IF EXISTS ultima_via_principal_em,
  DROP COLUMN IF EXISTS saiu_parada_confirmada_em,
  DROP COLUMN IF EXISTS placar_desvio,
  DROP COLUMN IF EXISTS placar_desvio_estado;

-- Nota: corredor_celulas (SEM _veiculo) NAO e apagada -- alimenta
-- dentroTapete, usado por detectarParadaForaTapete, tipo de alerta
-- separado que fica intocado. no_raio_*/perto_sem_marcacao_* tambem NAO
-- sao apagadas -- alimentam detectarParadaSemMarcacao, outro tipo
-- separado.
