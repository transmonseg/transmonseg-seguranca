-- scripts/migrations/contabo/015_posicoes_atuais_parada_tolerante.sql
--
-- Achado real 28/07 (Task 5, Padrao B): parado_desde/paradoMin (route.ts)
-- zeram com QUALQUER leitura de velocidade!=0, mesmo um blip isolado de
-- poucos km/h. Caso real TTD-7H14 (~10.6min, 24 leituras): velocidade
-- oscilou 0,6,7,7,7,7,0,0,0,0,0,7,7,0,0,10,10,0,0,20,20,0,0,19 -- o veiculo
-- nunca acumulou os 2min continuos exigidos pro auto-resolve de
-- rua-estreita disparar, mesmo so 12 das 24 leituras sendo velocidade!=0
-- (blips, nao deslocamento de verdade -- so a leitura=0 conta tempo).
--
-- Coluna nova, so pro auto-resolve de rua-estreita -- NAO mexe em
-- parado_desde (primitivo compartilhado por muitos outros consumidores em
-- route.ts). So velocidade===0 de verdade soma tempo; velocidade ate
-- RUA_ESTRANHA_VELOCIDADE_TOLERANTE_KMH so evita resetar por causa de um
-- blip isolado, sem contar o blip como tempo parado (achado CRITICO da
-- revisao independente round 2: uma primeira versao somava tempo pra
-- qualquer leitura ate o limiar, contando dirigir devagar como parar) --
-- ver calcularParadaToleranteSegundos em src/lib/detectores.ts.
ALTER TABLE posicoes_atuais ADD COLUMN IF NOT EXISTS parada_tolerante_segundos integer NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
