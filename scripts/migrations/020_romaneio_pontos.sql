-- 020_romaneio_pontos.sql
-- Romaneio diario (Nutry Max) como fonte dos pontos de entrega -- ver
-- docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

CREATE TABLE romaneio_pontos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  veiculo_id uuid REFERENCES veiculos(id),
  placa text NOT NULL,
  romaneio_data date NOT NULL,
  nf text NOT NULL,
  cliente_codigo text,
  cliente_nome text NOT NULL,
  endereco_bruto text NOT NULL,
  carga_destino_codigo text,
  carga_destino_nome text,
  lat double precision,
  lng double precision,
  geocode_status text NOT NULL DEFAULT 'pendente',
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX romaneio_pontos_veiculo_data_idx ON romaneio_pontos (veiculo_id, romaneio_data);

CREATE TABLE romaneio_geocode_cache (
  endereco_normalizado text PRIMARY KEY,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  fonte text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
