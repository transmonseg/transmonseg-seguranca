-- Streak de ciclos consecutivos com divergencia de rumo acima do limiar
-- (ver detectarDesvio em src/lib/detectores.ts) -- mesmo padrao ja usado
-- por fora_tapete_streak/aproximando_streak.
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS divergencia_rumo_streak integer NOT NULL DEFAULT 0;
