-- scripts/migrations/contabo/018_rumo_diverge_sombra.sql
--
-- Achado real 30/07 (Task 6, backtest dos 27 casos reais de rumo-diverge
-- de hoje): o veredito de sombra (contexto.retidao_rumo_sombra, Task 5)
-- e' calculado e travado UMA SO VEZ, no exato momento em que o streak
-- atinge 2 leituras (~60-90s) -- o unico caso confirmado manualmente
-- como desvio real (TTH-6G37) so revela seu padrao de reversao ~15min
-- DEPOIS dessa janela, e saiu como "suprimiria" no backtest junto com
-- quase todos os 26 falsos positivos. Ajustar o limiar nao resolve (todos
-- os 27 casos caem no mesmo intervalo estreito de razao dentro dessa
-- janela curta). Ver
-- docs/superpowers/specs/2026-07-30-filtro-comportamental-rumo-diverge-design.md.
--
-- Log de serie temporal (mesmo espirito NAO-DESTRUTIVO de cerca_sombra):
-- 1 linha por ciclo enquanto o episodio de divergencia estiver ativo,
-- independente do alerta ja existir ou do corredor ja ter confirmado
-- "fora" -- da visibilidade da evolucao COMPLETA do streak (nao so o
-- instante de criacao). Nunca interfere em nenhum alerta -- so log.
CREATE TABLE IF NOT EXISTS rumo_diverge_sombra (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  cliente_id uuid NOT NULL,
  criado_em timestamp with time zone NOT NULL DEFAULT now(),
  streak integer NOT NULL,
  caminho_m numeric NOT NULL,
  liquido_m numeric NOT NULL,
  razao numeric NULL,
  limiar numeric NOT NULL,
  dist_min_destino_m numeric NOT NULL,
  veredito_suprimiria boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS rumo_diverge_sombra_criado_idx ON rumo_diverge_sombra (criado_em);
CREATE INDEX IF NOT EXISTS rumo_diverge_sombra_veiculo_idx ON rumo_diverge_sombra (veiculo_id, criado_em);

NOTIFY pgrst, 'reload schema';
