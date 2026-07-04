-- ============================================================
-- Transmonseg Central — Migration 009: sessao do portal Unitrac
-- Guarda a sessao (PHPSESSID) do portal humano da Unitrac pra
-- reusar em comandos de sirene/bloqueio sem precisar logar toda
-- vez (login tem captcha, so um humano consegue fazer).
-- Tabela singleton (1 linha so, id sempre 1) — a sessao e
-- compartilhada pelo app inteiro, nao por usuario/cliente.
-- ============================================================

create table if not exists unitrac_sessao (
  id integer primary key default 1,
  cookie text not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  ok boolean not null default true,
  constraint unitrac_sessao_singleton check (id = 1)
);

-- Dados do rastreador por veiculo, necessarios pro form de comando
-- (unitrac_comandosirene_incluir). Nulos ate confirmarmos cada veiculo.
alter table veiculos add column if not exists unitrac_seriemodulo text;
alter table veiculos add column if not exists unitrac_protocolo text;
alter table veiculos add column if not exists unitrac_idprotocolo text;
