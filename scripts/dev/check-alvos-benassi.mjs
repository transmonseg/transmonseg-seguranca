// Verifica quantos alvos pendentes a Benassi tem agora
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: [benassi] } = await c.query(
  `SELECT id, cod_user_unitrac FROM clientes WHERE nome ILIKE '%benassi%' LIMIT 1`
);
console.log("Cliente:", benassi);

if (!benassi) { await c.end(); process.exit(0); }

const { rows: veiculos } = await c.query(
  `SELECT cv FROM veiculos WHERE cliente_id=$1 AND ativo=true LIMIT 10`,
  [benassi.id]
);
console.log(`\nTestando ${veiculos.length} CVs da Benassi (primeiros 10):`);

// Chamar a API de alvos diretamente
const cvs = veiculos.map(v => v.cv);
const res = await fetch("https://datalayer.portalunitrac.com/mapa_servicos/alvos", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(cvs),
});

if (!res.ok) {
  console.log("API retornou erro:", res.status);
  await c.end();
  process.exit(0);
}

const data = await res.json();
const alvos = data.alvos ?? [];
const pendentes = alvos.filter(a => a.alvosituacaoservico === 0);
const feitos = alvos.filter(a => a.alvosituacaoservico === 1);

console.log(`\nTotal alvos: ${alvos.length}`);
console.log(`  Pendentes (feito=0): ${pendentes.length}`);
console.log(`  Feitos (feito=1): ${feitos.length}`);

if (pendentes.length > 0) {
  const exemplo = pendentes.slice(0, 3);
  console.log("\nExemplos de pendentes:");
  for (const a of exemplo) {
    console.log(`  ${a.placa}  lat=${a.pontolatitude}  lng=${a.pontolongitude}  nome=${a.pontonome}`);
  }
}

await c.end();
