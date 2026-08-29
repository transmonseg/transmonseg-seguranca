// Roubo de carga no RJ (dados públicos gratuitos do ISP-RJ) por CISP
// (Circunscrição Integrada de Segurança Pública — área de delegacia),
// somando os últimos 12 meses disponíveis, casado com os polígonos de CISP
// importados uma vez em `geofences` (tipo='cisp', ver scripts/importar-cisp.mjs).
//
// Antes disso era agregado por MUNICÍPIO (BaseMunicipioMensal.csv) — dado
// muito grosseiro: o município do Rio de Janeiro inteiro (Manguinhos,
// Realengo, Irajá, Jacarepaguá...) tinha o MESMO valor de roubo_carga.
// CISP tem 137 áreas no estado (44 só na capital), diferenciando bairro
// dentro da mesma cidade — mesmo órgão/portal, mesmo formato de coluna,
// só troca a chave de agregação.
import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";

const ISP_CSV = "https://www.ispdados.rj.gov.br/Arquivos/BaseDPEvolucaoMensalCisp.csv";

export type RouboCargaCisp = { cisp: string; nome: string; total: number };
export type RouboCargaDados = {
  geojson: GeoJSON.FeatureCollection; // CISPs com properties { cisp, nome, roubo_carga }
  ranking: RouboCargaCisp[]; // ordenado desc
  total: number;
  periodo: string; // ex "07/2025 a 06/2026"
  atualizado: string; // ISO de quando montamos
};

// Cache em memória do processo: dados mensais, não precisam remontar a cada acesso.
let cache: { dados: RouboCargaDados; exp: number } | null = null;

const rotuloMes = (ano: number, mes: number) => `${String(mes).padStart(2, "0")}/${ano}`;

// Agrega roubo_carga por CISP (área de delegacia) nos 12 meses mais recentes do CSV.
async function agregarISP(): Promise<{
  porCisp: Map<string, { munic: string; total: number }>;
  periodo: string;
  total: number;
} | null> {
  const r = await fetch(ISP_CSV, { next: { revalidate: 86400 } });
  if (!r.ok) return null;
  const txt = new TextDecoder("latin1").decode(Buffer.from(await r.arrayBuffer()));
  const linhas = txt.split(/\r?\n/).filter(Boolean);
  if (linhas.length < 2) return null;

  const h = linhas[0].split(";");
  const iCisp = h.findIndex((c) => /^cisp$/i.test(c));
  const iMunic = h.findIndex((c) => /^munic$/i.test(c));
  const iAno = h.findIndex((c) => /^ano$/i.test(c));
  const iMes = h.findIndex((c) => /^mes$/i.test(c));
  const iCarga = h.findIndex((c) => /^roubo_carga$/i.test(c));
  if ([iCisp, iMunic, iAno, iMes, iCarga].some((i) => i < 0)) return null;

  // descobrir o mês mais recente presente
  let maxChave = 0;
  const dados: { cisp: string; munic: string; ano: number; mes: number; carga: number }[] = [];
  for (const l of linhas.slice(1)) {
    const c = l.split(";");
    const ano = parseInt(c[iAno], 10);
    const mes = parseInt(c[iMes], 10);
    if (!Number.isFinite(ano) || !Number.isFinite(mes)) continue;
    const chave = ano * 12 + mes;
    if (chave > maxChave) maxChave = chave;
    dados.push({ cisp: String(c[iCisp]).trim(), munic: c[iMunic], ano, mes, carga: parseInt(c[iCarga], 10) || 0 });
  }
  if (maxChave === 0) return null;
  const minChave = maxChave - 11; // janela de 12 meses

  const porCisp = new Map<string, { munic: string; total: number }>();
  let total = 0;
  for (const d of dados) {
    const chave = d.ano * 12 + d.mes;
    if (chave < minChave || chave > maxChave) continue;
    const e = porCisp.get(d.cisp) ?? { munic: d.munic, total: 0 };
    e.total += d.carga;
    porCisp.set(d.cisp, e);
    total += d.carga;
  }
  const periodo = `${rotuloMes(Math.floor((minChave - 1) / 12), ((minChave - 1) % 12) + 1)} a ${rotuloMes(Math.floor((maxChave - 1) / 12), ((maxChave - 1) % 12) + 1)}`;
  return { porCisp, periodo, total };
}

// Malha de polígonos de CISP, importada uma vez em geofences (tipo='cisp').
// Estática (limites de 2019) — não precisa refazer o join a cada request,
// só reconsultar o banco (rápido, sem chamada externa).
async function buscarMalhaCisp(): Promise<GeoJSON.FeatureCollection | null> {
  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL) });
  try {
    const r = await pool.query<{ cisp: string; geojson: GeoJSON.Geometry }>(
      `select meta->>'cisp' as cisp,
              ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom::geometry, 0.00002))::jsonb as geojson
       from geofences where tipo = 'cisp'`
    );
    if (r.rows.length === 0) return null;
    return {
      type: "FeatureCollection",
      features: r.rows.map((row) => ({
        type: "Feature",
        properties: { cisp: row.cisp },
        geometry: row.geojson,
      })),
    };
  } finally {
    await pool.end();
  }
}

export async function obterRouboCarga(): Promise<RouboCargaDados | null> {
  const agora = Date.now();
  if (cache && cache.exp > agora) return cache.dados;

  try {
    const isp = await agregarISP();
    if (!isp) return cache?.dados ?? null;

    const malha = await buscarMalhaCisp();
    if (!malha) return cache?.dados ?? null;

    // Junta intensidade de roubo de carga em cada CISP da malha.
    for (const f of malha.features) {
      const cisp = String((f.properties as { cisp?: string })?.cisp ?? "");
      const info = isp.porCisp.get(cisp);
      f.properties = {
        cisp,
        nome: info?.munic ? `CISP ${cisp} (${info.munic})` : `CISP ${cisp}`,
        roubo_carga: info?.total ?? 0,
      };
    }

    const ranking: RouboCargaCisp[] = [...isp.porCisp.entries()]
      .map(([cisp, v]) => ({ cisp, nome: `CISP ${cisp} (${v.munic})`, total: v.total }))
      .sort((a, b) => b.total - a.total);

    const dados: RouboCargaDados = {
      geojson: malha,
      ranking,
      total: isp.total,
      periodo: isp.periodo,
      atualizado: new Date().toISOString(),
    };
    cache = { dados, exp: agora + 6 * 60 * 60 * 1000 }; // 6h
    return dados;
  } catch (err) {
    // Achado real 30/08: excecao de agregarISP()/buscarMalhaCisp() (ex: CSV
    // do ISP-RJ mudou de formato) saia sem log -- sintoma em producao era
    // so "mapa parou de atualizar", sem rastro pra diagnosticar.
    console.error("dadosRouboCarga: falha ao atualizar, servindo cache antigo se houver:", err);
    return cache?.dados ?? null;
  }
}
