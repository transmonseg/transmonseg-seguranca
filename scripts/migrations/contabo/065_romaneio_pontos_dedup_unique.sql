-- 065_romaneio_pontos_dedup_unique.sql
--
-- Task "evitar duplicacao silenciosa no upload de romaneio" (27/08 -- ver
-- .superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/
-- task-upload-duplicacao-brief.md e -report.md): /api/romaneio/upload
-- (route.ts, admin.from("romaneio_pontos").insert(linhasParaInserir)) nunca
-- teve protecao contra reenvio do mesmo arquivo, e romaneio_pontos nunca
-- teve UNIQUE cobrindo a identidade natural de uma linha -- reenviar o
-- mesmo romaneio duplica silenciosamente. Confirmado com dado real
-- (READ-ONLY, producao) em 2026-08-29:
--
--   data          linhas excedentes (grupos com >1 linha na chave abaixo)
--   2026-07-31    1856
--   2026-08-10     789
--   2026-08-18    2291   <- bate exatamente com o achado original da varredura
--   2026-08-24     790
--   2026-08-26      22
--
-- CHAVE ESCOLHIDA: (romaneio_data, placa, nf, modo_teste, origem).
--
-- Por que cada coluna:
-- - romaneio_data + placa + nf: identidade natural obvia de "uma entrega
--   nesse romaneio". nf e' NOT NULL na tabela.
-- - modo_teste: PRECISA entrar na chave -- achado real ao investigar (grupo
--   2026-08-12, placa RBF-5G63, nf 2319627): duas linhas identicas em tudo
--   MENOS modo_teste, upadas pelo mesmo usuario com ~1h de diferenca (teste
--   seguido do upload real do mesmo romaneio). Sem modo_teste na chave, o
--   upload real teria sido rejeitado como "duplicata" do teste -- teria
--   perdido a entrega de verdade. Confirma a hipotese de partida do brief.
-- - origem: nunca observamos, em NENHUM dos 5748 grupos duplicados, dois
--   valores de origem diferentes pra mesma (data, placa, nf, modo_teste) --
--   romaneio x escala_pao sao fontes fisicamente diferentes (romaneio
--   principal x escala do Pao) e nunca reusaram o mesmo NF no dado real.
--   Ainda assim mantemos origem na chave por seguranca conceitual (a mesma
--   distincao ja e' tratada como dimensao de particionamento em
--   romaneio_pontos_data_modo_origem_idx, migration 059) -- custa nada e
--   evita que uma coincidencia futura de NF entre as duas fontes vire
--   rejeicao silenciosa de uma entrega legitima.
--
-- LIMITACAO CONHECIDA (documentada, aceita): origem e' NULLABLE (migration
-- 059 -- null = "origem desconhecida", ~41 mil linhas gravadas antes da
-- coluna existir). UNIQUE do Postgres trata NULL como distinto de outro
-- NULL, entao linhas antigas com origem NULL NAO ganham protecao contra
-- reenvio por esta constraint. Na pratica isso nao importa pra uploads
-- novos: normalizarOrigem() (romaneio-origem.ts) sempre grava 'romaneio' ou
-- 'escala_pao', nunca NULL, entao todo INSERT feito pelo endpoint a partir
-- de agora tem origem preenchida e cai sob a constraint normalmente.
-- Alternativa descartada: COALESCE(origem, '') num indice de expressao --
-- funcionaria pro UNIQUE, mas o upsert do PostgREST (Prefer:
-- resolution=ignore-duplicates + on_conflict=<colunas>) so' reconhece
-- constraint/indice sobre COLUNAS REAIS, nao expressao. Preferimos manter a
-- constraint compativel com o upsert do endpoint a "proteger" ~41 mil
-- linhas legadas que, pelo teste de grupos duplicados acima, nunca mais
-- vao ser reenviadas mesmo (sao de 2026-07 pra tras).
--
-- LIMITACAO CONHECIDA #2: nf sintetico do caminho generico/LLM
-- (`sem-nf:${crypto.randomUUID()}`, ver comentario em route.ts) e' unico A
-- CADA chamada -- reenviar o mesmo arquivo PDF/planilha nesse caminho gera
-- um nf novo pra cada linha em cada tentativa, entao a constraint NAO
-- pega duplicata nesse caso. Os casos reais de duplicacao investigados
-- (07-31, 08-10, 08-12, 08-18, 08-24, 08-26) sao todos do caminho regex
-- (Nutry Max, unico cliente em producao) onde nf e' o numero real da nota
-- fiscal, deterministico entre reenvios -- e' exatamente o caminho que esta
-- constraint protege.
--
-- LIMPEZA DE DUPLICATAS EXISTENTES (opcao "b" do brief -- fazer aqui em vez
-- de exigir limpeza manual antes): a ALTER TABLE ... ADD CONSTRAINT UNIQUE
-- abaixo falha se sobrar qualquer duplicata na chave. Antes dela, apagamos
-- as linhas excedentes de cada grupo duplicado, mantendo UMA por grupo.
--
-- Investigamos ANTES de decidir o criterio de "qual manter": nos 5748
-- grupos duplicados, endereco_bruto/cliente_nome/geocode_status sao SEMPRE
-- identicos dentro do grupo (achado: 0 grupos com valores divergentes --
-- confirma que sao reenvios do MESMO arquivo, nao fontes conflitantes).
-- Mas simplesmente manter "a linha mais recente por criado_em" e' ERRADO
-- aqui: 219 dos 5748 grupos tem presenca_confirmada_em preenchida em
-- SO' UMA das linhas duplicadas (a mais recente por criado_em nem sempre
-- e' essa), e 337 grupos tem lat/lng diferentes entre as duplicatas
-- (geocodificacao rodou em momentos diferentes pra cada copia). Apagar a
-- linha "errada" apagaria confirmacao de presenca ou geocodificacao real
-- ja feita -- dado operacional, nao lixo.
--
-- Por isso o desempate e' EM CAMADAS, na ordem que importa pro uso real do
-- sistema (presenca confirmada > geocodificado > mais recente):
--   1) presenca_confirmada_em preenchida (motorista/operador confirmou
--      essa entrega -- nunca jogar fora um fato operacional confirmado)
--   2) geocode_status = 'ok' (ja geocodificada -- preserva trabalho de
--      geocodificacao ja feito, evita reprocessar/perder lat-lng)
--   3) criado_em mais recente (desempate final, so' quando 1 e 2 empatam)
DELETE FROM romaneio_pontos WHERE ctid IN (
  SELECT ctid FROM (
    SELECT
      ctid,
      row_number() OVER (
        PARTITION BY romaneio_data, placa, nf, modo_teste, origem
        ORDER BY
          (presenca_confirmada_em IS NOT NULL) DESC,
          (geocode_status = 'ok') DESC,
          criado_em DESC
      ) AS rn
    FROM romaneio_pontos
  ) ranqueado
  WHERE ranqueado.rn > 1
);

-- IMPORTANTE: romaneio_pontos e' owned by postgres (mesma situacao das
-- migrations 034/044/059) -- rodar como superuser/dono da tabela (ex:
-- `sudo -u postgres psql -d transmonseg -f <arquivo>`), NAO com a
-- DATABASE_URL normal da aplicacao (role app_service).
ALTER TABLE romaneio_pontos
  ADD CONSTRAINT romaneio_pontos_data_placa_nf_modo_origem_key
  UNIQUE (romaneio_data, placa, nf, modo_teste, origem);

-- O endpoint (/api/romaneio/upload) passa a usar
-- .upsert(linhas, { onConflict: "romaneio_data,placa,nf,modo_teste,origem",
-- ignoreDuplicates: true }) -- essa constraint e' o que da suporte a esse
-- upsert (PostgREST exige um UNIQUE/PK real sobre as colunas do
-- on_conflict).

NOTIFY pgrst, 'reload schema';
