-- 075_mapa_provider_estado.sql
--
-- Estado singleton (1 linha só, id fixo em 1) de qual provedor de mapa a
-- Central deve usar: 'google' (padrao) ou 'fallback' (OSM self-hospedado),
-- quando a cota da chave do Google Maps estourar. Ver spec
-- docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md.
--
-- Roda como postgres (app_service nao tem permissao de DDL), mesmo padrao das
-- migracoes 070-074:
--   ssh transmonseg-vps "sudo -u postgres psql -d transmonseg -f -" \
--     < scripts/migrations/contabo/075_mapa_provider_estado.sql

create table if not exists mapa_provider_estado (
  id smallint primary key default 1 check (id = 1),
  provider text not null default 'google' check (provider in ('google', 'fallback')),
  quota_excedida_em timestamptz,
  proxima_tentativa_em timestamptz,
  atualizado_em timestamptz not null default now()
);

insert into mapa_provider_estado (id, provider)
values (1, 'google')
on conflict (id) do nothing;

NOTIFY pgrst, 'reload schema';
