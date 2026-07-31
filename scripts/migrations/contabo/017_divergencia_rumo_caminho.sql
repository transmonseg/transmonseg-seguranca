-- scripts/migrations/contabo/017_divergencia_rumo_caminho.sql
--
-- Achado real 30/07 (analise manual de 41 alertas ativos, apagao no RJ
-- impediu revisao de operador): 25 de 27 alertas rumo-diverge tinham
-- corredor real (OSRM) confirmando "fora" mas trajetoria quase reta
-- (razao caminho/deslocamento-liquido ~1.0-1.3) -- corredor sozinho nao
-- corrobora com confianca em rotas de 2.5-45km. Ver
-- docs/superpowers/specs/2026-07-30-filtro-comportamental-rumo-diverge-design.md.
--
-- Acumula a distancia percorrida durante a streak de divergencia de rumo
-- (mesmo ciclo de vida de divergencia_rumo_inicio: zera junto, so
-- acumula quando a streak avanca).
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS divergencia_rumo_caminho_m numeric NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
