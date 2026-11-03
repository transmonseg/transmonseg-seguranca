-- 093_romaneio_pontos_trocado_removida.sql
--
-- DSV-06 (auditoria 03/11/2026). PENDENTE DONO: nao aplicada.
--
-- Problema:
--   - desde a1bbe12 o reenvio do romaneio pulava QUALQUER NF da mesma carga ja
--     gravada em outra placa. Um reenvio CORRIGIDO (carga em outro carro, sem
--     passar por trocar-veiculo) nao movia a NF: o carro novo ficava sem
--     destino e o antigo vigiando entregas de outro;
--   - o upload so' acrescenta: NF retirada num reenvio continuava pendente o
--     dia todo (destino falso no desvio, mascarando).
--
-- O que cria (colunas nullable sem default = so' catalogo, instantaneo):
--   trocado_em   quando trocar-veiculo moveu a linha (o reenvio so' pula NF marcada);
--   trocado_de   placa de onde a linha saiu na 1a troca;
--   removida_em  NF ausente na versao nova da mesma carga (nunca DELETE).
--
-- ORDEM DE DEPLOY: aplicar ANTES do build do MON. Sem as colunas:
--   - upload e motor-romaneio seguem (caem na regra antiga, com aviso);
--   - trocar-veiculo FALHA (o UPDATE grava trocado_em) -> troca do KPI volta erro;
--   - /api/romaneio/contagem responde 500 (o KPI trata como desconhecido);
--   - rastreador_mudo_com_carga e sem_sinal_em_rota ficam desligados (aviso em erros).
-- Re-executavel (IF NOT EXISTS).
--
-- Linhas ja trocadas ANTES desta migration ficam com trocado_em nulo: um
-- reenvio do mesmo dia depois do deploy recriaria essas NFs na placa do
-- documento (o problema de 03/11). Por isso o deploy vai na janela da noite,
-- quando o dia operacional ja acabou.
--
-- COMO APLICAR (janela 21:30-23:45 BRT):
--   scp scripts/migrations/contabo/093_romaneio_pontos_trocado_removida.sql transmonseg-vps:/tmp/
--   ssh transmonseg-vps 'sudo -u postgres psql -d transmonseg -v ON_ERROR_STOP=1 -f /tmp/093_romaneio_pontos_trocado_removida.sql'
--
-- VERIFICACAO:
--   select column_name from information_schema.columns
--    where table_name = 'romaneio_pontos' and column_name in ('trocado_em','trocado_de','removida_em');  -- 3 linhas
--   GET do PostgREST: /rest/v1/romaneio_pontos?select=trocado_em,removida_em&limit=1   (200, nao 400)
--   depois da 1a troca do KPI: select nf, placa, trocado_de, trocado_em from romaneio_pontos
--     where trocado_em > now() - interval '1 day';
--   depois de um reenvio: resposta do upload traz nfsRetiradas / nfsDevolvidas.
--
-- ROLLBACK (deploy anterior a este nao le as colunas; com este no ar, o
-- upload/motor caem na regra antiga sozinhos, mas trocar-veiculo falha):
--   alter table romaneio_pontos drop column if exists removida_em,
--     drop column if exists trocado_de, drop column if exists trocado_em;
--   NOTIFY pgrst, 'reload schema';

alter table romaneio_pontos
  add column if not exists trocado_em timestamptz,
  add column if not exists trocado_de text,
  add column if not exists removida_em timestamptz;

comment on column romaneio_pontos.trocado_em is
  'DSV-06: quando trocar-veiculo moveu esta linha para o carro atual. O reenvio do romaneio so pula NF com trocado_em.';
comment on column romaneio_pontos.trocado_de is
  'DSV-06: placa de onde a linha saiu na primeira troca de veiculo.';
comment on column romaneio_pontos.removida_em is
  'DSV-06: NF ausente na versao nova da mesma carga (reenvio). Fica no banco; motor, contagem e cargas do dia ignoram.';

NOTIFY pgrst, 'reload schema';
