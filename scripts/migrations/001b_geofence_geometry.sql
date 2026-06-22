-- Favelas grandes (Rocinha, Complexo do Alemão, Jacarezinho) vêm como MultiPolygon
-- no SABREN. A coluna estava como geography(polygon) e as rejeitava.
-- Relaxa para aceitar qualquer geometria (Polygon e MultiPolygon).
alter table geofences alter column geom type geography(geometry, 4326);
