-- 055_motor_romaneio.sql
--
-- Pipeline de desvio paralelo alimentado pelo romaneio (spec
-- 2026-08-22-motor-romaneio-paralelo-design.md). Tabelas IRMAS das que a
-- Central usa (desvio_estado / alertas), sem FK entre elas: o motor novo
-- escreve so' aqui, e uma falha dele nao pode ter efeito nenhum na Central.
--
-- romaneio_desvio_estado espelha EXATAMENTE as colunas de desvio_estado
-- (041 + 050) -- mesmas regras, mesmo estado, so' outra fonte de ponto.
CREATE TABLE IF NOT EXISTS romaneio_desvio_estado (
  veiculo_id uuid PRIMARY KEY REFERENCES veiculos(id) ON DELETE CASCADE,
  afastando_streak int NOT NULL DEFAULT 0,
  rua_rara_streak int NOT NULL DEFAULT 0,
  ultima_via_principal_em timestamptz,
  saiu_parada_confirmada_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- alertas_romaneio: mesmas colunas relevantes de `alertas`, pra que a tela
-- nova possa reusar os mesmos componentes visuais sem adaptacao de shape.
CREATE TABLE IF NOT EXISTS alertas_romaneio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
  nivel text NOT NULL,
  tipo text NOT NULL,
  motivo text NOT NULL,
  score int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ativo',
  lat double precision,
  lng double precision,
  contexto jsonb NOT NULL DEFAULT '{}'::jsonb,
  desde timestamptz NOT NULL DEFAULT now(),
  resolvido_em timestamptz,
  operador_id uuid,
  origem_acao text,
  motivo_falso_positivo text
);

CREATE INDEX IF NOT EXISTS idx_alertas_romaneio_veiculo_status
  ON alertas_romaneio (veiculo_id, status);
CREATE INDEX IF NOT EXISTS idx_alertas_romaneio_desde
  ON alertas_romaneio (desde);

GRANT SELECT, INSERT, UPDATE ON romaneio_desvio_estado TO app_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON alertas_romaneio TO app_service;
NOTIFY pgrst, 'reload schema';
