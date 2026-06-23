import pg from "pg";
import fs from "fs";
const conn = fs.readFileSync(".env.local", "utf8").match(/DATABASE_URL=(.+)/)[1].trim();
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`
  select coalesce(
    jsonb_build_object('type','FeatureCollection','features', jsonb_agg(
      jsonb_build_object(
        'type','Feature',
        'properties', jsonb_build_object('nome', nome),
        'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom::geometry, 0.00002))::jsonb
      ))),
    jsonb_build_object('type','FeatureCollection','features','[]'::jsonb)
  ) gj
  from geofences where tipo = 'favela'`);
const s = JSON.stringify(r.rows[0].gj);
console.log("features:", r.rows[0].gj.features.length);
console.log("payload:", (s.length / 1024 / 1024).toFixed(2), "MB");
const b = await c.query(`select min(ST_YMin(geom::geometry)) miny, max(ST_YMax(geom::geometry)) maxy,
  min(ST_XMin(geom::geometry)) minx, max(ST_XMax(geom::geometry)) maxx
  from geofences where tipo='favela'`);
console.log("bbox estado:", b.rows[0]);
await c.end();
