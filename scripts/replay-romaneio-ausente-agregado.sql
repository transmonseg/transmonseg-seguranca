-- F3-07 (MON-04): replay SO' LEITURA do romaneio_ausente agregado
-- (regra em src/lib/romaneio-ausente.ts) sobre posicoes_historico.
-- Uso (no servidor):
--   sudo -u postgres psql transmonseg -v ini=2026-10-20 -v fim=2026-10-22 -v passo=5 -v dist=5000 -v frescor=60 \
--     -f scripts/replay-romaneio-ausente-agregado.sql
-- Regra por tick: carro de cliente ativo (Nutry 4096, RQ 598) com GPS fresco
-- (atraso < frescor), ignicao ligada (ou >= 10 km/h), a mais de `dist` m de
-- toda base do cliente e sem linha em romaneio_pontos do dia criada ate' o tick.
-- Card: 1 por cliente por dia; reabre (nao cria outro) se fechou sozinho e
-- voltou a ter carro em rota sem romaneio. "episodios" = quantos cards sairiam
-- se cada volta abrisse um card novo; "reaberturas_com_carencia" = quantas
-- vezes o card (o mesmo) aparece de novo com a carencia de 30 min para fechar.
-- O replay nao simula acao do operador: a reabertura do card fechado pelo
-- operador (R1 F3-07: carro ja' contado ainda em rota sem romaneio 60 min
-- depois do fechamento reabre o MESMO card) nao muda as contagens abaixo.
-- Conferencia de recall: todo carro que andou (>= 30 km/h) sem romaneio no
-- dia tem de estar na contagem do card; os que ficam fora saem na 2a consulta.
-- Aproximacoes: romaneio "presente" a partir do primeiro criado_em do veiculo
-- no dia (linhas substituidas depois tem criado_em novo: o carro conta como
-- sem romaneio por mais tempo -- erra para mais); cliente/base pelo estado atual.
\set ON_ERROR_STOP 1
create temp table rep_ticks as
select dias.d, ((dias.d::timestamp + make_interval(mins => m)) at time zone 'America/Sao_Paulo') as t
  from (select d::date as d from generate_series(:'ini'::date, :'fim'::date, interval '1 day') d) dias,
       generate_series(0, 1439, :passo) m;

create temp table rep_frota as
select v.id as veiculo_id, v.placa, c.id as cliente_id, c.nome as cliente
  from veiculos v join clientes c on c.id = v.cliente_id and c.ativo
 where c.cod_user_unitrac in ('4096', '598');

create temp table rep_rom as
select rp.romaneio_data as d, rp.veiculo_id, min(rp.criado_em) as rom_em
  from romaneio_pontos rp
 where rp.romaneio_data between :'ini'::date and :'fim'::date and rp.modo_teste = false and rp.veiculo_id is not null
 group by 1, 2;

create temp table rep_aval as
select tk.d, tk.t, f.cliente, f.cliente_id, f.veiculo_id, f.placa, h.lat, h.lng, h.ignicao, h.velocidade,
       (r.rom_em is not null and r.rom_em <= tk.t) as tem_romaneio,
       (h.criado_em is not null and greatest(h.atraso_min::float8, extract(epoch from tk.t - h.criado_em) / 60.0) < :frescor) as fresco,
       not exists (select 1 from bases b where b.cliente_id = f.cliente_id
                    and ST_DWithin(b.geom, ST_SetSRID(ST_MakePoint(h.lng, h.lat), 4326)::geography, :dist)) as longe_da_base
  from rep_ticks tk
  cross join rep_frota f
  left join rep_rom r on r.d = tk.d and r.veiculo_id = f.veiculo_id
  join lateral (
    select ph.lat, ph.lng, ph.ignicao, ph.velocidade, ph.atraso_min, ph.criado_em from posicoes_historico ph
     where ph.veiculo_id = f.veiculo_id and ph.criado_em <= tk.t and ph.criado_em > tk.t - interval '10 minutes'
     order by ph.criado_em desc limit 1
  ) h on true;

create temp table rep_em_rota as
select * from rep_aval
 where not tem_romaneio and fresco and longe_da_base and (ignicao or velocidade >= 10);

-- 1) Cards por cliente por dia.
with por_tick as (
  select tk.d, tk.t, cl.cliente, count(e.veiculo_id) as n
    from rep_ticks tk
    cross join (select distinct cliente from rep_frota) cl
    left join rep_em_rota e on e.t = tk.t and e.cliente = cl.cliente
   group by 1, 2, 3
), trans as (
  select *, (n > 0 and coalesce(lag(n) over (partition by d, cliente order by t), 0) = 0) as abre,
         max(case when n > 0 then t end) over (partition by d, cliente order by t rows between unbounded preceding and 1 preceding) as visto_antes
    from por_tick
)
select tr.d as dia, tr.cliente,
       case when sum(tr.n) > 0 then 1 else 0 end as cards,
       count(*) filter (where tr.abre) as episodios,
       count(*) filter (where tr.n > 0 and (tr.visto_antes is null or tr.t - tr.visto_antes > interval '30 minutes')) as reaberturas_com_carencia,
       (select count(distinct e.veiculo_id) from rep_em_rota e where e.d = tr.d and e.cliente = tr.cliente) as carros_no_card,
       max(tr.n) as pico_simultaneo,
       to_char(min(tr.t) filter (where tr.n > 0) at time zone 'America/Sao_Paulo', 'HH24:MI') as primeiro_brt,
       to_char(max(tr.t) filter (where tr.n > 0) at time zone 'America/Sao_Paulo', 'HH24:MI') as ultimo_brt
  from trans tr
 group by 1, 2
 order by 1, 2;

-- 2) Recall: carro que andou (>= 30 km/h, qualquer leitura do historico) sem
-- romaneio no dia e ficou fora do card. Esperado: so' carro que andou perto da base.
with andou as (
  select (ph.criado_em at time zone 'America/Sao_Paulo')::date as d, f.cliente, f.placa, f.veiculo_id,
         max(ph.velocidade) as vel_max
    from posicoes_historico ph
    join rep_frota f on f.veiculo_id = ph.veiculo_id
    left join rep_rom r on r.d = (ph.criado_em at time zone 'America/Sao_Paulo')::date and r.veiculo_id = ph.veiculo_id
   where ph.criado_em >= (:'ini'::date::timestamp at time zone 'America/Sao_Paulo')
     and ph.criado_em < ((:'fim'::date + 1)::timestamp at time zone 'America/Sao_Paulo')
     and ph.velocidade >= 30
     and (r.rom_em is null or ph.criado_em < r.rom_em)
   group by 1, 2, 3, 4
)
select a.d as dia, a.cliente,
       count(*) as andaram_sem_romaneio,
       count(*) filter (where exists (select 1 from rep_em_rota e where e.d = a.d and e.veiculo_id = a.veiculo_id)) as no_card,
       string_agg(a.placa, ', ' order by a.placa) filter (where not exists (select 1 from rep_em_rota e where e.d = a.d and e.veiculo_id = a.veiculo_id)) as fora_do_card
  from andou a
 group by 1, 2
 order by 1, 2;
