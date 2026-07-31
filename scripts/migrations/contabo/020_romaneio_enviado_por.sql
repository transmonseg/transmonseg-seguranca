-- scripts/migrations/contabo/020_romaneio_enviado_por.sql
--
-- Achado real 31/07 (cliente Nutry Max): usuario quer que qualquer tela do
-- painel mostre se o romaneio de hoje ja foi processado, por quem e quando
-- -- hoje romaneio_pontos nao guarda quem fez o upload, so criado_em.
alter table romaneio_pontos add column enviado_por text;
