-- Fix 1 (Fase 2, 13/09): 083 media a distancia ao hull mais proximo entre os
-- 92 municipios que tem um bairro com aquele nome, ignorando o municipio que
-- o romaneio pediu -- DEFEITO CONHECIDO, deixado de proposito em 083 (ver
-- comentario la) ate a recalibracao acontecer junto (Fase 2 e' exatamente
-- isso). CENTRO existe em 92 municipios, BOA VISTA em 29 -- pra esses nomes
-- a checagem de bairro virava quase um no-op, porque sempre havia um hull
-- de mesmo nome perto o bastante em outro municipio.
--
-- Nova migration em vez de editar 083 no lugar: 083 muda o NUMERO de
-- argumentos (3 -> 4), entao CREATE OR REPLACE em cima do arquivo antigo nao
-- substitui a funcao existente pro Postgres (identidade de funcao inclui a
-- lista de tipos de argumento) -- cria uma segunda funcao sobrecarregada.
-- Deixar 083 registrando a funcao de 3 argumentos como historico do defeito
-- e criar esta com o comportamento corrigido deixa a trilha auditavel: dá pra
-- ler 083 e entender exatamente qual defeito existiu e por que foi deixado,
-- sem reescrever a migration original.
--
-- p_municipio (novo, opcional, default NULL; nome tem que bater exatamente
-- com a chave enviada pelo RPC do PostgREST em territorio-deps.ts, que chama
-- por parametro nomeado): quando informado, filtra
-- cnefe_bairros pelo municipio esperado ANTES de medir distancia -- so' o
-- hull de (municipio_codigo, localidade_norm) exato entra no min(). Quando
-- NULL (municipio esperado desconhecido -- ex. cidade truncada que
-- expandirCidadeTruncada nao resolveu), mantem o comportamento antigo de
-- buscar entre todos os municipios: FAIL-OPEN, igual ao resto da guarda
-- territorial -- sem dado de municipio confiavel, nao ha afirmacao mais
-- estrita possivel.
--
-- Threshold (LIMIAR_DISTANCIA_BAIRRO_M, src/lib/territorio.ts) foi
-- RECALIBRADO nesta mesma Fase 2 pra este comportamento -- ver comentario la
-- e o relatorio em
-- .superpowers/sdd/2026-09-12-fase1-territorial-triagem/fase2-fixes-report.md
-- (repo KPI). Distancias so' podem CRESCER com o filtro de municipio (o
-- min() agora e' sobre um subconjunto igual ou menor do que antes), entao o
-- limiar antigo (calibrado sem o filtro) subestimava quantos enderecos
-- seriam flagrados.
CREATE OR REPLACE FUNCTION distancia_ao_bairro(
  p_lat float8,
  p_lng float8,
  p_bairro text,
  p_municipio text DEFAULT NULL
)
RETURNS float8 LANGUAGE sql STABLE AS $$
  SELECT min(ST_Distance(b.hull::geography,
                         ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography))
  FROM cnefe_bairros b
  WHERE b.localidade_norm = p_bairro
    AND (p_municipio IS NULL OR b.municipio_codigo = p_municipio);
$$;
