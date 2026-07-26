-- scripts/migrations/029_casos_desvio_revisao.sql
--
-- Historico de casos de desvio marcados resolvido/falso_positivo, pra
-- analise posterior (ver docs/superpowers/specs/2026-07-26-fase2-historico-casos-e-regras-simples-design.md).
-- Achado real 26/07: acoes-alertas.ts ja apaga geom/lat/lng/contexto do
-- alerta original NO MESMO instante que marca o status (STRIP_PESADO) --
-- esta tabela precisa ser preenchida ANTES dessa limpeza rodar (ver
-- src/lib/casos-desvio-revisao.ts). Tabela de auditoria/debug interna, sem
-- RLS (nunca exposta a rota publica/client, mesmo padrao de
-- posicoes_historico).
CREATE TABLE casos_desvio_revisao (
  id bigint generated always as identity primary key,
  alerta_id uuid NOT NULL,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  status_final text NOT NULL,
  contexto_detector jsonb NOT NULL,
  trilha jsonb NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX casos_desvio_revisao_criado_em_idx ON casos_desvio_revisao (criado_em);

-- Limpeza automatica apos 2 dias (retencao curta e deliberada -- e' pra
-- analise de curto prazo, nao historico de longo prazo).
select cron.schedule(
  'limpar-casos-desvio-revisao',
  '0 4 * * *',
  $$delete from casos_desvio_revisao where criado_em < now() - interval '2 days'$$
);
