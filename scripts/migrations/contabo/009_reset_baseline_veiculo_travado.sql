-- scripts/migrations/contabo/009_reset_baseline_veiculo_travado.sql
--
-- Achado real 28/07: dezenas de veiculos com baseline_veiculo travado
-- (variancia ~0, algumas linhas com 40k+ amostras presas) -- o fix em
-- baseline-veiculo.ts (piso/teto/circuit-breaker) corrige o mecanismo dai
-- pra frente, mas nao corrige linhas JA travadas (ficariam alertando por
-- dias/semanas ate reconvergir organicamente). Reset pra cold-start limpo
-- nas linhas com desvio abaixo do piso novo (BASELINE_DESVIO_MINIMO_KMH=3,
-- ou seja variancia<9) -- caem no fallback da frota ate acumular 20
-- amostras novas com o mecanismo ja corrigido.
--
-- Backup antes do reset: essas linhas sao o unico registro do estado
-- travado (achado real 28/07, ex: RQV-9B26 n=581/media=6/variancia=0.0068,
-- GVH-1397 n=40765) -- sem isso a evidencia se perde, e nao da pra conferir
-- depois se os veiculos resetados reconvergiram bem.
CREATE TABLE IF NOT EXISTS baseline_veiculo_bkp_20260728 AS
  SELECT * FROM baseline_veiculo WHERE feature = 'velocidade_media_kmh' AND variancia < 9;

CREATE TABLE IF NOT EXISTS baseline_frota_bkp_20260728 AS
  SELECT * FROM baseline_frota WHERE feature = 'velocidade_media_kmh' AND variancia < 9;

UPDATE baseline_veiculo
SET n_amostras = 0, media = 0, variancia = 0, excluida_desde = NULL
WHERE feature = 'velocidade_media_kmh' AND variancia < 9;

UPDATE baseline_frota
SET n_amostras = 0, media = 0, variancia = 0
WHERE feature = 'velocidade_media_kmh' AND variancia < 9;
