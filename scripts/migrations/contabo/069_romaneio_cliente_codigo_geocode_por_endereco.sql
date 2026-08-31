-- 069_romaneio_cliente_codigo_geocode_por_endereco.sql
--
-- Corrige o bug de ancora envenenada em romaneio_cliente_codigo_geocode.
--
-- Causa raiz (confirmada com dado de producao 31/08): a migration 052 criou
-- a tabela com PK (cliente_id, cliente_codigo), assumindo "1 codigo de
-- cliente = 1 lugar". O mundo real do romaneio nao e assim -- clientes de
-- refeicao coletiva/hospitalar usam UM codigo pra N unidades:
--
--   cliente_codigo 138748 SODEXO DO BRASIL      -> 22 enderecos distintos
--       agrupando so' por cliente_codigo (25 ao agrupar pelo par
--       cliente_id+cliente_codigo, que e' a granularidade real da PK --
--       ver revisao independente 31/08) -- Resende, Barra Mansa, Cantagalo,
--       Itaguai, Seropedica, Duque de Caxias, varios bairros do Rio -- todos
--       lendo UMA ancora
--   cliente_codigo 157337 GASTROSERVICE         -> 17 enderecos distintos
--   cliente_codigo 139450 NUTRIMED ALIMENTACAO  ->  9 hospitais distintos
--       (media dwell caiu em -22.912365,-42.775819, perto de Tangua/Rio
--        Bonito, ~60km de QUALQUER um dos 9 hospitais reais)
--   cliente_codigo 151949 NUTRIMED              ->  8 enderecos (Angra dos
--        Reis + Rio) -- media em -22.987162,-44.301680, n_observacoes=9
--
-- Duas consequencias, as duas reais:
--   (1) LEITURA (processar-geocode/route.ts): a primeira ancora gravada pro
--       codigo passa a ser servida pra TODOS os enderecos daquele codigo,
--       independente de onde a entrega e de verdade.
--   (2) ESCRITA (scripts/confirmar-presenca-romaneio.mjs, proximaEscritaCache
--       ramo "ja e dwell_confirmado"): cada parada real em endereco
--       DIFERENTE entra na mesma media ponderada, produzindo um centroide
--       que nao corresponde a nenhum endereco real.
--
-- Correcao: a granularidade certa e o ENDERECO, nao o cliente. A PK passa a
-- ser (cliente_id, cliente_codigo, endereco_chave), onde endereco_chave e o
-- endereco_bruto normalizado -- MESMA normalizacao de normalizarEndereco()
-- em src/lib/romaneio-geocode.ts (trim + upper + colapso de espacos), a que
-- ja e usada como chave de romaneio_geocode_cache.
--
-- Escala confirmada em producao (31/08):
--   12.266 pares (cliente_id, cliente_codigo) vistos em romaneio_pontos
--       78 (0,6%) com mais de um endereco distinto -> 902 pontos afetados
--    9.129 linhas na tabela de cache
--        9.062 (99,3%) de codigo com endereco UNICO  -> backfill seguro
--           67 (0,7%) de codigo com MULTIPLOS enderecos -> apagadas
--
-- Backfill e seguro nesta janela: romaneio_pontos comeca em 2026-07-31 e a
-- primeira linha de cache e de 2026-08-19 -- todo o historico que poderia
-- ter produzido uma ancora ainda esta em romaneio_pontos (nao ha purga de
-- romaneio_pontos). Verificado: 9.062 de 9.062 linhas de endereco unico tem
-- primeira_observacao >= min(romaneio_data) do proprio codigo.
--
-- As 67 linhas apagadas NAO sao perda de dado: sao cache. O proximo ciclo
-- de processar-geocode regeocodifica o endereco (agora chaveado certo) e o
-- proximo ciclo de confirmar-presenca regrava a ancora por dwell -- desta
-- vez uma por endereco. Nao ha reprocessamento retroativo de romaneio_pontos
-- ja gravados (fora de escopo, ver brief).

BEGIN;

-- Guarda de reexecucao (achado da revisao independente 31/08): o ADD COLUMN
-- e' idempotente, mas o DELETE de multi-endereco mais abaixo NAO e' --
-- rodar esta migration de novo DEPOIS dela ja ter sido aplicada apagaria as
-- ancoras legitimas por endereco que o fix passou a gravar (nao ha tabela
-- de controle de migrations neste projeto, aplicacao e' manual). Aborta
-- cedo se a PK ja tiver 3 colunas (endereco_chave ja faz parte dela).
DO $$
BEGIN
  IF (
    SELECT count(*) FROM information_schema.key_column_usage
    WHERE table_name = 'romaneio_cliente_codigo_geocode'
      AND constraint_name = 'romaneio_cliente_codigo_geocode_pkey'
  ) >= 3 THEN
    RAISE EXCEPTION 'migration 069 ja aplicada (PK ja tem endereco_chave) -- abortando pra nao reexecutar o DELETE de multi-endereco';
  END IF;
END $$;

ALTER TABLE romaneio_cliente_codigo_geocode
  ADD COLUMN IF NOT EXISTS endereco_chave text NOT NULL DEFAULT '';

-- Enderecos distintos por (cliente_id, cliente_codigo), normalizados igual
-- a normalizarEndereco() do TS. Diferenca teorica: \s do POSIX nao cobre
-- NBSP como o \s do JS -- se algum endereco tiver NBSP, a chave do backfill
-- nao bate com a que o app vai calcular e vira MISS de cache (recomputa),
-- nunca hit errado. Falha na direcao segura de proposito.
CREATE TEMP TABLE _enderecos_por_codigo ON COMMIT DROP AS
SELECT v.cliente_id,
       p.cliente_codigo,
       count(DISTINCT upper(btrim(regexp_replace(p.endereco_bruto, '\s+', ' ', 'g')))) AS n_enderecos,
       min(upper(btrim(regexp_replace(p.endereco_bruto, '\s+', ' ', 'g')))) AS endereco_unico
  FROM romaneio_pontos p
  JOIN veiculos v ON v.id = p.veiculo_id
 WHERE p.cliente_codigo IS NOT NULL
 GROUP BY 1, 2;

-- 1) Apaga as ancoras de codigo com multiplos enderecos (envenenadas ou,
--    na melhor das hipoteses, corretas pra apenas 1 dos N enderecos).
DELETE FROM romaneio_cliente_codigo_geocode g
 USING _enderecos_por_codigo e
 WHERE e.cliente_id = g.cliente_id
   AND e.cliente_codigo = g.cliente_codigo
   AND e.n_enderecos > 1;

