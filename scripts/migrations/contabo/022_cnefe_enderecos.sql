-- scripts/migrations/contabo/022_cnefe_enderecos.sql
--
-- Achado real 31/07 (pesquisa de fontes gratuitas de geocodificacao, ja que
-- Google Geocoding foi descartado -- usuario recusou vincular faturamento):
-- CNEFE (IBGE, Censo 2022) e' um cadastro nacional de enderecos 100%
-- georreferenciado em campo, publico, sem conta/cartao -- muito mais
-- preciso que o extrato OSM (vias_nomes) pra rua de cidade pequena/bairro
-- informal, porque foi coletado por recenseador porta a porta, nao por
-- voluntario de mapa.
--
-- pg_trgm: reforco pra bater nome de rua por similaridade (ex.
-- "FRANCISCO" vs "F.") quando nem o match exato do CNEFE resolver.
create extension if not exists pg_trgm;

create table cnefe_enderecos (
  id bigint primary key,              -- COD_UNICO_ENDERECO (ja unico na fonte)
  municipio_codigo text not null,     -- COD_MUNICIPIO (codigo IBGE de 7 digitos)
  cep text,
  localidade text,                    -- DSC_LOCALIDADE (bairro/localidade)
  logradouro_tipo text,               -- NOM_TIPO_SEGLOGR (RUA, AVENIDA, ...)
  logradouro_nome text not null,      -- NOM_TITULO_SEGLOGR + NOM_SEGLOGR, bruto
  numero text,                        -- NUM_ENDERECO
  lat double precision not null,
  lng double precision not null,
  nome_normalizado text not null      -- computado na ingestao (mesma normalizacao
                                       -- de src/lib/romaneio-geocode-local.ts: maiuscula,
                                       -- sem acento, sem conectores de/da/do/das/dos)
);

create index idx_cnefe_nome_numero on cnefe_enderecos (nome_normalizado, numero);
create index idx_cnefe_nome_trgm on cnefe_enderecos using gin (nome_normalizado gin_trgm_ops);
