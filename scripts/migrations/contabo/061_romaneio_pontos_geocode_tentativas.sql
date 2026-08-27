-- 061_romaneio_pontos_geocode_tentativas.sql
--
-- Item 5 da blindagem de geocodificacao do romaneio (27/08).
--
-- O PROBLEMA REAL (confirmado no banco de producao hoje): a fase de
-- reprocessamento nao tem limite nenhum de tentativas. O detalhe e' que ela
-- NAO esta onde o plano supunha -- nao e' o status 'pendente' que fica
-- retentando pra sempre. Uma linha 'pendente' e' reivindicada, processada e
-- sai do estado no MESMO ciclo (vira 'ok' ou 'falhou'), e no banco hoje nao
-- existe nenhuma linha 'pendente' (49.138 'ok' + 397 'falhou', zero
-- 'pendente'). Quem retenta pra sempre e' o fallback Unitrac do final de
-- processar-geocode/route.ts:
--
--   select ... from romaneio_pontos where geocode_status = 'falhou'
--     and veiculo_id is not null limit 30
--
-- Isso roda a cada 30 segundos (pg_cron: 'romaneio-geocode' de minuto em
-- minuto + 'romaneio-geocode-tick-30s' com pg_sleep(30), ver migration
-- contabo/006), sobre TODOS os 'falhou' historicos, e uma linha so' sai de
-- 'falhou' se a Unitrac tiver um alvo com a mesma placa+NF. Pra romaneio de
-- semanas atras esse alvo nao volta mais a existir: as 397 linhas sao
-- consultadas e descartadas de novo, 2.880 vezes por dia, pra sempre.
--
-- Pior: sem ORDER BY, o `limit 30` pega sempre praticamente o mesmo punhado
-- de linhas velhas, entao uma falha NOVA (essa sim, com chance real de
-- resolver, porque o alvo da Unitrac ainda existe hoje) pode nunca chegar a
-- ser tentada -- o orcamento do ciclo esta ocupado por linhas mortas.
--
-- DUAS COLUNAS, nao uma. O contador sozinho nao resolve: com poucas linhas
-- na fila, todas sao tentadas a cada ciclo de 30s, e 10 tentativas se
-- esgotariam em 5 MINUTOS -- antes mesmo de a entrega do dia acontecer, que
-- e' justamente quando o alvo da Unitrac aparece. O carimbo de tempo da
-- ultima tentativa espaca as tentativas (30 min no codigo), entao as 10
-- tentativas cobrem ~5 horas, uma janela que abrange o dia de entrega.
-- Depois disso o codigo marca a linha como 'sem_coordenada_confirmada':
-- estado TERMINAL, sem coordenada inventada, so' para de tentar sozinho e
-- espera revisao manual.
--
-- N = 10 e' o teto do intervalo sugerido no plano (5-10). Escolhido o teto
-- porque o custo de tentar de novo e' baixo (a linha entra numa consulta
-- que ja acontece de qualquer jeito, sem chamada extra de API por linha) e
-- o custo de desistir cedo demais e' alto: e' uma entrega ficando sem
-- coordenada, e o produto e' deteccao de desvio de rota -- perder um ponto
-- real e' pior que gastar mais algumas consultas.
--
-- SEM CHECK em geocode_status de proposito: a coluna nunca teve CHECK
-- (confirmado em pg_constraint hoje -- so' existe o check de `origem`), e
-- criar um agora, numa migration cujo objetivo e' outro, arriscaria
-- rejeitar algum valor historico que nao conhecemos.
--
-- IMPORTANTE: roda como superuser/dono da tabela (ex: `sudo -u postgres
-- psql -d transmonseg -f <arquivo>`), NAO com a DATABASE_URL normal da
-- aplicacao (role app_service) -- romaneio_pontos e' owned by postgres e
-- ALTER TABLE exige ownership. Mesmo motivo ja documentado nas migrations
-- 034, 044 e 059.
--
-- O codigo de processar-geocode/route.ts funciona COM ou SEM esta migration
-- aplicada: se as colunas nao existirem, o PostgREST devolve erro e a rota
-- cai na consulta antiga (mesmo padrao de degradacao ja usado em
-- romaneio/status/route.ts pra coluna `origem`). Aplicar esta migration e'
-- o que liga o limite de tentativas.

ALTER TABLE romaneio_pontos
  ADD COLUMN IF NOT EXISTS geocode_tentativas integer NOT NULL DEFAULT 0;

-- NULL = nunca tentado desde que esta coluna existe. As 397 linhas
-- 'falhou' de hoje comecam com null e tentativas=0, ou seja, ganham as 10
-- tentativas espacadas a partir de agora -- nao sao descartadas de imediato
-- por causa do passado, que nao foi contado.
ALTER TABLE romaneio_pontos
  ADD COLUMN IF NOT EXISTS geocode_ultima_tentativa_em timestamptz;

-- A consulta do fallback passa a filtrar por (geocode_status, tentativas) e
-- ordenar por (tentativas, ultima_tentativa) -- o indice existente
-- romaneio_pontos_geocode_status_idx e' (geocode_status,
-- geocode_reivindicado_em), que nao serve pra essa ordenacao.
CREATE INDEX IF NOT EXISTS romaneio_pontos_geocode_retentativa_idx
  ON romaneio_pontos (geocode_status, geocode_tentativas, geocode_ultima_tentativa_em);

-- Coluna nova em tabela ja concedida: o GRANT de tabela cobre colunas
-- futuras, nenhum GRANT novo necessario pra app_service.

NOTIFY pgrst, 'reload schema';
