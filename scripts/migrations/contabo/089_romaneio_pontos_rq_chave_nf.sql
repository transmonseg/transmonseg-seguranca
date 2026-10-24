-- 089_romaneio_pontos_rq_chave_nf.sql
--
-- F2-04 (KRQ-03, MON-10) do plano mestre da Central (23/10). PENDENTE DONO: nao aplicada.
--
-- O que faz:
--   1) coluna pedido_erp (D-21b): a planilha manual da RQ traz a NF real e o
--      "Numero Pedido ERP"; a Fusion grava o pedido como NF. O pedido guardado
--      liga as duas versoes do mesmo ponto (a volta da manual para a Fusion
--      casa pelo pedido e mantem a presenca).
--   2) apaga as copias da mesma NF da RQ no mesmo dia (NF reatribuida pela
--      Fusion a outro carro ficava em 2 placas, porque a chave antiga tem a
--      placa). Fica a linha MAIS NOVA (a atribuicao atual da Fusion); empate:
--      presenca confirmada, depois geocodificada.
--      Medido em 24/10 (so' leitura): 432 linhas, todas da RQ (cron-fusion):
--        14/10 131 (32 com presenca) | 15/10 148 (74) | 16/10 64 (23)
--        17/10   8 (7)               | 20/10  81 (18) | 21-23/10 0
--      A presenca apagada e' da copia do carro antigo (pendente fantasma).
--   3) indice unico (romaneio_data, nf, origem, modo_teste) SO' nas linhas da
--      RQ (gravadas pela ponte /api/romaneio/rioquality). Nao e' global: a
--      Nutry ja' teve a mesma NF em 2 placas num reenvio (10/10, 64 NFs,
--      "Claude" x "ericanutrymax") e o /upload da Nutry faz upsert na chave
--      com placa -- um indice global faria esse upsert falhar com erro.
--
-- O endpoint /api/romaneio/rioquality funciona antes e depois desta
-- migration: ele reconcilia pela NF no codigo (select + plano) e so' passa a
-- gravar/ler pedido_erp quando a coluna existe. O indice e' a rede contra
-- dois envios simultaneos.
--
-- COMO APLICAR (dono), como postgres (romaneio_pontos e' owned by postgres):
--   pg_dump do romaneio_pontos antes (rede de seguranca):
--     ssh transmonseg-vps 'sudo -u postgres pg_dump -d transmonseg -t romaneio_pontos -Fc -f /root/backups/romaneio_pontos-antes-089.dump'
--   scp scripts/migrations/contabo/089_romaneio_pontos_rq_chave_nf.sql transmonseg-vps:/tmp/
--   ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/089_romaneio_pontos_rq_chave_nf.sql'
--   Fora de 00:00-01:30 BRT. A parte 1 e' so' catalogo; a 2 apaga ~432 linhas
--   de dias passados; a 3 roda CONCURRENTLY (nao trava o cron de geocode).
--   NAO usar aplicar-migration.mjs (CONCURRENTLY nao roda em transacao).
--
-- VERIFICACAO:
--   select count(*) from (select 1 from romaneio_pontos
--     where enviado_por = 'cron-fusion (pelo Ao vivo do KPI)' or enviado_por like '%(Rio Quality pelo Ao vivo do KPI)'
--     group by romaneio_data, nf, origem, modo_teste having count(*) > 1) d;   -- 0
--   select indisvalid from pg_index where indexrelid = 'romaneio_pontos_rq_data_nf_key'::regclass;  -- t
--   GET do PostgREST: romaneio_pontos?select=pedido_erp&limit=1 (200, nao 400).
--   Se o indice ficar invalido (duplicata nova entre a parte 2 e a 3):
--   drop index concurrently romaneio_pontos_rq_data_nf_key; e rodar o arquivo de novo.
--
-- ROLLBACK: drop index concurrently if exists romaneio_pontos_rq_data_nf_key;
--           alter table romaneio_pontos drop column if exists pedido_erp;
--           (as linhas apagadas na parte 2 so' voltam pelo pg_dump).

BEGIN;

alter table romaneio_pontos add column if not exists pedido_erp text;
comment on column romaneio_pontos.pedido_erp is
  'Rio Quality: Numero Pedido ERP (chave interna da entrega; a Fusion grava o pedido como nf, a planilha manual a NF real). D-21b do plano 23/10.';

DELETE FROM romaneio_pontos WHERE ctid IN (
  SELECT ctid FROM (
    SELECT ctid, row_number() OVER (
      PARTITION BY romaneio_data, nf, origem, modo_teste
      ORDER BY criado_em DESC, (presenca_confirmada_em IS NOT NULL) DESC, (geocode_status = 'ok') DESC
    ) AS rn
    FROM romaneio_pontos
    WHERE enviado_por = 'cron-fusion (pelo Ao vivo do KPI)' OR enviado_por LIKE '%(Rio Quality pelo Ao vivo do KPI)'
  ) r
  WHERE r.rn > 1
);

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS romaneio_pontos_rq_data_nf_key
  ON romaneio_pontos (romaneio_data, nf, origem, modo_teste)
  WHERE enviado_por = 'cron-fusion (pelo Ao vivo do KPI)' OR enviado_por LIKE '%(Rio Quality pelo Ao vivo do KPI)';

NOTIFY pgrst, 'reload schema';
