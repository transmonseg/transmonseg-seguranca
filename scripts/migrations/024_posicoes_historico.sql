-- 024_posicoes_historico.sql
-- Historico de posicao de veiculo -- ver
-- docs/superpowers/specs/2026-07-21-historico-posicao-veiculo-design.md.
-- Achado real 21/07: sem isso, bug relatado depois do fato (horas/dias) e
-- undebugavel com precisao -- so posicoes_atuais existe, e e sobrescrita a
-- cada ciclo. Tabela de auditoria/debug interna, sem RLS (nunca exposta a
-- rota publica/client, so consulta manual via script).
CREATE TABLE posicoes_historico (
  id bigint generated always as identity primary key,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  velocidade integer NOT NULL,
  ignicao boolean NOT NULL,
  atraso_min integer NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posicoes_historico_veiculo_tempo_idx ON posicoes_historico (veiculo_id, criado_em);
