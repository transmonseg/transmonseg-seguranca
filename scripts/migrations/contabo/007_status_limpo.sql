-- scripts/migrations/contabo/007_status_limpo.sql
--
-- Pedido do usuario (28/07): separar "so tirar da tela" (Limpar avisos) de
-- "revisei e confirmo" (Resolver todos) -- achado real 27-28/07: a maioria
-- dos alertas "resolvido" de um dia vinham de um clique so em massa, sem
-- revisao caso a caso, contaminando qualquer leitura de "quantos foram
-- confirmados de verdade" (e a calibracao, que aprende de casos_desvio_
-- revisao supondo veredito humano).
--
-- Novo status 'limpo': soma aos 4 existentes, nao substitui nenhum.
ALTER TABLE alertas DROP CONSTRAINT alertas_status_check;
ALTER TABLE alertas ADD CONSTRAINT alertas_status_check
  CHECK (status = ANY (ARRAY['ativo'::text, 'reconhecido'::text, 'resolvido'::text, 'falso_positivo'::text, 'limpo'::text]));

-- Indice de limpeza (geom/lat/lng/contexto apos resolvido) precisa cobrir o
-- status novo tambem, senao essas linhas nunca entram na varredura de
-- privacidade nem na retencao de 30 dias (ver route.ts, housekeeping sweep).
DROP INDEX IF EXISTS idx_alertas_cleanup;
CREATE INDEX idx_alertas_cleanup ON alertas (status, COALESCE(resolvido_em, created_at))
  WHERE status = ANY (ARRAY['resolvido'::text, 'falso_positivo'::text, 'limpo'::text]);

NOTIFY pgrst, 'reload schema';
