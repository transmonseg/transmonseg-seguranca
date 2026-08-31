-- 069_romaneio_cliente_codigo_geocode_por_endereco.sql
--
-- Corrige o bug de ancora envenenada em romaneio_cliente_codigo_geocode.
--
-- Causa raiz (confirmada com dado de producao 31/08): a migration 052 criou
-- a tabela com PK (cliente_id, cliente_codigo), assumindo "1 codigo de
-- cliente = 1 lugar". O mundo real do romaneio nao e assim -- clientes de
-- refeicao coletiva/hospitalar usam UM codigo pra N unidades:
--
--   cliente_codigo 138748 SODEXO DO BRASIL      -> 25 enderecos distintos
--       (Resende, Barra Mansa, Cantagalo, Itaguai, Seropedica, Duque de
--        Caxias, varios bairros do Rio) -- todos lendo UMA ancora
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

-- O DEFAULT '' fica DE PROPOSITO (nao damos DROP DEFAULT). Janela de deploy:
-- entre aplicar esta migration e subir o codigo novo, a versao ANTIGA de
-- scripts/confirmar-presenca-romaneio.mjs (cron a cada poucos minutos)
-- ainda faz INSERT sem endereco_chave -- sem o default isso viraria erro de
-- NOT NULL e o cron quebraria. Com o default, ela grava numa linha de chave
-- '' que o codigo novo nunca le (o leitor sempre manda uma chave real), e
-- que o proximo ciclo do codigo novo simplesmente ignora. Linhas '' podem
-- ser limpas depois com:
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
