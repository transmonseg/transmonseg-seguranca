-- 059_romaneio_pontos_origem.sql
--
-- Achado real 23/08: "Romaneio" e "Escala do Pao" sao, ate hoje, o MESMO
-- upload no banco. Os dois PainelUpload de /romaneio chamam o mesmo
-- /api/romaneio/upload com os mesmos campos e gravam em romaneio_pontos sem
-- nenhuma marca de origem -- a distincao existe so' no `titulo` do
-- componente, ou seja, so' na tela. Sem uma marca real e' impossivel
-- responder "a escala do Pao de hoje ja subiu?", que e' exatamente o que a
-- /central-romaneio precisa saber pra avisar (sem bloquear) quando ela
-- falta.
--
-- Valores: 'romaneio' | 'escala_pao'. A validacao de verdade e' no CHECK
-- abaixo + na allowlist do /api/romaneio/upload -- o cliente manda a origem
-- num campo de form, entao string arbitraria vinda de fora nunca pode
-- chegar ao banco.
--
-- NULLABLE SEM DEFAULT, de proposito. A alternativa (NOT NULL DEFAULT
-- 'romaneio') seria mais simples de consultar, mas afirmaria sobre as 41 mil
-- linhas antigas uma coisa que nao sabemos: parte delas E' escala do Pao,
-- so' que nao ficou registrado. Preferimos `null = origem desconhecida`
-- (honesto) e tratamos esse null no codigo: linha antiga entra no total do
-- dia, nunca e' contada como romaneio nem como escala.
--
-- IMPORTANTE: roda como superuser/dono da tabela (ex: `sudo -u postgres
-- psql -d transmonseg -f <arquivo>`), NAO com a DATABASE_URL normal da
-- aplicacao (role app_service) -- romaneio_pontos e' owned by postgres e
-- ALTER TABLE exige ownership. Mesmo motivo ja documentado nas migrations
-- 034 e 044.

ALTER TABLE romaneio_pontos ADD COLUMN IF NOT EXISTS origem text;

ALTER TABLE romaneio_pontos DROP CONSTRAINT IF EXISTS romaneio_pontos_origem_check;
ALTER TABLE romaneio_pontos ADD CONSTRAINT romaneio_pontos_origem_check
  CHECK (origem IS NULL OR origem IN ('romaneio', 'escala_pao'));

-- A /central-romaneio passa a consultar "tem ponto de romaneio de hoje?" e
-- "ja subiu escala do Pao hoje?" a cada carregamento da tela -- as duas
-- filtram por (romaneio_data, modo_teste) e a segunda por origem. Nenhum
-- indice existente serve: romaneio_pontos_veiculo_data_idx comeca por
-- veiculo_id, entao uma consulta so' por data varre a tabela inteira.
CREATE INDEX IF NOT EXISTS romaneio_pontos_data_modo_origem_idx
  ON romaneio_pontos (romaneio_data, modo_teste, origem);

-- Coluna nova em tabela ja concedida: o GRANT de tabela cobre colunas
-- futuras, nenhum GRANT novo necessario pra app_service.

NOTIFY pgrst, 'reload schema';
