-- Bases passam de ponto+raio (círculo) para POLÍGONO do perímetro real
-- (onde a frota efetivamente estaciona). Resolve falso positivo de
-- "parado fora da base" quando o geocode do endereço caía no lugar errado.
-- Populado por scripts/seed/06_bases_cluster.mjs (clusters de veículos parados).

alter table bases alter column geom type geography(geometry, 4326);
alter table bases alter column raio_m drop not null;