-- 2) Backfill do endereco unico nas que sobraram.
UPDATE romaneio_cliente_codigo_geocode g
   SET endereco_chave = e.endereco_unico
  FROM _enderecos_por_codigo e
 WHERE e.cliente_id = g.cliente_id
   AND e.cliente_codigo = g.cliente_codigo
   AND e.n_enderecos = 1;

-- 3) Qualquer linha que tenha sobrado sem endereco resolvido (codigo sem
--    ponto correspondente em romaneio_pontos -- 0 casos hoje, mas a
--    migration nao pode assumir isso) vira lixo inalcancavel depois da
--    troca de PK: apaga em vez de deixar linha morta.
DELETE FROM romaneio_cliente_codigo_geocode WHERE endereco_chave = '';

ALTER TABLE romaneio_cliente_codigo_geocode
  DROP CONSTRAINT romaneio_cliente_codigo_geocode_pkey;
ALTER TABLE romaneio_cliente_codigo_geocode
  ADD CONSTRAINT romaneio_cliente_codigo_geocode_pkey
  PRIMARY KEY (cliente_id, cliente_codigo, endereco_chave);

-- O DEFAULT '' fica DE PROPOSITO (nao damos DROP DEFAULT) -- mas NAO evita
-- quebra na janela de deploy. Achado real na revisao independente (31/08),
-- comprovado em dry-run contra producao: o problema nunca foi NOT NULL, e'
-- o ALVO do ON CONFLICT. Depois desta migration trocar a PK pra
-- (cliente_id, cliente_codigo, endereco_chave), o INSERT ANTIGO (codigo
-- ainda rodando, com ON CONFLICT (cliente_id, cliente_codigo)) falha com
-- 42P10 "no unique or exclusion constraint matching the ON CONFLICT
-- specification" -- independente de DEFAULT. Confirmado rodando o INSERT
-- exato do codigo antigo apos a troca de PK, em transacao revertida.
--
-- Impacto medido por escritor:
--   confirmar-presenca-romaneio.mjs (crontab, poucos minutos): o erro
--     aborta a transacao (BEGIN/COMMIT do proprio script) e da' throw --
--     PARA a confirmacao de presenca inteira daquele ciclo, nao so' o
--     upsert do cache.
--   processar-geocode/route.ts (pg_cron ~30s): mesmo erro, mas via
--     supabase-js o retorno de erro do upsert e' ignorado pelo caminho de
--     chamada -- degrada em silencio (geocodifica normal, so' nao grava
--     ancora), sem interromper o resto do ciclo.
--
-- NAO HA ORDEM QUE EVITE ISSO POR COMPLETO: deployar o codigo novo ANTES da
-- migration tambem quebra (o ON CONFLICT de 3 colunas do codigo novo nao
-- acha a PK antiga de 2 colunas). Procedimento recomendado (deploy real):
--   1) comentar a linha do crontab de confirmar-presenca-romaneio.mjs
--   2) aplicar esta migration
--   3) deploy do codigo novo (processar-geocode/route.ts +
--      confirmar-presenca-romaneio.mjs)
--   4) reabilitar o crontab
-- Se preferir nao mexer no crontab, aplicar migration+deploy em sequencia
-- rapida e aceitar no maximo 1 rodada de confirmar-presenca falhando
-- (<=5min, sem corrupcao de dado -- e' tudo transacional).
--
-- O DEFAULT '' serve só pra escritas de OUTRAS colunas desta tabela que por
-- algum motivo nao passem por nenhum dos 2 caminhos acima nesta janela --
-- rede de seguranca residual, nao a mitigacao principal. Linhas '' (se
-- alguma aparecer) podem ser limpas com:
--   DELETE FROM romaneio_cliente_codigo_geocode WHERE endereco_chave = '';

-- Guarda: nenhuma linha pode sobrar sem endereco_chave.
DO $$
DECLARE vazias int;
BEGIN
  SELECT count(*) INTO vazias FROM romaneio_cliente_codigo_geocode WHERE endereco_chave = '';
  IF vazias > 0 THEN
    RAISE EXCEPTION 'migration 069: % linhas ficaram com endereco_chave vazio', vazias;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
