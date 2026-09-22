import csv, subprocess, os

# Gabarito committado no repo (scripts/gabarito/frenteA_casos.csv) -- achado
# real 22/09 (revisao adversarial rodada 2): a versao anterior lia de um
# scratchpad de sessao (/private/tmp/...), que some quando a sessao termina,
# tornando o script "reproduzivel" so' na mesma sessao que o gerou. 303
# alertas de desvio casados com veredito humano extraido do grupo WhatsApp
# "DESVIO DE ROTA" (18/08-21/09), ver metodologia no relatorio da task
# "Diagnóstico caso a caso dos falsos do grupo" (21/09).
GABARITO = os.path.join(os.path.dirname(__file__), 'gabarito', 'frenteA_casos.csv')
rows = list(csv.DictReader(open(GABARITO)))
sem_dest = {r['alerta_id']: r['veredito'] for r in rows if r['n_dest_cli'] == '0'}
ids_sql = ','.join(f"'{i}'::uuid" for i in sem_dest)

sql = f"""
with ids as (select unnest(array[{ids_sql}]::uuid[]) as alerta_id),
alerta as (
  select a.id as alerta_id, a.veiculo_id, a.desde, v.cliente_id
  from alertas a join veiculos v on v.id=a.veiculo_id join ids i on i.alerta_id=a.id
),
posicao as (
  select distinct on (al.alerta_id) al.alerta_id, al.veiculo_id, al.desde, al.cliente_id, ph.lat, ph.lng
  from alerta al join posicoes_historico ph on ph.veiculo_id=al.veiculo_id
    and ph.criado_em<=al.desde and ph.criado_em>=al.desde - interval '5 minutes'
  order by al.alerta_id, ph.criado_em desc
),
bases_cliente as (select cliente_id, array_agg(geom) as geoms from bases group by cliente_id),
pontos_romaneio as (
  select p.alerta_id,
    ST_Distance(ST_SetSRID(ST_MakePoint(rp.lng,rp.lat),4326)::geography, ST_SetSRID(ST_MakePoint(p.lng,p.lat),4326)::geography) as dist_pos_m,
    (select min(ST_Distance(ST_SetSRID(ST_MakePoint(rp.lng,rp.lat),4326)::geography, b)) from unnest(coalesce(bc.geoms,array[]::geography[])) as b) as dist_base_m
  from posicao p
  join romaneio_pontos rp on rp.veiculo_id=p.veiculo_id and rp.romaneio_data=(p.desde at time zone 'America/Sao_Paulo')::date
    and rp.presenca_confirmada_em is null and rp.lat is not null and rp.lng is not null
  left join bases_cliente bc on bc.cliente_id=p.cliente_id
)
select p.alerta_id,
  bool_or(pr.dist_pos_m<=100000 or pr.dist_base_m<=100000) as tem_plausivel
from posicao p left join pontos_romaneio pr on pr.alerta_id=p.alerta_id
group by p.alerta_id;
"""

out = subprocess.run(
    ['ssh', '-o', 'ConnectTimeout=10', 'transmonseg-vps', 'sudo -u postgres psql -d transmonseg -t -A -F,'],
    input=sql, capture_output=True, text=True, timeout=60,
)
lines = [l for l in out.stdout.splitlines() if l.strip()]
falso_evitado = correto_afetado = sem_romaneio = 0
for l in lines:
    parts = l.split(',')
    if len(parts) < 2:
        continue
    aid, plaus = parts[0], parts[1]
    v = sem_dest.get(aid)
    if plaus == 't':
        if v == 'falso':
            falso_evitado += 1
        elif v == 'correto':
            correto_afetado += 1
    else:
        sem_romaneio += 1

print('linhas retornadas:', len(lines))
print('falso evitado (tem ponto plausivel, veredito=falso):', falso_evitado)
print('correto afetado (tem ponto plausivel, veredito=correto):', correto_afetado)
print('sem ponto plausivel (continua sem_destinos):', sem_romaneio)
