-- 056_romaneio_desvio_estado_ultimo_datagps.sql
--
-- Achado real 22/08 (produção, primeiro deploy do motor-romaneio): o gate de
-- idempotência comparava posicoes_atuais.datagps (relógio da Unitrac) contra
-- romaneio_desvio_estado.atualizado_em (relógio do Postgres, now()).
-- parseDatagps (src/app/api/motor/route.ts) grava o horário local de Brasília
-- da Unitrac com sufixo "Z" (UTC) -- desloca datagps ~3h pro passado de forma
-- sistemática. Pra Central isso é inofensivo (ela usa atraso_min, nunca
-- compara datagps com now()); pro motor-romaneio era fatal: datagps
-- deslocado pro passado nunca supera um atualizado_em real, então depois do
-- primeiro ciclo TODO veículo era pulado pra sempre.
-- NÃO CORRIGIR parseDatagps -- é da Central, em produção, risco
-- desnecessário mudar o fuso do dado gravado. Fix é comparar relógio igual
-- dos dois lados: guarda o ÚLTIMO datagps já processado aqui, e a rota
-- compara datagps-contra-datagps (mesmo offset dos dois lados, o deslocamento
-- de fuso deixa de importar).
ALTER TABLE romaneio_desvio_estado ADD COLUMN IF NOT EXISTS ultimo_datagps timestamptz NULL;
NOTIFY pgrst, 'reload schema';
