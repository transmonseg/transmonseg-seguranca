-- Contrafactual reproduzivel do fallback pro romaneio no detector de desvio
-- (commit 17a6f6c + correcao de sanidade de 22/09).
--
-- Uso: cole os 78 alerta_id (linhas do gabarito frenteA_casos.csv com
-- n_dest_cli=0, i.e. "afastando de todos" sem NENHUM cliente da Unitrac na
-- lista de destinos) no array `_ids` abaixo, ou gere via:
--   python3 -c "import csv; rows=list(csv.DictReader(open('frenteA_casos.csv')));
--   print(','.join(f\"'{r['alerta_id']}'::uuid\" for r in rows if r['n_dest_cli']=='0'))"
--
-- Roda: ssh transmonseg-vps "sudo -u postgres psql -d transmonseg" < este_arquivo
--
-- O que mede: pra cada alerta, a posicao do veiculo em ate 5min ANTES de
-- `desde` (mesma leitura que originou o disparo), os pontos do romaneio do
-- veiculo no dia (romaneio_data = desde::date, so nao-confirmados), e as
-- bases do cliente. Um ponto do romaneio e' PLAUSIVEL quando esta' a <=100km
-- da posicao OU de alguma base (mesmo criterio de
-- pontoRomaneioPlausivelParaDesvio em src/lib/desvio-destinos.ts).

with ids as (
  select unnest(array[
    -- cole aqui os alerta_id (uuid) do gabarito com n_dest_cli=0
  ]::uuid[]) as alerta_id
),
alerta as (
  select a.id as alerta_id, a.veiculo_id, a.desde, v.cliente_id
  from alertas a
  join veiculos v on v.id = a.veiculo_id
  join ids i on i.alerta_id = a.id
),
posicao as (
  select distinct on (al.alerta_id)
    al.alerta_id, al.veiculo_id, al.desde, al.cliente_id,
    ph.lat, ph.lng
  from alerta al
  join posicoes_historico ph
    on ph.veiculo_id = al.veiculo_id
   and ph.criado_em <= al.desde
   and ph.criado_em >= al.desde - interval '5 minutes'
  order by al.alerta_id, ph.criado_em desc
),
bases_cliente as (
  select cliente_id, array_agg(geom) as geoms
  from bases
  group by cliente_id
),
pontos_romaneio as (
  select
    p.alerta_id,
    rp.nf,
    rp.lat as rlat, rp.lng as rlng,
    ST_Distance(ST_SetSRID(ST_MakePoint(rp.lng, rp.lat), 4326)::geography,
                ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography) as dist_pos_m,
    (select min(ST_Distance(ST_SetSRID(ST_MakePoint(rp.lng, rp.lat), 4326)::geography, b))
       from unnest(coalesce(bc.geoms, array[]::geography[])) as b) as dist_base_m
  from posicao p
  join romaneio_pontos rp
    on rp.veiculo_id = p.veiculo_id
   and rp.romaneio_data = (p.desde at time zone 'America/Sao_Paulo')::date
   and rp.presenca_confirmada_em is null
   and rp.lat is not null and rp.lng is not null
  left join bases_cliente bc on bc.cliente_id = p.cliente_id
)
select
  count(distinct p.alerta_id) as alertas_com_posicao,
  count(distinct pr.alerta_id) as alertas_com_algum_ponto_romaneio,
  count(distinct pr.alerta_id) filter (
    where pr.dist_pos_m <= 100000 or pr.dist_base_m <= 100000
  ) as alertas_com_ponto_plausivel,
  count(distinct pr.alerta_id) filter (
    where not (pr.dist_pos_m <= 100000 or pr.dist_base_m <= 100000)
  ) as alertas_so_com_ponto_implausivel
from posicao p
left join pontos_romaneio pr on pr.alerta_id = p.alerta_id;
