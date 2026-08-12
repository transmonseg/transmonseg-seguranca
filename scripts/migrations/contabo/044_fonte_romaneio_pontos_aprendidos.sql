-- 044_fonte_romaneio_pontos_aprendidos.sql
--
-- Terceiro escritor em pontos_aprendidos: romaneio geocodificado (endereco
-- real), condicionado a entrega confirmada. Ver
-- docs/superpowers/specs/2026-08-12-correcao-pontos-via-romaneio-design.md.
--
-- IMPORTANTE: roda como superuser/dono da tabela (ex: `sudo -u postgres
-- psql -d transmonseg -f <arquivo>`), NAO com a DATABASE_URL normal da
-- aplicacao (role app_service) -- mesmo motivo documentado na migration 034
-- (ALTER TABLE DROP/ADD CONSTRAINT exige privilegio que app_service nao tem).

ALTER TABLE pontos_aprendidos DROP CONSTRAINT IF EXISTS pontos_aprendidos_fonte_check;
ALTER TABLE pontos_aprendidos ADD CONSTRAINT pontos_aprendidos_fonte_check
  CHECK (fonte IN ('aprendido', 'manual', 'romaneio'));

-- app_service ja tem INSERT/UPDATE em pontos_aprendidos desde a migration
-- 034 (GRANT explicito) -- nenhum GRANT novo necessario aqui.

-- aprender_pontos_entrega() (cron noturno, migration 034) so atualiza
-- linhas WHERE fonte = 'aprendido' -- uma linha fonte='romaneio' ja fica
-- automaticamente protegida, sem mudanca nessa funcao.

NOTIFY pgrst, 'reload schema';
