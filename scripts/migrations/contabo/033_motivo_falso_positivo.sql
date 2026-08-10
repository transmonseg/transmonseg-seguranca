-- Infra para a feature "motivo do falso positivo" (ainda a construir nas
-- proximas tasks). So a coluna por enquanto: nullable, sem UI/backfill.
--
-- Valores: 'detector_errado' (o motor de deteccao errou) |
--          'dado_entrada_errado' (rota/janela/cadastro estava errado) | NULL.
ALTER TABLE alertas
  ADD COLUMN IF NOT EXISTS motivo_falso_positivo text
  CHECK (motivo_falso_positivo IN ('detector_errado', 'dado_entrada_errado'));

ALTER TABLE casos_desvio_revisao
  ADD COLUMN IF NOT EXISTS motivo_falso_positivo text
  CHECK (motivo_falso_positivo IN ('detector_errado', 'dado_entrada_errado'));
