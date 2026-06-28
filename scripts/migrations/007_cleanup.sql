-- Migration 007: índice para limpeza eficiente de alertas antigos.
-- A limpeza roda no motor (1x/hora). Este índice torna o DELETE barato.

CREATE INDEX IF NOT EXISTS idx_alertas_cleanup
  ON alertas (status, COALESCE(resolvido_em, created_at))
  WHERE status IN ('resolvido', 'falso_positivo');
