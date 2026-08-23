-- 058_motor_romaneio_lease_e_retencao.sql
--
-- Infraestrutura de operação do motor paralelo do romaneio (migrations
-- 055/056/057), das lacunas achadas na revisão final de 22/08. Duas coisas:
-- a linha de lease que serializa os ciclos da rota, e as rotinas de
-- expiração/retenção de alertas_romaneio -- ambas coisas que a Central já
-- tinha pra `alertas` e que a tabela nova nunca herdou.
--
-- PRÉ-REQUISITO DE OPERAÇÃO: /api/motor-romaneio só consegue rodar depois
-- que esta migration existir no banco. A rota adquire o lease com
-- `update ... where id = 2 and expira_em < now()`; sem a linha id=2 o UPDATE
-- casa zero linhas e TODO ciclo termina em `{ pulado: true }`. Ou seja, a
-- ordem é: aplicar esta migration primeiro, reativar os jobs
-- 'motor-romaneio-1min' / 'motor-romaneio-tick-30s' depois. (A rota detecta
-- e reporta essa situação explicitamente -- ver o console.error dela --
-- justamente porque o sintoma sozinho é indistinguível de um ciclo lento.)

-- ─── 1. Linha PRÓPRIA de lease pro motor do romaneio ──────────────────────
-- src/app/api/motor-romaneio/route.ts passa a adquirir um lease com
-- expiração antes de rodar o ciclo, exatamente como /api/motor faz
-- (motor_lease, migration 016 / 001_schema_base.sql:276). Motivo, medido na
-- Central: sem trava, dois ciclos sobrepostos leem o mesmo snapshot de
-- alertas abertos, ambos inserem, e o estado vira last-write-wins -- até 34
-- alertas de desvio por dia pro MESMO veículo. O motor do romaneio tem
-- exatamente a mesma exposição: 2 jobs de pg_cron por minuto (um na hora
-- exata, outro com pg_sleep(30), ver 057) contra a mesma rota.
--
-- LINHA SEPARADA (id = 2), NÃO a id = 1: a id = 1 é da Central. Compartilhar
-- a linha faria um motor bloquear o outro -- os dois pipelines rodam de
-- propósito ao mesmo tempo pros mesmos carros (o produto da entrega é
-- comparar os dois no mesmo dia).
--
-- ON CONFLICT DO NOTHING: rodar esta migration de novo não pode ressetar um
-- lease em uso.
--
-- expira_em no passado (now() - 1s) pra que o PRIMEIRO ciclo depois desta
-- migration consiga adquirir o lease (a condição de aquisição é
-- `expira_em < now()`); o default da coluna é now(), que travaria o
-- primeiro disparo por um instante sem necessidade.
insert into motor_lease (id, expira_em, token, adquirido_em)
values (2, now() - interval '1 second', null, null)
on conflict (id) do nothing;

