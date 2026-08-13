// Calibra o piso de confianca (LIMIAR_CONFIANCA_MATCH) usado na Task 4 pra
// decidir quando aceitar a correcao de posicao via OSRM /match (Task 2,
// src/lib/osrm-match.ts) em vez de cair no fallback bruto. Ver Task 3 do
// plano docs/superpowers/.../2026-08-13-osrm-match-desvio.
//
// Reproduz os 4 casos reais de falso positivo do dia 13/08 (achados via
// desvio_disparo_log -- ver spec) contra o /match de verdade (nao
// mockado), usando as posicoes reais gravadas naquele dia. A ideia: o
// `confidence` que o OSRM devolve pra esses 4 casos define o piso -- eles
// SAO exatamente os casos que a correcao pretende resolver, entao o
// limiar tem que ficar abaixo do menor confidence observado, senao a
// propria correcao que estamos calibrando rejeitaria os casos que a
// motivaram.
//
// Roda MANUALMENTE via SSH contra o Contabo (posicoes_historico so'
// existe la, mesmo padrao de outros scripts de investigacao desta sessao,
// ex: scripts/validar-desvio-v2.mjs):
//   ssh transmonseg-vps "cd /srv/transmonseg/temp && npx tsx --env-file=.env.production scripts/calibrar-piso-confianca-match.mjs"
//
// (tsx, nao node puro -- este script importa .ts direto de src/lib/)
import pg from "pg";
import { corrigirPosicoesComMatch } from "../src/lib/osrm-match.ts";

const conn = process.env.DATABASE_URL;
if (!conn) { console.error("DATABASE_URL ausente"); process.exit(1); }
const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await c.connect();

// Placas + timestamp de disparo dos 4 casos reais de falso positivo
// (13/08, achado via desvio_disparo_log -- ver spec).
const CASOS = [
  { placa: "RBG-5G18", quando: "2026-08-13T14:18:55.370Z" },
  { placa: "TTH-6G37", quando: "2026-08-13T14:31:38.152Z" },
  { placa: "RQU-2H61", quando: "2026-08-13T14:37:37.488Z" },
  { placa: "TOS-2B69", quando: "2026-08-13T14:36:12.057Z" },
];

for (const caso of CASOS) {
  const { rows: v } = await c.query(`SELECT id FROM veiculos WHERE placa = $1`, [caso.placa]);
  if (v.length === 0) {
    console.log(`${caso.placa}: veiculo nao encontrado`);
    continue;
  }
  const veiculo_id = v[0].id;
  const quando = new Date(caso.quando);
  const { rows: pos } = await c.query(
    `SELECT lat, lng, criado_em FROM posicoes_historico
      WHERE veiculo_id = $1 AND criado_em BETWEEN $2 AND $3
      ORDER BY criado_em ASC`,
    [veiculo_id, new Date(quando.getTime() - 5 * 60000), quando]
  );
  const pontos = pos.map((p) => ({ lat: p.lat, lng: p.lng, timestamp: p.criado_em }));
  const resultado = await corrigirPosicoesComMatch(pontos);
  console.log(`${caso.placa}: ${pontos.length} pontos na janela de 5min -> `, resultado);
}

await c.end();
