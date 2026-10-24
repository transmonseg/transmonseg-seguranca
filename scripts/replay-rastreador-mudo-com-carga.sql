-- F3-09 (ACH-09, MON-08): replay SO' LEITURA do alerta rastreador_mudo_com_carga
-- (regra em src/lib/rastreador-mudo.ts) sobre posicoes_historico, com ticks de 15 min.
-- Uso (no servidor):
--   sudo -u postgres psql transmonseg -v ini=2026-10-20 -v fim=2026-10-23 -v hora=10 -v limiar=1440 \
--     -f scripts/replay-rastreador-mudo-com-carga.sql
-- Esperado em 20-23/10: so' LTZ-7I72 (20, 22, 23), RJM-5B51 (20, 22) e EEG-2F60 (23).
-- Aproximacoes: romaneio "presente" a partir do primeiro criado_em do veiculo no dia;
-- veiculo/cliente ativo pelo estado atual da tabela.
with dias as (
  select d::date as d from generate_series(:'ini'::date, :'fim'::date, interval '1 day') d
), ticks as (
  select dias.d, ((dias.d::timestamp + make_interval(mins => m)) at time zone 'America/Sao_Paulo') as t
    from dias, generate_series(0, 1425, 15) m
), carga as (
  select rp.romaneio_data as d, rp.veiculo_id, v.placa, c.nome as cliente, min(rp.criado_em) as rom_em, count(*) as nfs
    from romaneio_pontos rp
    join veiculos v on v.id = rp.veiculo_id and v.ativo
    join clientes c on c.id = v.cliente_id and c.ativo
   where rp.romaneio_data between :'ini'::date and :'fim'::date
     and rp.modo_teste = false
   group by 1, 2, 3, 4
), aval as (
  select tk.d, tk.t, cg.placa, cg.cliente, cg.nfs, h.atraso_min, h.criado_em
    from ticks tk
    join carga cg on cg.d = tk.d and cg.rom_em <= tk.t
    left join lateral (
      select ph.atraso_min, ph.criado_em from posicoes_historico ph
       where ph.veiculo_id = cg.veiculo_id and ph.criado_em <= tk.t
       order by ph.criado_em desc limit 1
    ) h on true
   where extract(hour from tk.t at time zone 'America/Sao_Paulo') >= :hora
)
select d, placa, cliente, nfs,
       to_char(min(t) at time zone 'America/Sao_Paulo', 'HH24:MI') as primeiro_tick_brt,
       bool_or(criado_em is null) as nunca_transmitiu,
       max(round(greatest(atraso_min, extract(epoch from t - criado_em) / 60.0))) as atraso_max
  from aval
 where criado_em is null
    or greatest(atraso_min::float8, extract(epoch from t - criado_em) / 60.0) >= :limiar
 group by 1, 2, 3, 4
 order by 1, 2;
