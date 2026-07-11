-- 017: rastreio de permanencia dentro do raio de um pendente, pro detector
-- de "bypass de entrega sem parar" (achado do audio do cliente Nutry Max,
-- 11/07/2026: desvio real e quando chega na porta do cliente e nao para).
alter table posicoes_atuais
  add column if not exists no_raio_alvo_codigo int,
  add column if not exists no_raio_desde timestamptz,
  add column if not exists no_raio_dwell_segundos int not null default 0;
