-- 074_cnefe_rua_numero_proximo.sql
--
-- Achado real 05/09 (diagnostico dos 382 pendentes do KPI Nutry Max de
-- 03/09): 226 tinham coordenada mas o caminhao nunca passou a menos de
-- 1,5km dela -- media de 14km. No nivel "so rua" da cascata, a query pegava
-- ate 200 pontos da rua SEM ORDENACAO e a escolha final era pela
-- proximidade ao CENTRO DA CIDADE -- em via longa, numeros bem distantes
-- colapsavam no MESMO ponto: "AV LUCIO COSTA, 2900 / 5700 / 16580"
-- (avenida de ~18km na Barra) todos em -23.01391,-43.31373; idem "ESTRADA
-- DO MARINAS, 200 / 580" e quatro numeros da "R PROF ALICE KURI DA SILVA".
--
-- Nao basta desempatar por numero no lado do app: com LIMIT 200 sem ORDER
-- BY, o numero certo pode nem estar na amostra (rua longa tem milhares de
-- pontos no CNEFE). Esta funcao ordena PELO NUMERO no banco.
--
-- `numero` no CNEFE e' texto e nem sempre e' numerico puro ("123 A", "S/N",
-- "KM 3"): so' entram linhas cujo numero tem digito, comparadas pelos
-- digitos extraidos. Empate de numero (mesmo numero em pontos diferentes,
-- comum em condominio) desempata pela maior densidade -- devolve varios
-- candidatos e quem decide e' o app, que ainda aplica o teto de distancia
-- do ponto de cidade.
--
-- Roda como superuser (`sudo -u postgres psql -d transmonseg -f <arquivo>`).

create or replace function cnefe_buscar_por_rua_numero_proximo(
  nome text,
  numero_alvo bigint,
  filtro_municipio_codigo text default null,
  limite int default 5
)
returns table(lat double precision, lng double precision, numero text) as $$
  select c.lat, c.lng, c.numero
    from cnefe_enderecos c
   where c.nome_normalizado = nome
     and (filtro_municipio_codigo is null or c.municipio_codigo = filtro_municipio_codigo)
     and c.numero ~ '[0-9]'
   order by abs(regexp_replace(c.numero, '\D', '', 'g')::bigint - numero_alvo)
   limit limite;
$$ language sql stable
   set plan_cache_mode = force_custom_plan;

NOTIFY pgrst, 'reload schema';
