-- 086_posicoes_velocidade_na_parada_cobertura.sql
--
-- Correcao pos-revisao da migration 085 (mesmo dia): a funcao original so'
-- devolvia `tem_parada_com_velocidade`, o que colapsava dois casos que a
-- secao 3a da spec (docs/superpowers/specs/2026-09-12-confiabilidade-kpi-
-- nutrimax-design.md, repo KPI) EXIGE distinguir:
--   1. ZERO leituras pra aquela placa naquela janela/raio (fora de
--      cobertura do Unitrac/monitoramento naquele momento) -- a spec manda
--      FAIL-OPEN aqui ("nao inventar negativa por falta de dado"): o KPI
--      deve continuar confiando na parada do Unitrac como confirma hoje.
--   2. Leituras EXISTEM na janela/raio, mas todas com velocidade >5 --
--      contradicao real (o caminhao passou, nunca parou) -- o KPI deve
--      DESCARTAR a parada do Unitrac.
-- A versao anterior devolvia `false` pros dois casos -- o chamador nao
-- tinha como diferenciar "sem dado nosso" de "dado nosso contradiz".
--
-- `tem_cobertura` (existe >=1 linha casando placa+janela+raio, com
-- QUALQUER velocidade) resolve isso sem 2a query -- mesma agregacao SQL,
-- so' mais uma coluna (bool_or/count sobre o mesmo LEFT JOIN).
--
-- DROP + CREATE (nao CREATE OR REPLACE) porque o tipo de retorno mudou
-- (coluna nova em RETURNS TABLE) -- Postgres nao deixa trocar o shape de
-- saida de uma funcao existente com REPLACE, so' quando e' idêntico.
DROP FUNCTION IF EXISTS posicoes_velocidade_na_parada_lote(text[], float8[], float8[], float8[], timestamptz[], timestamptz[]);

CREATE FUNCTION posicoes_velocidade_na_parada_lote(
  p_placas text[],
  p_lats float8[],
  p_lngs float8[],
  p_raios float8[],
  p_inicios timestamptz[],
  p_fins timestamptz[]
)
RETURNS TABLE(idx int, tem_parada_com_velocidade boolean, tem_cobertura boolean)
LANGUAGE sql STABLE AS $$
  -- LEFT JOIN (nao INNER, nao EXISTS) e' o que permite calcular as duas
  -- colunas numa unica passada por linha de entrada: com INNER/EXISTS,
  -- "zero leituras casando" e "leituras casando mas todas rapidas" ficam
  -- indistinguiveis de novo (as duas dariam 0 linhas de saida do lado
  -- direito). Aqui toda placa/janela SEMPRE produz exatamente 1 linha de
  -- saida (GROUP BY q.ord, presente em unnest independente de match), e
  -- ph.* fica NULL quando nao ha leitura nenhuma -- e' esse NULL que
  -- diferencia count(ph.*)=0 (sem cobertura) de count(ph.*)>0 com
  -- bool_or(velocidade<=5)=false (cobertura existe, mas so' rapido).
  SELECT
    (q.ord - 1)::int AS idx,
    COALESCE(bool_or(ph.velocidade <= 5), false) AS tem_parada_com_velocidade,
    (count(ph.id) > 0) AS tem_cobertura
  FROM unnest(p_placas, p_lats, p_lngs, p_raios, p_inicios, p_fins)
       WITH ORDINALITY AS q(placa, lat, lng, raio, inicio, fim, ord)
  LEFT JOIN veiculos v ON v.placa = q.placa
  LEFT JOIN posicoes_historico ph
    ON ph.veiculo_id = v.id
   AND ph.criado_em BETWEEN q.inicio AND q.fim
   AND ST_DWithin(
         ST_SetSRID(ST_MakePoint(ph.lng, ph.lat), 4326)::geography,
         ST_SetSRID(ST_MakePoint(q.lng, q.lat), 4326)::geography,
         q.raio
       )
  GROUP BY q.ord;
$$;
NOTIFY pgrst, 'reload schema';
