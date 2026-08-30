-- 049_desvio_estado_baseline_streak.sql
--
-- Suavizacao (streak) do detector `baseline_veiculo` -- ver
-- .superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/
-- task-baseline-flapping-report.md.
--
-- detectarAnomaliaBaseline compara a velocidade INSTANTANEA de um ciclo
-- (~30-45s de GPS) contra a media/variancia historica do veiculo. Sem
-- janela de persistencia, cada semaforo/curva/leitura ruim de GPS vira um
-- alerta proprio -- medido em 24-29/08: 100% dos alertas baseline_veiculo
-- dos ultimos 10 dias tem origem_acao IS NULL (nenhum foi tratado por
-- operador nenhum), e 54% (Nutry Max) / 33% (Benassi) das corridas de
-- anomalia duram UM unico ciclo.
--
-- Mesma tecnica ja validada pro desvio (afastando_streak/rua_rara_streak,
-- nesta mesma tabela): exige a condicao se repetir N ciclos consecutivos
-- antes de disparar. Reusa desvio_estado e o UPSERT que ja roda 1x por
-- veiculo por ciclo em motor/route.ts -- zero infraestrutura nova.
--
-- baseline_direcao separa "rapido demais" de "devagar demais": duas
-- leituras anomalas em direcoes OPOSTAS sao a assinatura de ruido, nao de
-- uma anomalia sustentada, entao NAO podem somar streak. NULL = sem streak
-- em curso (ou streak zerado neste ciclo).
ALTER TABLE desvio_estado ADD COLUMN IF NOT EXISTS baseline_streak int NOT NULL DEFAULT 0;
ALTER TABLE desvio_estado ADD COLUMN IF NOT EXISTS baseline_direcao text NULL;
ALTER TABLE desvio_estado DROP CONSTRAINT IF EXISTS desvio_estado_baseline_direcao_check;
ALTER TABLE desvio_estado ADD CONSTRAINT desvio_estado_baseline_direcao_check
  CHECK (baseline_direcao IS NULL OR baseline_direcao IN ('alta', 'baixa'));
NOTIFY pgrst, 'reload schema';
