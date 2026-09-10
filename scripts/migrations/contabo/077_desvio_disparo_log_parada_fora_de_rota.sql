-- 077_desvio_disparo_log_parada_fora_de_rota.sql
--
-- Achado real 09/09 (grupo "DESVIO DE ROTA", casos RQU-9D10 e TOS-0F89:
-- "com desvio de rota na Unitrac mas nao acionou em nosso sistema"): os 2
-- veiculos ficaram parados (16min e 6min, respectivamente) num ponto que
-- nao e' cliente pendente nem base -- nem o sinal A (afastando de tudo)
-- nem o B (rua rara, ja desligado) cobrem esse caso, porque os 2 exigem o
-- veiculo em MOVIMENTO pra acumular streak (`paradoSemSeMover` suspende os
-- 2 sinais assim que o veiculo para, de proposito, pra evitar o bug
-- documentado de 13/08 de "lista de pendentes mudando sob o veiculo
-- parado"). Um veiculo que dirige ate um lugar aleatorio e so' FICA la'
-- nunca aciona nenhum dos 2 sinais existentes.
--
-- Simulacao contra o dia de hoje (09/09, frota Nutry Max inteira, limiar de
-- 10min parado a >=500m de qualquer endereco de cliente conhecido e
-- >=1200m de qualquer base): 206 episodios/dia. Alto demais pra virar
-- alerta 'critico' direto -- repetiria o erro ja' vivido com "rua rara"
-- (sinal desligado em 13/08 por volume de falso positivo). Provavelmente
-- inclui parada pra almoco, descanso do motorista, posto de combustivel
-- nao catalogado, espera de doca -- nao da pra distinguir de desvio real
-- so' com "parado + longe de tudo".
--
-- Por isso, por ora, so' INSTRUMENTACAO (sem alerta): grava no
-- desvio_disparo_log toda vez que a condicao acontece, pra acumular dado
-- real e calibrar um limiar de verdade depois (mesmo metodo ja' usado pra
-- validar afastando_streak e baseline_streak -- ver
-- scripts/simular-dia-desvio-v2.mjs e scripts/comparar-streaks-baseline.mjs
-- pro precedente). NUNCA cria linha em `alertas`.
ALTER TABLE desvio_disparo_log ADD COLUMN IF NOT EXISTS parado_min int NULL;
ALTER TABLE desvio_disparo_log DROP CONSTRAINT IF EXISTS desvio_disparo_log_tipo_disparo_check;
ALTER TABLE desvio_disparo_log ADD CONSTRAINT desvio_disparo_log_tipo_disparo_check
  CHECK (tipo_disparo = ANY (ARRAY[
    'afastando_geral'::text,
    'rua_rara_frota'::text,
    'suprimido_salto_reconciliacao'::text,
    'suprimido_retorno_base'::text,
    'suprimido_saida_base'::text,
    'parada_fora_de_rota_instrumentacao'::text
  ]));
NOTIFY pgrst, 'reload schema';
