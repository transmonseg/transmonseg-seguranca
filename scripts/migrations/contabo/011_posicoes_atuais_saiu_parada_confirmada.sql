-- scripts/migrations/contabo/011_posicoes_atuais_saiu_parada_confirmada.sql
--
-- Achado real 28/07: 36% dos falsos positivos manuais de rua-estreita eram
-- o veiculo saindo de uma parada de entrega legitima e entrando numa rua
-- estreita logo em seguida -- normal, mas a regra nao sabia. Nao existe
-- hoje nenhum sinal persistido de "saiu de parada confirmada ha quanto
-- tempo" (saiuDoRaioAgora e' um pulso de 1 ciclo, dwellSegundosAcumulados
-- zera no mesmo ciclo da saida) -- mesmo padrao ja usado por
-- ultima_via_principal_em (migration 026 no plano original; ver
-- JANELA_QUEDA_CLASSE_MIN em route.ts pro precedente exato).
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS saiu_parada_confirmada_em timestamptz NULL DEFAULT NULL;

NOTIFY pgrst, 'reload schema';
