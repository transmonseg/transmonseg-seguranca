CREATE TABLE IF NOT EXISTS escala_pontos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  veiculo_id uuid REFERENCES veiculos(id),
  placa text NOT NULL,
  escala_data date NOT NULL,
  carga_codigo text,
  destino_texto text NOT NULL,
  destino_normalizado text NOT NULL,
  lat double precision,
  lng double precision,
  raio_m integer,
  resolvido_via text CHECK (resolvido_via IN ('cidade', 'apelido', 'nao_resolvido')),
  entregas integer,
  nfs integer,
  criado_em timestamptz NOT NULL DEFAULT now(),
  enviado_por text
);
CREATE INDEX IF NOT EXISTS escala_pontos_veiculo_data_idx ON escala_pontos (veiculo_id, escala_data);
CREATE INDEX IF NOT EXISTS escala_pontos_data_idx ON escala_pontos (escala_data);

CREATE TABLE IF NOT EXISTS escala_apelidos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  apelido_texto text NOT NULL UNIQUE,
  cidade_destino text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON escala_pontos TO app_service;
GRANT SELECT ON escala_apelidos TO app_service;
