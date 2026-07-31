-- scripts/migrations/contabo/021_vias_nomes_sem_conectores.sql
--
-- Achado real 31/07 (sem Google Geocoding -- usuario decidiu nao pagar/nao
-- vincular faturamento, ver conversa da sessao): conectores (de/da/do)
-- aparecem de forma INCONSISTENTE entre o romaneio e o OSM -- ex. romaneio
-- "RUA EDITH DE CASTRO LEITE" vs OSM "EDITH CASTRO LEITE" (romaneio tem "de"
-- a mais), e o oposto tambem acontece: romaneio "RUA JOAO LUIZ SIQUEIRA" vs
-- OSM "JOAO LUIZ DE SIQUEIRA" (aqui o OSM tem "de" a mais). O match exato
-- por nome_normalizado falha nos dois casos. Coluna gerada (nao precisa
-- reingestao do GeoJSON original, que ja nao existe mais no disco -- deriva
-- direto do nome_normalizado ja armazenado).
alter table vias_nomes
  add column nome_sem_conectores text
  generated always as (
    btrim(regexp_replace(regexp_replace(nome_normalizado, '\y(DE|DA|DO|DAS|DOS)\y', '', 'g'), '\s+', ' ', 'g'))
  ) stored;

create index idx_vias_nomes_sem_conectores on vias_nomes (nome_sem_conectores);
