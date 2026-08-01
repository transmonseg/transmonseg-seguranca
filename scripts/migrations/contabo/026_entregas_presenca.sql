-- Parada no local do cliente conta como entregue (decisao do usuario, 01/08).
--
-- Problema que resolve: a Unitrac so marca a entrega como feita quando
-- alguem aponta no aparelho. Entrega real que ninguem apontou continua
-- "pendente" pro motor, entao o caminhao saindo dali parece estar se
-- AFASTANDO de um destino -- exatamente o sinal da regra principal de
-- desvio. Resultado: falso positivo em entrega legitima.
--
-- Solucao: se o veiculo ficou parado dentro do raio do ponto pelo tempo
-- minimo (ver ENTREGA_PRESENCA_MIN_SEG em route.ts), grava presenca aqui e
-- o ponto sai da lista de pendentes do dia.
--
-- Uma linha por (veiculo, ponto, dia) -- o dia isola o registro por
-- jornada, entao o mesmo cliente pode ser visitado de novo amanha.
CREATE TABLE IF NOT EXISTS entregas_presenca (
  veiculo_id uuid NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  ponto_codigo bigint NOT NULL,
  dia date NOT NULL,
  parado_seg integer NOT NULL,
  confirmado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (veiculo_id, ponto_codigo, dia)
);

CREATE INDEX IF NOT EXISTS entregas_presenca_dia_idx ON entregas_presenca (dia);

GRANT SELECT, INSERT ON entregas_presenca TO app_service;

-- Retencao: mesmo padrao das outras tabelas de apoio (019/025).
SELECT cron.schedule(
  'limpar-entregas-presenca',
  '10 4 * * *',
  $$DELETE FROM entregas_presenca WHERE dia < current_date - 30$$
);
