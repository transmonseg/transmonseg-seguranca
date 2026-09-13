-- Funcao exposta como RPC pro cliente Supabase da rota-ponte
-- (src/app/api/romaneio/geocode/territorio-deps.ts). Separada da migration
-- 082 (tabela cnefe_bairros) porque uma e' dado derivado caro de reconstruir
-- (35s) e a outra e' logica que pode mudar sem tocar no dado.
--
-- p_bairro chega JA NORMALIZADO pelo chamador (normalizarBairro em
-- src/lib/territorio.ts: acentos fora, maiusculo, espacos colapsados) --
-- a mesma normalizacao usada pra gravar localidade_norm em cnefe_bairros.
-- Por isso a comparacao aqui e' igualdade exata de string, nunca ILIKE.
--
-- Retorna NULL quando o bairro pedido nao existe em cnefe_bairros (942 dos
-- 8.725 enderecos em cache do KPI Nutry Max estao nesse caso) -- fail-open:
-- nao ha hull pra medir distancia, entao nao ha afirmacao possivel, e quem
-- decide o que fazer com essa ausencia e' validarTerritorio, nao esta funcao.
-- DEFEITO CONHECIDO, DEIXADO DE PROPOSITO (fix wave 12/09, Finding 4): esta
-- query filtra so' por localidade_norm, SEM filtro de municipio -- toma o
-- min() do hull mais proximo entre os 92 municipios que tem um bairro com
-- esse nome. "CENTRO" existe nos 92, entao pra nomes comuns a checagem de
-- bairro vira quase um no-op (qualquer CENTRO do estado inteiro conta).
-- Isso E' um defeito real. NAO CORRIGIR AGORA: o limiar de 1000m e o
-- resultado de 879 linhas (ver comentario/calibracao em src/lib/territorio.ts)
-- foram calibrados COM esse comportamento -- adicionar filtro de municipio
-- aqui muda a distancia medida pra todo endereco com bairro homonimo em
-- outro municipio, invalidando a calibracao em silencio. E' a primeira
-- tarefa da Fase 2 (com recalibracao junto). Se voce esta lendo isto
-- pensando em "corrigir" a falta do filtro: nao, sem recalibrar tambem.
CREATE OR REPLACE FUNCTION distancia_ao_bairro(p_lat float8, p_lng float8, p_bairro text)
RETURNS float8 LANGUAGE sql STABLE AS $$
  SELECT min(ST_Distance(b.hull::geography,
                         ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography))
  FROM cnefe_bairros b
  WHERE b.localidade_norm = p_bairro;
$$;
