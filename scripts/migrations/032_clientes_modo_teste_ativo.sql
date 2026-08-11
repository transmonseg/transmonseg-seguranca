-- 032_clientes_modo_teste_ativo.sql
-- Liga o "modo teste" (spec docs/superpowers/specs/2026-08-11-modo-teste-desvio-zero-design.md)
-- por cliente -- endereco do romaneio manda a posicao (nunca a Unitrac) e
-- motor de desvio novo rodam em paralelo, escondidos da producao,
-- so para clientes com este flag ligado.
ALTER TABLE clientes ADD COLUMN modo_teste_ativo boolean NOT NULL DEFAULT false;
