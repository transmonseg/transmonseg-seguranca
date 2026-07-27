-- scripts/migrations/contabo/004_observacoes_ia_desvio.sql
--
-- Pedido do usuario (27/07): rodar uma IA local (Ollama, llama3.2:3b, so
-- em 127.0.0.1 no proprio Contabo) OBSERVANDO os veiculos em rota e
-- anotando a opiniao dela sobre desvio -- sem influenciar NADA do sistema
-- real ainda ("modo sombra"). So depois de uma semana comparando a opiniao
-- dela com o que o cliente marcou como falso/resolvido de verdade e' que
-- se decide se ela ajuda pra valer. Tabela de log/observacao pura, sem
-- RLS (uso interno, mesmo padrao de posicoes_historico/casos_desvio_revisao).
CREATE TABLE observacoes_ia_desvio (
  id bigint generated always as identity primary key,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  placa text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  dist_min_m double precision NOT NULL,
  ciclos_piorando integer NOT NULL,
  opiniao_ia text NOT NULL,
  achou_desvio boolean,
  motor_apontou_desvio boolean NOT NULL,
  tempo_resposta_ms integer NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observacoes_ia_desvio_veiculo_tempo_idx ON observacoes_ia_desvio (veiculo_id, criado_em);
CREATE INDEX observacoes_ia_desvio_criado_em_idx ON observacoes_ia_desvio (criado_em);

-- Retencao de 30 dias -- e' pra analise de "a IA acertou ao longo do
-- tempo", precisa de mais historico que os 2/14 dias das outras tabelas
-- de observacao, mas ainda nao e' pra guardar pra sempre.
select cron.schedule(
  'limpar-observacoes-ia-desvio',
  '0 4 * * *',
  $$delete from observacoes_ia_desvio where criado_em < now() - interval '30 days'$$
);
