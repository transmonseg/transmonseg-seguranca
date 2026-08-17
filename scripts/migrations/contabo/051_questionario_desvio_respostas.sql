-- 051_questionario_desvio_respostas.sql
--
-- Mini formulario publico (sem login) pra Erica/Ana/Elloisy darem opiniao
-- sobre as regras atuais do detector de desvio v2 -- pedido direto do
-- usuario 17/08, pra calibrar as regras com quem opera no dia a dia, sem
-- depender so' de dado historico do banco. Uma LINHA por pergunta
-- respondida (nao uma linha por pessoa com JSON) -- pra dar pra agregar
-- ("quantos concordam com a pergunta 3") direto em SQL sem parsear nada.
CREATE TABLE IF NOT EXISTS questionario_desvio_respostas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  respondente text NOT NULL,
  pergunta_numero int NOT NULL,
  pergunta_texto text NOT NULL,
  resposta text NOT NULL,
  comentario text NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_questionario_desvio_respostas_pergunta ON questionario_desvio_respostas (pergunta_numero);
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON questionario_desvio_respostas TO app_service;
NOTIFY pgrst, 'reload schema';
