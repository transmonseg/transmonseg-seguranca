-- 088_romaneio_pontos_presenca_metodo.sql
--
-- F2-10 (MON-07) do plano mestre da Central (23/10). PENDENTE DONO: nao aplicada.
--
-- scripts/confirmar-presenca-romaneio.mjs confirma presenca por dois caminhos:
--   - "dwell": parada real (>=120 s, <=5 km/h) a ate 500 m do proprio ponto;
--   - "vizinhanca": emprestada de outro ponto JA confirmado do mesmo romaneio
--     (veiculo+dia) a ate 800 m.
-- Hoje os dois gravam so' presenca_confirmada_em e nao da' para separar depois
-- (33.759 confirmacoes por vizinhanca acumuladas, parte delas com a vizinhanca
-- de ONTEM por causa do bug de fuso corrigido no mesmo item). O F4-02 precisa
-- recalcular as ancoras SEM as confirmacoes por vizinhanca.
--
-- O script ja' detecta a coluna (information_schema) e passa a grava-la assim
-- que ela existir; antes disso faz o UPDATE de sempre. Pode aplicar antes ou
-- depois do deploy do script, em qualquer ordem.
-- Linhas antigas ficam NULL (= metodo desconhecido; nao inventar).
-- A confirmacao feita pelo motor ao vivo (alvo Unitrac) tambem fica NULL.
--
-- COMO APLICAR (dono): coluna nullable sem default = so' catalogo, instantaneo.
--   ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/088_romaneio_pontos_presenca_metodo.sql'
--   (depois de scp do arquivo para /tmp/). Tambem roda por
--   `node --env-file=.env.production scripts/aplicar-migration.mjs contabo/088_romaneio_pontos_presenca_metodo.sql`.
--
-- VERIFICACAO:
--   select presenca_metodo, count(*) from romaneio_pontos
--    where presenca_confirmada_em > now() - interval '1 hour' group by 1;
--   (depois de 1 ciclo do cron: aparecem 'dwell' e/ou 'vizinhanca')
--   e um GET do PostgREST em romaneio_pontos?select=presenca_metodo&limit=1.
--
-- ROLLBACK: alter table romaneio_pontos drop column if exists presenca_metodo;
-- (o script volta sozinho ao UPDATE antigo no ciclo seguinte).

alter table romaneio_pontos
  add column if not exists presenca_metodo text
  check (presenca_metodo is null or presenca_metodo in ('dwell', 'vizinhanca'));

comment on column romaneio_pontos.presenca_metodo is
  'Como confirmar-presenca-romaneio confirmou: dwell (parada no proprio ponto) ou vizinhanca (emprestada de ponto confirmado do mesmo veiculo+dia). NULL = antigo ou confirmado por outro caminho.';

NOTIFY pgrst, 'reload schema';
