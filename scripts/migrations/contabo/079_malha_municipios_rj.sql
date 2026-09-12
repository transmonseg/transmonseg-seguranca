-- Achado real 12/09 (auditoria do KPI Nutry Max do dia 11/09): 100 coordenadas
-- do cache estao em municipio diferente do que o romaneio pediu -- 22 foram
-- parar em Campos dos Goytacazes, 12 em Belford Roxo, 10 em Sao Goncalo.
-- Mediana do erro: 19,2 km.
--
-- A cascata ja filtra CNEFE por municipio_codigo desde 12/08, mas
-- escolherCandidatoMaisProximo aceita qualquer candidato a ate 30km do ponto
-- de referencia da cidade (DISTANCIA_MAX_MATCH_LOCAL_M) -- e 30km em volta do
-- centro do Rio contem Sao Goncalo, Belford Roxo, Duque de Caxias, Mage e Sao
-- Joao de Meriti INTEIROS. Google, Nominatim e o match OSM "local" nao tem
-- filtro de municipio nenhum, so' esse teto.
--
-- Polygon oficial resolve isso sem heuristica de distancia: ou o ponto esta
-- dentro do municipio pedido, ou nao esta. Fonte: malha municipal do IBGE
-- (servicodados.ibge.gov.br/api/v3/malhas/estados/33, qualidade intermediaria)
-- -- 92 features, 153 KB, cada uma com "codarea" igual ao codigo IBGE de 7
-- digitos ja usado em MUNICIPIO_CODIGO_IBGE (romaneio-geocode-local.ts) e em
-- cnefe_enderecos.municipio_codigo.
--
-- Tabela criada vazia de proposito: a carga e' feita por
-- scripts/carregar-malha-municipios.ts, que baixa do IBGE e e' idempotente.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS malha_municipios_rj (
  municipio_codigo text PRIMARY KEY,
  geom geometry(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS malha_municipios_rj_geom_idx
  ON malha_municipios_rj USING GIST (geom);
