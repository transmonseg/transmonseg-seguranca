-- scripts/migrations/contabo/034_fonte_pontos_aprendidos.sql
--
-- Correcao manual de posicao (usuario, 10/08) -- complementa
-- pontos_aprendidos (migration 028, automatico por acumulo de paradas
-- reais). Ver docs/superpowers/specs/2026-08-10-correcao-manual-pontos-design.md.
--
-- Motivacao: investigacao real com planilha oficial de clientes (Nutry
-- Max) + geocodificacao via Google Maps achou casos de posicao/nome
-- desatualizado que JA TEM pontocodigo na Unitrac -- nao precisam esperar
-- 5+ observacoes se acumularem, o endereco certo ja foi confirmado por
-- fonte externa confiavel.
--
-- IMPORTANTE: esta migration precisa rodar como superuser/dono da tabela
-- (ex: `sudo -u postgres psql -d transmonseg -f <arquivo>` no Contabo),
-- NAO com a DATABASE_URL normal da aplicacao (role app_service). O ALTER
-- TABLE e o CREATE FUNCTION abaixo exigem privilegio que app_service nao
-- tem (USAGE mas nao CREATE no schema public, e app_service nao e dono
-- da tabela) -- roda com app_service da erro "must be owner of table" /
-- "permission denied for schema public".

ALTER TABLE pontos_aprendidos
  ADD COLUMN IF NOT EXISTS fonte text NOT NULL DEFAULT 'aprendido'
  CHECK (fonte IN ('aprendido', 'manual'));

-- Defensivo: em producao, app_service ja tem todos os privilegios
-- (SELECT/INSERT/UPDATE/DELETE/...) nesta tabela via um ALTER DEFAULT
-- PRIVILEGES que o role postgres aplica a toda tabela nova -- isso e
-- externo as migrations versionadas neste repo, entao este GRANT
-- explicito e um no-op na producao atual. Mantemos o GRANT mesmo assim
-- porque e a defesa correta pra um ambiente novo/replicado do zero, onde
-- esse default privilege pode nao existir -- sem ele, o script de
-- gravacao manual (scripts/corrigir-pontos-manual.mjs), que roda com o
-- role app_service, falharia por falta de permissao.
GRANT INSERT, UPDATE ON pontos_aprendidos TO app_service;

-- Cron noturno (aprender_pontos_entrega) nunca mais toca numa linha
-- marcada manual -- so atualiza linhas 'aprendido', e so cria linha nova
-- se nao existir nenhuma pra aquele (cliente_id, ponto_codigo). Unica
-- mudanca real vs a versao original (migration 028): o WHERE no final do
-- ON CONFLICT DO UPDATE.
CREATE OR REPLACE FUNCTION aprender_pontos_entrega() RETURNS void
LANGUAGE sql AS $$
  WITH medianas AS (
    SELECT cliente_id, ponto_codigo,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY lat) AS mlat,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY lng) AS mlng
      FROM entregas_presenca
     WHERE cliente_id IS NOT NULL AND ponto_codigo IS NOT NULL
       AND lat IS NOT NULL AND lng IS NOT NULL
     GROUP BY cliente_id, ponto_codigo
  ),
  observacoes AS (
    SELECT o.cliente_id, o.ponto_codigo, o.lat, o.lng, o.dia,
           ST_Distance(
             ST_SetSRID(ST_MakePoint(o.lng, o.lat), 4326)::geography,
             ST_SetSRID(ST_MakePoint(m.mlng, m.mlat), 4326)::geography
           ) AS dist_mediana_m
      FROM entregas_presenca o
      JOIN medianas m USING (cliente_id, ponto_codigo)
     WHERE o.lat IS NOT NULL AND o.lng IS NOT NULL
  )
  INSERT INTO pontos_aprendidos (cliente_id, ponto_codigo, lat, lng, raio_m, n_observacoes, primeira_observacao, ultima_observacao, fonte)
  SELECT cliente_id, ponto_codigo,
         avg(lat), avg(lng),
         GREATEST(max(dist_mediana_m), 30),
         count(*), min(dia), max(dia), 'aprendido'
    FROM observacoes
   WHERE dist_mediana_m <= 500
   GROUP BY cliente_id, ponto_codigo
  HAVING count(*) >= 5
  ON CONFLICT (cliente_id, ponto_codigo) DO UPDATE SET
    lat = EXCLUDED.lat, lng = EXCLUDED.lng, raio_m = EXCLUDED.raio_m,
    n_observacoes = EXCLUDED.n_observacoes,
    primeira_observacao = EXCLUDED.primeira_observacao,
    ultima_observacao = EXCLUDED.ultima_observacao,
    atualizado_em = now()
  WHERE pontos_aprendidos.fonte = 'aprendido';
$$;
