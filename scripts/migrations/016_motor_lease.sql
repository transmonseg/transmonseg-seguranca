-- 016: lease do motor com expiracao -- substitui pg_try_advisory_lock.
-- Achado real 10-11/07: advisory lock atraves do pooler Supavisor +
-- Vercel Fluid (funcao congelada mantem o socket vivo) deixava o lock
-- preso por tempo INDETERMINADO -- 64-88% dos ciclos pulados o dia todo,
-- stalls de 20+ minutos a noite, e muito provavelmente o apagao de ~20h
-- de 01-02/07 (mesma mecanica). O lease e um UPDATE atomico numa linha:
-- funciona em qualquer modo de pooling e se auto-cura em 90s no maximo
-- se o ciclo que segurava morrer (90s > maxDuration=60 da funcao, entao
-- nunca ha dois ciclos rodando de verdade ao mesmo tempo).
create table if not exists motor_lease (
  id int primary key,
  expira_em timestamptz not null default now(),
  token uuid,
  adquirido_em timestamptz
);
insert into motor_lease (id) values (1) on conflict (id) do nothing;
