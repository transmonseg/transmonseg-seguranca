-- 015: log do MODO SOMBRA da cerca virtual de rota (Fase 1, 10/07).
-- A cerca roda em producao calculando corredor proativo por veiculo, mas
-- NAO gera alerta pro operador -- so registra aqui o que TERIA alertado.
-- Validacao com dado real de um dia inteiro de operacao antes de ligar
-- de verdade (backtest offline foi inconclusivo: rastro da Unitrac nao
-- tem timestamp, impossivel separar viagens fora do plano de entrega).
create table if not exists cerca_sombra (
  id uuid primary key default gen_random_uuid(),
  veiculo_id uuid not null,
  cliente_id uuid not null,
  criado_em timestamptz not null default now(),
  lat double precision not null,
  lng double precision not null,
  velocidade double precision not null,
  veredito text not null, -- 'fora' = teria alertado; 'recuperado' = saiu mas achou outra rota legitima
  pendentes int not null,
  buffer_m int not null
);
create index if not exists cerca_sombra_criado_idx on cerca_sombra (criado_em);
