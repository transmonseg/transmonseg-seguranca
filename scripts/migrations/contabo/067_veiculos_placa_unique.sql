-- 067_veiculos_placa_unique.sql
--
-- Achado da revisao independente da task "retry de geocode pra linhas
-- orfas" (29/08 -- ver task-geocode-orfaos-report.md): o re-match por placa
-- em processar-geocode/route.ts (e o mesmo padrao ja existente em
-- upload/route.ts:209-210) assume que `placa` identifica 1 unico veiculo,
-- mas o schema so tinha UNIQUE(cliente_id, cv) -- nada impedia duas linhas
-- com a mesma placa (globalmente unica no mundo real -- placa nao se
-- repete entre clientes/veiculos ativos).
--
-- Confirmado ANTES de aplicar: 0 placas duplicadas em producao hoje
-- (`select placa, count(*) from veiculos group by placa having count(*)>1`
-- -- 0 linhas). Nenhum caminho de codigo deste repo faz INSERT/UPDATE em
-- veiculos (populada por sync externo, fora deste repo) -- constraint nao
-- quebra nenhum fluxo de escrita existente.
ALTER TABLE veiculos ADD CONSTRAINT veiculos_placa_key UNIQUE (placa);
NOTIFY pgrst, 'reload schema';