-- ─── 2. Retenção/expiração de alertas_romaneio ────────────────────────────
-- Mesmo par de rotinas que a Central tem pra `alertas`, estendido pra tabela
-- nova. Confirmado no banco em 22/08: NENHUM job cobria alertas_romaneio.
--
-- Por que virou urgente: depois do fix desta mesma revisão, o motor do
-- romaneio NUNCA fecha um alerta de desvio (TIPOS_NAO_GERENCIADOS, pedido
-- explícito do usuário após o churn de cerca virtual de 11/07) -- e todo
-- alerta desta tabela é tipo "desvio" hoje. Sem estas duas rotinas, um
-- alerta ativo de um veículo que amanhã não tiver romaneio nunca mais é
-- reprocessado: fica ativo pra sempre, ocupa a vaga de dedup e ABSORVE
-- silenciosamente os desvios novos do mesmo veículo.
--
-- 2a. Expirar todo 'ativo' de um DIA ANTERIOR -- cada dia começa com a lousa
--     limpa. Espelha 'expirar-alertas-ativos-esquecidos' (002_retencao.sql)
--     no mecanismo e no marcador contexto.auto_expirado (é como
--     contaComoRotuloHumano, src/lib/detectores.ts, distingue "o operador
--     nunca chegou a ver" de "operador julgou"), mas com janela
--     DELIBERADAMENTE muito mais curta que os 7 dias da Central.
--
--     Por que mais curta: como o motor nunca fecha desvio
--     (TIPOS_NAO_GERENCIADOS), uma linha 'ativo' ocupa a vaga de dedup do
--     veículo até alguém tratar na tela. Na Central isso é inofensivo
--     porque o operador trabalha a tela o dia todo (2207 "limpar" em 14
--     dias liberando vaga); mesmo assim ela acumula 238 desvios 'ativo' com
--     idade média de 4,3 dias, 184 deles com 2+ dias. Em /central-romaneio
--     NINGUÉM trabalha a tela -- ela é nova e a operação nem sabe dela.
--     Com 7 dias, o primeiro desvio de um veículo calaria o pipeline novo
--     pra aquele veículo pelos 6 dias seguintes, e a comparação entre os
--     dois motores (que é o produto desta entrega) leria isso como "o motor
--     do romaneio perdeu 3 desvios" quando ele foi calado pelo próprio
--     dedup. Um dia é exatamente a granularidade da comparação.
--
--     FUSO: o dia que importa é o de SÃO PAULO, não o do servidor (que roda
--     em CEST) nem o do pg_cron (cron.timezone = GMT neste banco). Por isso
--     `(coluna AT TIME ZONE 'America/Sao_Paulo')::date`, NUNCA current_date
--     -- current_date aqui viraria o dia até 5h antes do dia brasileiro e
--     expiraria, às 19h de São Paulo, alertas ainda do turno em andamento.
--     Horário 04:30 em GMT (cron.timezone) = 01:30 em São Paulo: já
--     seguramente no dia seguinte, com folga de 1h30 depois da virada, e
--     fora do minuto cheio onde os outros jobs de limpeza se concentram.
select cron.schedule(
  'expirar-alertas-romaneio-do-dia-anterior',
  '30 4 * * *',
  $$update alertas_romaneio set status = 'resolvido', resolvido_em = now(),
      contexto = coalesce(contexto, '{}'::jsonb) || '{"auto_expirado": true}'::jsonb
    where status = 'ativo'
      and (desde AT TIME ZONE 'America/Sao_Paulo')::date
          < (now() AT TIME ZONE 'America/Sao_Paulo')::date$$
);

--     LIMITAÇÃO CONHECIDA, deixada de propósito: este UPDATE só pega
--     status='ativo'. Desde o alinhamento com a Central, o dedup da rota lê
--     'ativo' E 'reconhecido' (motor/route.ts:1386), então uma linha
--     'reconhecido' ocuparia a vaga de dedup SEM nunca ser expirada aqui
--     nem apagada pelo DELETE de 30 dias abaixo -- travaria o veículo pra
--     sempre. Hoje é inalcançável: o botão de reconhecer não está ligado no
--     MonitorV2, e nada mais escreve esse status. A Central tem exatamente o
--     mesmo buraco ('expirar-alertas-ativos-esquecidos' também só olha
--     'ativo'), e mudar o comportamento aqui divergiria dela sem
--     necessidade. Fica registrado: NO DIA em que o botão de reconhecer for
--     ligado, este job e o DELETE abaixo precisam incluir 'reconhecido' --
--     nos dois pipelines.

-- 2b. Retenção de 30 dias dos já fechados -- espelha o DELETE que o motor
--     da Central roda em `alertas` (src/app/api/motor/route.ts, bloco de
--     limpeza diária). Aqui vira cron próprio porque o motor do romaneio
--     não tem (nem deve ganhar) um bloco de limpeza de fim de ciclo.
--     Mesmos 3 status da Central ('limpo' incluído: é o status do botão
--     "Limpar avisos", sem ele essas linhas nunca seriam apagadas).
select cron.schedule(
  'limpar-alertas-romaneio-antigos',
  '0 4 * * *',
  $$delete from alertas_romaneio
     where status in ('resolvido', 'falso_positivo', 'limpo')
       and coalesce(resolvido_em, desde) < now() - interval '30 days'$$
);
