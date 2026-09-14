-- 085_posicoes_velocidade_na_parada_lote.sql
--
-- RPC exposta pra rota-ponte /api/romaneio/velocidade-na-parada
-- (src/app/api/romaneio/velocidade-na-parada/route.ts) -- Fase 2, item 3a
-- da spec docs/superpowers/specs/2026-09-12-confiabilidade-kpi-nutrimax-design.md
-- (repo KPI transmonseg). Ver comentario completo no topo daquele route.ts.
--
-- Recebe 6 arrays PARALELOS (uma consulta por posicao) e devolve, por
-- indice (0-based), se existe pelo menos 1 leitura em posicoes_historico
-- pra aquela placa, dentro da janela [inicio, fim] (inclusive nas duas
-- pontas), dentro do raio em metros do ponto, com velocidade <=5 km/h --
-- ou seja, "o caminhao ficou estacionario perto dali naquela janela",
-- segundo o NOSSO GPS (poller do monitoramento), independente da API de
-- paradas do Unitrac que o KPI usa hoje.
--
-- Set-based (1 UNICA query, unnest com WITH ORDINALITY) em vez de 1 chamada
-- por consulta -- achado real desta mesma spec: uma versao ingenua
-- 1-por-linha de checagem parecida (confirmar-presenca-romaneio.mjs) levou
-- 1h46 num caso de producao, contra 3,8s reescrita em lote sobre 8,7k
-- linhas. Ate 300 consultas por chamada (teto em MAX_CONSULTAS_POR_CHAMADA
-- no route.ts).
--
-- Retorna SO' as linhas com resultado true OU false calculavel -- na
-- pratica sempre as duas (EXISTS nunca e' NULL), mas so' pros idx que
-- vieram na entrada. O chamador trata ausencia de linha (nao deveria
-- acontecer, mas por seguranca) como false, nunca como erro -- zero
-- leitura pra placa/janela e' um "nao vimos o caminhao parado ali" LEGITIMO,
-- nao falta de dado (essa distincao fail-open/fail-closed e' decisao do
-- CHAMADOR, nao desta funcao -- ver contrato no topo do route.ts).
--
-- ST_DWithin sobre geography (mesmo padrao de distancia_ao_bairro,
-- migrations 083/084) -- metros reais, nao graus, sem precisar de formula
-- de haversine manual.
CREATE OR REPLACE FUNCTION posicoes_velocidade_na_parada_lote(
  p_placas text[],
  p_lats float8[],
  p_lngs float8[],
  p_raios float8[],
  p_inicios timestamptz[],
  p_fins timestamptz[]
)
RETURNS TABLE(idx int, tem_parada_com_velocidade boolean)
LANGUAGE sql STABLE AS $$
  SELECT
    (q.ord - 1)::int AS idx,
    EXISTS (
      SELECT 1
      FROM posicoes_historico ph
      JOIN veiculos v ON v.id = ph.veiculo_id
      WHERE v.placa = q.placa
        AND ph.criado_em BETWEEN q.inicio AND q.fim
        AND ph.velocidade <= 5
        AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(ph.lng, ph.lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(q.lng, q.lat), 4326)::geography,
          q.raio
        )
    ) AS tem_parada_com_velocidade
  FROM unnest(p_placas, p_lats, p_lngs, p_raios, p_inicios, p_fins)
       WITH ORDINALITY AS q(placa, lat, lng, raio, inicio, fim, ord);
$$;
NOTIFY pgrst, 'reload schema';
