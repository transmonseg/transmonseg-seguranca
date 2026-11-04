-- 096_datagps_brasilia.sql
--
-- Frente H (RAS-02 / DSV-08, auditoria 03/11). PENDENTE DONO: nao aplicada.
--
-- parseDatagps (src/lib/datagps.ts) passou a ler a hora da Unitrac como
-- Brasilia (-03:00). Antes colava "Z": todo posicoes_atuais.datagps ficou
-- 3 h ATRAS. Esta migration soma as 3 h nas linhas que o motor novo ainda nao
-- reescreveu.
--
-- QUANDO: DEPOIS que o motor novo estiver no ar (1o ciclo ja rodado). NUNCA
-- antes: se o codigo velho voltar a gravar depois desta correcao, a guarda de
-- ordem (src/lib/posicoes-upsert.ts) recusa a leitura velha (menor) e a linha
-- congela ate 3 h.
--
-- Na pratica o proprio motor corrige toda linha que a Unitrac devolve no 1o
-- ciclo (leitura nova > valor antigo, a guarda deixa passar). Sobram as linhas
-- paradas (Benassi desde 06/10, carros que sairam da API). E' para elas.
--
-- Condicao (as duas juntas):
--   1. updated_at < corte: a linha nao foi reescrita pelo motor novo. Use o
--      MESMO valor de DATAGPS_CORRIGIDO_DESDE (src/lib/datagps.ts), que deve
--      ser um pouco ANTES do deploy. Sem isso, um carro com GPS de verdade
--      atrasado > 2 h ja gravado certo ganharia +3 h e a guarda de ordem
--      travaria as leituras dele.
--   2. datagps < updated_at - 2 h: valor antigo esta sempre >= 3 h atras da
--      gravacao. Exclui as linhas do antigo fallback "?? agora" (relogio real,
--      datagps ~ updated_at), que ja estao certas.
-- updated_at NAO muda (frescor usa ele). posicoes_historico nao tem datagps e
-- nao e' tocada (decisao do dono: sem migracao do historico).
--
-- COMO APLICAR (dono; janela 21:30-23:45 BRT):
--   scp scripts/migrations/contabo/096_datagps_brasilia.sql transmonseg-vps:/tmp/
--   psql "$DATABASE_URL" -v corte='2026-11-04T00:45:00Z' -f /tmp/096_datagps_brasilia.sql
--   (so' via psql: usa a variavel :corte. Sem -v corte o psql aborta antes de
--    mexer em qualquer linha; nao rodar por scripts/aplicar-migration.mjs.)
--
-- ROLLBACK (volta exatamente o datagps de antes):
--   update posicoes_atuais p set datagps = b.datagps
--     from posicoes_atuais_bak_datagps_0311 b where b.veiculo_id = p.veiculo_id;
--   (so' faz sentido junto com a volta do codigo antigo; depois de conferido,
--    drop table posicoes_atuais_bak_datagps_0311;)
--
-- ACEITE (linhas frescas, >= 99%):
--   select round(100.0 * avg((abs(extract(epoch from (datagps + make_interval(mins => atraso_min) - updated_at))) < 120)::int), 2) as pct_ok,
--          count(*) as linhas
--     from posicoes_atuais
--    where updated_at > now() - interval '10 minutes' and datagps is not null and atraso_min is not null;

\set ON_ERROR_STOP on

begin;

create table posicoes_atuais_bak_datagps_0311 as
  select veiculo_id, datagps from posicoes_atuais;

update posicoes_atuais
   set datagps = datagps + interval '3 hours'
 where datagps is not null
   and updated_at < :'corte'::timestamptz
   and datagps < updated_at - interval '2 hours';

commit;

-- OPCIONAL, decisao do dono (nao roda por padrao): eventos.ts tambem ficou 3 h
-- atras (mesmo parse; retencao de 7 dias; /api/eventos hoje nao tem tela).
-- Todo evento antigo tem ts <= corte - 3 h; evento novo so' cai ai se o GPS
-- vier com mais de 3 h de atraso (raro). Para aplicar, descomente:
--
-- begin;
-- create table eventos_bak_ts_0311 as select id, ts from eventos;
-- update eventos set ts = ts + interval '3 hours'
--  where ts < :'corte'::timestamptz - interval '3 hours';
-- commit;
-- rollback: update eventos e set ts = b.ts from eventos_bak_ts_0311 b where b.id = e.id;
