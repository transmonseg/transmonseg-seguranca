-- 052_romaneio_cliente_codigo_geocode.sql
--
-- Cache de geocode por (cliente_id, cliente_codigo) -- pedido direto do
-- usuario 18/08: "como melhorar a geocodificacao" sem poder ativar a
-- Geocoding API do Google (custa ~R$200 de deposito inicial). Achado real
-- (16/08): 4.764 de 9.386 codigos de cliente do romaneio ja se repetiram
-- em dias diferentes so' nos ultimos 14 dias -- metade do volume diario e'
-- entrega repetida pra um lugar ja resolvido antes.
--
-- Diferente de pontos_aprendidos (chave cliente_id+ponto_codigo, onde
-- ponto_codigo vem do alvo.pontocodigo da Unitrac -- so funciona pra
-- entregas que TEM alvo casado por placa+NF): esta tabela usa
-- cliente_codigo, o codigo que vem direto do proprio romaneio, entao
-- funciona mesmo pras placas/entregas sem cadastro correspondente na
-- Unitrac (ver achado de 9-11 placas do romaneio que nao existem no
-- cadastro, recorrente).
--
-- Politica write-once (nao last-write-wins): a primeira geocodificacao
-- bem-sucedida de um cliente_codigo vira a ancora permanente, reusada em
-- todo romaneio futuro com o mesmo codigo -- elimina a instabilidade de
-- 1-2 coordenadas distintas pro MESMO cliente que a analise de 16/08
-- achou (varia por causa de texto de endereco levemente diferente dia a
-- dia). Nao sobrescreve sozinha depois -- correcao futura (revisao manual
-- ou confirmacao por parada real, ainda nao implementada) e' o unico jeito
-- de mudar uma ancora ja gravada.
CREATE TABLE IF NOT EXISTS romaneio_cliente_codigo_geocode (
  cliente_id uuid NOT NULL,
  cliente_codigo text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  fonte text NOT NULL,
  n_observacoes int NOT NULL DEFAULT 1,
  primeira_observacao date NOT NULL,
  ultima_observacao date NOT NULL,
  PRIMARY KEY (cliente_id, cliente_codigo)
);
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON romaneio_cliente_codigo_geocode TO app_service;
NOTIFY pgrst, 'reload schema';
