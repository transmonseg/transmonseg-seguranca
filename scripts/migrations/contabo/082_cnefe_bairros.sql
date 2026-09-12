-- Task 4b (12/09): substitui a checagem de bairro das Tasks 4/5/7. Aquela
-- regra comparava a `localidade` do endereco CNEFE mais proximo contra o
-- bairro do romaneio. Achado que a invalida: `localidade` no CNEFE e' mais
-- fina que bairro -- inclui loteamento, conjunto, comunidade. A 16 metros de
-- distancia ha pontos com localidade "PARADA DE LUCAS" e "PARQUE JARDIM
-- BEIRA MAR", os dois dentro do MESMO bairro do IBGE. Rodando aquela regra
-- contra o cache real de geocode ela marcava 3.251 dos 8.744 enderecos (37%)
-- como nao confiaveis -- majoritariamente ruido de nomenclatura, nao erro de
-- geocodificacao.
--
-- A pergunta certa nao e' "esse ponto tem a localidade exata do bairro
-- pedido?", e sim "esse ponto esta perto de onde o bairro pedido realmente
-- fica?". Esta tabela agrupa todo endereco do CNEFE por (municipio,
-- localidade normalizada) e guarda o hull convexo dos pontos daquele grupo --
-- a "area" que aquele nome de bairro ocupa segundo o proprio Censo. A funcao
-- distancia_ao_bairro (migration 083) mede a distancia de uma coordenada ate
-- esse hull, e src/lib/territorio.ts compara contra um limiar calibrado (nao
-- contra igualdade de string).
--
-- localidade_norm usa a MESMA normalizacao de src/lib/territorio.ts
-- (normalizarBairro: acentos fora, maiusculo, espacos colapsados) pra que a
-- comparacao no banco seja por igualdade exata de string, nunca ILIKE.
--
-- Dado derivado: esta tabela nao tem fonte propria, e' inteiramente
-- recalculada a partir de cnefe_enderecos. Precisa ser reconstruida (rodar
-- esta migration de novo) sempre que o CNEFE for reingerido. DROP+CREATE de
-- proposito, pra ficar seguro re-rodar.
--
-- Live em producao 12/09: 7.678 grupos, 92 municipios, build em 35s.
DROP TABLE IF EXISTS cnefe_bairros;

CREATE TABLE cnefe_bairros AS
SELECT municipio_codigo,
       upper(translate(localidade,'ÁÀÂÃÉÊÍÓÔÕÚÇáàâãéêíóôõúç','AAAAEEIOOOUCAAAAEEIOOOUC')) AS localidade_norm,
       count(*) AS n_pontos,
       ST_ConvexHull(ST_Collect(ST_SetSRID(ST_MakePoint(lng,lat),4326))) AS hull
FROM cnefe_enderecos
WHERE localidade IS NOT NULL AND localidade <> ''
GROUP BY 1,2;

CREATE INDEX cnefe_bairros_hull_idx ON cnefe_bairros USING GIST (hull);
CREATE INDEX cnefe_bairros_nome_idx ON cnefe_bairros (localidade_norm);
