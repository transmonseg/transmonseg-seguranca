-- Aprendizado do local real de entrega por acumulo de visitas (usuario, 01/08).
--
-- Motivo: nem a coordenada da Unitrac (mediana 43m de erro, medido 01/08)
-- nem o endereco geocodificado do romaneio (mediana 152m) sao perfeitos.
-- Cada cliente e visitado varias vezes por semana -- se a gente acumular
-- ONDE O CAMINHAO REALMENTE PARA em cada ponto ao longo de semanas, o
-- centro desse agrupamento tende a ser mais preciso que uma unica leitura,
-- porque reflete comportamento fisico real, nao geocode nem cadastro.
--
-- SO COLETA por enquanto -- nao alimenta alerta nem suprime nada. Mesmo
-- padrao ja usado 3x hoje (sombra primeiro, validar com dado real antes de
-- decidir).

-- entregas_presenca ja registra "este veiculo ficou parado o bastante
-- perto deste ponto hoje" (ver migration 026). Falta a COORDENADA de cada
-- observacao (pra poder tirar a media depois) e o cliente_id (pra agrupar
-- por conta, ja que o mesmo ponto pode ser visitado por veiculos
-- diferentes -- confirmado em producao, ponto_codigo 633187 e 644113 ja
-- tem 2 veiculos cada).
ALTER TABLE entregas_presenca ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE entregas_presenca ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE entregas_presenca ADD COLUMN IF NOT EXISTS cliente_id uuid REFERENCES clientes(id);

CREATE INDEX IF NOT EXISTS entregas_presenca_cliente_ponto_idx
  ON entregas_presenca (cliente_id, ponto_codigo);

-- Centroide aprendido por (cliente_id, ponto_codigo). Recalculado do zero
-- toda noite (nao incremental, pra nunca arrastar erro antigo) a partir de
-- TODAS as observacoes acumuladas em entregas_presenca.
CREATE TABLE IF NOT EXISTS pontos_aprendidos (
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  ponto_codigo bigint NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  raio_m numeric NOT NULL,        -- maior distancia da mediana entre as observacoes usadas
  n_observacoes integer NOT NULL,
  primeira_observacao date NOT NULL,
  ultima_observacao date NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cliente_id, ponto_codigo)
);

GRANT SELECT, INSERT ON entregas_presenca TO app_service;
GRANT SELECT ON pontos_aprendidos TO app_service;

-- Funcao (nao SQL solto no cron.schedule): media das observacoes dentro de
-- 500m da MEDIANA do grupo -- filtra fora antes de agregar, protege contra
-- o caso raro de um veiculo casado com o ponto errado por engano puxar a
-- media pra longe. So publica/atualiza um ponto com >=5 observacoes
-- limpas (2+ semanas de visitas tipicas) -- com menos que isso, uma unica
-- parada anomala pesa demais.
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
  INSERT INTO pontos_aprendidos (cliente_id, ponto_codigo, lat, lng, raio_m, n_observacoes, primeira_observacao, ultima_observacao)
  SELECT cliente_id, ponto_codigo,
         avg(lat), avg(lng),
         GREATEST(max(dist_mediana_m), 30),
         count(*), min(dia), max(dia)
    FROM observacoes
   WHERE dist_mediana_m <= 500
   GROUP BY cliente_id, ponto_codigo
  HAVING count(*) >= 5
  ON CONFLICT (cliente_id, ponto_codigo) DO UPDATE SET
    lat = EXCLUDED.lat, lng = EXCLUDED.lng, raio_m = EXCLUDED.raio_m,
    n_observacoes = EXCLUDED.n_observacoes,
    primeira_observacao = EXCLUDED.primeira_observacao,
    ultima_observacao = EXCLUDED.ultima_observacao,
    atualizado_em = now();
$$;

SELECT cron.schedule('aprender-pontos-entrega', '20 4 * * *', 'SELECT aprender_pontos_entrega();');
