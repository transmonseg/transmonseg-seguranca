-- 034_desvio_teste_estado.sql
-- Estado persistido do motor de desvio do modo teste (score acumulado com
-- decaimento + distancia anterior por destino, usados por
-- src/lib/detectores-teste.ts::avaliarDesvioTeste). Tabela propria,
-- separada de posicoes_atuais (que guarda o estado de producao) --
-- mantem o modo teste inteiramente removivel sem tocar em schema de
-- producao.
CREATE TABLE desvio_teste_estado (
  veiculo_id uuid PRIMARY KEY,
  score numeric NOT NULL DEFAULT 0,
  distancias_anteriores jsonb NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
