-- scripts/migrations/contabo/015_posicoes_atuais_parada_tolerante.sql
--
-- Achado real 28/07 (Task 5, Padrao B): parado_desde/paradoMin (route.ts)
-- zeram com QUALQUER leitura de velocidade!=0, mesmo um blip isolado de
-- poucos km/h. Caso real TTD-7H14 (~10.6min, 23 leituras): velocidade
-- oscilou 0,7,7,7,7,0,0,0,0,0,7,7,0,0,10,10,0,0,20,20,0,0,19 -- o veiculo
-- nunca acumulou os 2min continuos exigidos pro auto-resolve de
-- rua-estreita disparar, mesmo nunca tendo saido do lugar de verdade.
--
-- Coluna nova, so pro auto-resolve de rua-estreita -- NAO mexe em
-- parado_desde (primitivo compartilhado por muitos outros consumidores em
-- route.ts). Mesmo padrao ja em producao de no_raio_dwell_segundos
-- (acumula so quando devagar, sem resetar por causa de um blip isolado, so
-- zera numa saida de verdade) -- ver calcularParadaToleranteSegundos e
-- RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH em src/lib/detectores.ts.
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS parada_tolerante_segundos integer NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
