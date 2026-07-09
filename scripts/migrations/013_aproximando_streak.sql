-- 013: streak de aproximacao sustentada, pra resolver o desvio com a MESMA
-- regua usada pra disparar ("aproximar de qualquer destino cancela a
-- suspeita"), em vez de exigir distancia absoluta < 2500m (ver
-- docs/analise-deteccao.md secao 7.2 -- achado real TUL-1C38, aproximando
-- monotonicamente da base por 10 leituras mas alerta ficando ativo o
-- trajeto inteiro).
alter table posicoes_atuais add column if not exists aproximando_streak integer not null default 0;
