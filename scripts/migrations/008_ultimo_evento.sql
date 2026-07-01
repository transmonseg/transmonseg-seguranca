-- ============================================================
-- Transmonseg Central — Migration 008: linha do tempo de eventos nativos
-- Guarda o ultimo tipevnome conhecido por veiculo em posicoes_atuais
-- (usado pra detectar TRANSICAO sem reprocessar o ciclo anterior) e
-- passa a alimentar a tabela `eventos` (ja existia, nunca era usada).
-- ============================================================

alter table posicoes_atuais add column if not exists ultimo_evento text;
alter table posicoes_atuais add column if not exists ultimo_evento_em timestamptz;
