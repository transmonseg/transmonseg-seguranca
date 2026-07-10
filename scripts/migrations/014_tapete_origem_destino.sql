-- 014: par origem-destino no tapete (SO COLETA, nenhuma deteccao usa ainda).
-- Pesquisa 09/07 (iBOAT): tapete correto e por par O-D, nao global por
-- cliente — comecar a acumular o dado agora pra poder religar a Camada 3
-- no formato certo depois. origem = celula da ultima parada de 5+ min do
-- veiculo; destino = celula do pendente mais proximo no momento.
alter table corredor_celulas add column if not exists origem_celula text;
alter table corredor_celulas add column if not exists destino_celula text;
alter table posicoes_atuais add column if not exists origem_celula text;
