// Teste do orquestrador: confere as favelas e o point-in-polygon (geofence).
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: cnt } = await c.query("select count(*)::int n from geofences where tipo='favela'");
console.log("favelas no banco:", cnt[0].n);

const { rows: tipos } = await c.query(
  "select GeometryType(geom::geometry) t, count(*)::int n from geofences where tipo='favela' group by 1 order by 2 desc"
);
console.log("tipos de geometria:", tipos.map(r => `${r.t}=${r.n}`).join(", "));

async function teste(nome, lat, lng) {
  const { rows } = await c.query(
    "select nome from geofences where tipo='favela' and ST_Intersects(geom, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) limit 1",
    [lng, lat]
  );
  console.log(`  ${nome} (${lat}, ${lng}) -> ${rows[0]?.nome ?? "FORA de favela"}`);
}
console.log("point-in-polygon:");
await teste("Rocinha (MultiPolygon)", -22.988, -43.245);
await teste("C.do Alemão (MultiPolygon)", -22.861, -43.272);
await teste("Centro RJ (fora)", -22.910, -43.176);

await c.end();
