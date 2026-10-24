-- 087_cnefe_candidatos_indice_cobertura.sql
--
-- F2-01 (a) do plano mestre da Central (23/10). PENDENTE DONO: nao aplicada.
--
-- Problema medido (Postgres de producao, 18-23/10):
--   - pg_stat_statements: cnefe_candidatos_por_rua 995 chamadas, media 8,4 s,
--     maximo 59,8 s, 8.376 s de banco no total desde 18/10;
--   - 257 de 258 statement timeouts (57014, app_service com 60 s) no log do
--     Postgres sao dessa funcao, concentrados nos minutos :01-:05 e :31-:35;
--   - cada timeout vira "monitoramento respondeu 500" no tick da RQ e o
--     "Corredor da rua" some (16 de 22 ticks das :00/:30 em 22/10).
--
-- EXPLAIN (ANALYZE, BUFFERS) do corpo da funcao com os 181 nomes reais da RQ de
-- 23/10 (ruas das NFs revisar/pendente do kpi_ao_vivo_calculo, normalizadas
-- por normalizarNomeRua -- exatamente o que o corredor manda):
--   - Nested Loop -> Index Scan idx_cnefe_nome_numero, 181 loops, 421.099 linhas
--     lidas para 9.989 aglomerados;
--   - frio: 5,7 s, Buffers shared hit=230.062 read=123.030 (heap aleatorio);
--   - quente: 2,4 s, hit=351.616 read=1.476;
--   - nomes genericos pesam: "A" 31.524 linhas, "B" 27.567, "C" 21.053,
--     "BRASIL" 14.737, "DOIS" 14.546.
-- O custo esta' em buscar lat/lng/municipio no HEAP para cada linha. Prova:
-- a mesma juncao lendo so' colunas do indice (nome, numero) faz Index Only Scan
-- em 0,5 s, sem leitura de disco, mesmo com 92.378 heap fetches (22% das paginas
-- da tabela ainda nao estao marcadas como all-visible: relallvisible
-- 106.240 de 135.609).
--
-- Correcao (sem mudar o resultado da funcao nem a assinatura):
--   1. indice de COBERTURA (nome_normalizado) INCLUDE (municipio_codigo, lat,
--      lng): a funcao vira Index Only Scan -- as linhas do mesmo nome ficam
--      contiguas no indice, em vez de ~350 mil paginas de heap espalhadas;
--   2. VACUUM (ANALYZE) da tabela, para o mapa de visibilidade cobrir 100% e o
--      Index Only Scan nao voltar ao heap (o CNEFE e' estatico, fica assim).
-- Tamanho estimado do indice: ~8,8 M linhas x ~56 B = ~0,5 GB (disco: 112 GB
-- livres em 24/10). O idx_cnefe_nome_numero continua (usado pela busca por
-- numero do geocode).
--
-- COMO APLICAR (dono; janela 21:30-23:45 BRT, fora do horario de ticks pesados):
--   CREATE INDEX CONCURRENTLY e VACUUM NAO rodam dentro de transacao, entao
--   NAO usar scripts/aplicar-migration.mjs (manda o arquivo inteiro numa
--   query so'). Rodar como superuser, statement a statement:
--     scp scripts/migrations/contabo/087_cnefe_candidatos_indice_cobertura.sql transmonseg-vps:/tmp/
--     ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/087_cnefe_candidatos_indice_cobertura.sql'
--   Se o CONCURRENTLY falhar no meio, sobra um indice INVALID: dropar com
--   `drop index concurrently if exists idx_cnefe_nome_cobertura;` e rodar de novo.
--
-- VERIFICACAO depois de aplicar:
--   - no psql, EXPLAIN (ANALYZE, BUFFERS) do corpo da funcao com os nomes reais
--     deve mostrar "Index Only Scan using idx_cnefe_nome_cobertura" com
--     "Heap Fetches: 0" (ou perto) e Execution Time < 1 s;
--   - pg_stat_statements (resetar so' essa consulta ou comparar o delta do
--     dia): media < 1 s e maximo < 5 s;
--   - 0 linhas "canceling statement due to statement timeout" com CONTEXT
--     cnefe_candidatos_por_rua no postgresql-17-main.log;
--   - 0 "respondeu 500" da geocode-coerencia em /var/log/kpi-ao-vivo.log.
--
-- ROLLBACK: `drop index concurrently if exists idx_cnefe_nome_cobertura;`
-- (a funcao nao muda; o planner volta ao idx_cnefe_nome_numero).

set maintenance_work_mem = '1GB';

create index concurrently if not exists idx_cnefe_nome_cobertura
  on cnefe_enderecos (nome_normalizado)
  include (municipio_codigo, lat, lng);

vacuum (analyze) cnefe_enderecos;

-- Nao muda schema exposto, mas segue a regra do plano: toda migration recarrega
-- o cache do PostgREST.
NOTIFY pgrst, 'reload schema';
