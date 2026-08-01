-- Rastro de QUAL botao o operador clicou (pedido do usuario, 01/08).
--
-- Problema: ate hoje, "Resolver" individual e "Resolver todos" (massa)
-- gravavam status='resolvido' identico, e os DOIS chamavam
-- registrarCasosDesvioRevisao. Nao havia como saber, olhando o dado, se um
-- 'resolvido' foi julgamento caso a caso ou clique pra desentupir a tela --
-- o que inviabiliza medir se a deteccao esta melhorando (e contamina a
-- calibracao, que le casos_desvio_revisao).
--
-- Valores: 'resolver_individual' | 'falso_individual' | 'resolver_massa'
--          | 'limpar_massa' | 'reconhecer' | NULL (historico anterior a
--          esta migration -- ver heuristica de timestamp identico pra
--          separar o passado).
ALTER TABLE alertas ADD COLUMN IF NOT EXISTS origem_acao text;
ALTER TABLE casos_desvio_revisao ADD COLUMN IF NOT EXISTS origem_acao text;

CREATE INDEX IF NOT EXISTS alertas_origem_acao_idx ON alertas (origem_acao) WHERE origem_acao IS NOT NULL;

-- Backfill do historico pela unica assinatura confiavel que existe: clique
-- em massa grava o MESMO resolvido_em (uma transacao) em varios alertas;
-- clique individual tem timestamp proprio. Marcado com sufixo _inferido
-- pra nunca ser confundido com registro de verdade.
UPDATE alertas a
   SET origem_acao = CASE
     WHEN a.status = 'falso_positivo' THEN 'falso_individual_inferido'
     WHEN a.status = 'limpo' THEN 'limpar_massa_inferido'
     WHEN a.status = 'resolvido' AND g.n = 1 THEN 'resolver_individual_inferido'
     WHEN a.status = 'resolvido' THEN 'resolver_massa_inferido'
   END
  FROM (
    SELECT id, count(*) OVER (PARTITION BY resolvido_em, operador_id) AS n
      FROM alertas
     WHERE resolvido_em IS NOT NULL
  ) g
 WHERE g.id = a.id AND a.origem_acao IS NULL AND a.resolvido_em IS NOT NULL;
