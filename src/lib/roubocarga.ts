// Roubo de carga no RJ (dados públicos gratuitos do ISP-RJ) por município,
// somando os últimos 12 meses disponíveis, casado com a malha municipal do IBGE.
// Lib de servidor. Fonte: ispdados.rj.gov.br (mensal por município) + IBGE malhas.
// O ponto exato do roubo é sigiloso; o público é agregado por município.

const ISP_CSV = "https://www.ispdados.rj.gov.br/Arquivos/BaseMunicipioMensal.csv";
const IBGE_MALHA =
  "https://servicodados.ibge.gov.br/api/v4/malhas/estados/33?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=intermediaria";

export type RouboCargaMunicipio = { cod: string; nome: string; total: number };
export type RouboCargaDados = {
  geojson: GeoJSON.FeatureCollection; // municípios com properties { cod, nome, roubo_carga }
  ranking: RouboCargaMunicipio[]; // ordenado desc
  total: number;
  periodo: string; // ex "07/2025 a 06/2026"
  atualizado: string; // ISO de quando montamos
};

// Cache em memória do processo: dados mensais, não precisam remontar a cada acesso.
let cache: { dados: RouboCargaDados; exp: number } | null = null;

const norm = (mesAno: number) => mesAno; // chave ano*12+mes
const rotuloMes = (ano: number, mes: number) => `${String(mes).padStart(2, "0")}/${ano}`;

// Agrega roubo_carga por município (fmun_cod) nos 12 meses mais recentes do CSV.
async function agregarISP(): Promise<{
  porCod: Map<string, { nome: string; total: number }>;
  periodo: string;
  total: number;
} | null> {
  const r = await fetch(ISP_CSV, { next: { revalidate: 86400 } });
  if (!r.ok) return null;
  const txt = new TextDecoder("latin1").decode(Buffer.from(await r.arrayBuffer()));
  const linhas = txt.split(/\r?\n/).filter(Boolean);
  if (linhas.length < 2) return null;

  const h = linhas[0].split(";");
  const iCod = h.findIndex((c) => /^fmun_cod$/i.test(c));
  const iNome = h.findIndex((c) => /^fmun$/i.test(c));
  const iAno = h.findIndex((c) => /^ano$/i.test(c));
  const iMes = h.findIndex((c) => /^mes$/i.test(c));
  const iCarga = h.findIndex((c) => /^roubo_carga$/i.test(c));
  if ([iCod, iNome, iAno, iMes, iCarga].some((i) => i < 0)) return null;

  // descobrir o mês mais recente presente
  let maxChave = 0;
  const dados: { cod: string; nome: string; ano: number; mes: number; carga: number }[] = [];
  for (const l of linhas.slice(1)) {
    const c = l.split(";");
    const ano = parseInt(c[iAno], 10);
    const mes = parseInt(c[iMes], 10);
    if (!Number.isFinite(ano) || !Number.isFinite(mes)) continue;
    const chave = ano * 12 + mes;
    if (chave > maxChave) maxChave = chave;
    dados.push({ cod: String(c[iCod]).trim(), nome: c[iNome], ano, mes, carga: parseInt(c[iCarga], 10) || 0 });
  }
  if (maxChave === 0) return null;
  const minChave = maxChave - 11; // janela de 12 meses

  const porCod = new Map<string, { nome: string; total: number }>();
  let total = 0;
  for (const d of dados) {
    const chave = d.ano * 12 + d.mes;
    if (norm(chave) < minChave || norm(chave) > maxChave) continue;
    const e = porCod.get(d.cod) ?? { nome: d.nome, total: 0 };
    e.total += d.carga;
    porCod.set(d.cod, e);
    total += d.carga;
  }
  const periodo = `${rotuloMes(Math.floor((minChave - 1) / 12), ((minChave - 1) % 12) + 1)} a ${rotuloMes(Math.floor((maxChave - 1) / 12), ((maxChave - 1) % 12) + 1)}`;
  return { porCod, periodo, total };
}

export async function obterRouboCarga(): Promise<RouboCargaDados | null> {
  const agora = Date.now();
  if (cache && cache.exp > agora) return cache.dados;

  try {
    const isp = await agregarISP();
    if (!isp) return cache?.dados ?? null;

    const malhaResp = await fetch(IBGE_MALHA, { next: { revalidate: 604800 } });
    if (!malhaResp.ok) return cache?.dados ?? null;
    const malha = (await malhaResp.json()) as GeoJSON.FeatureCollection;

    // Junta intensidade de roubo de carga em cada município da malha.
    for (const f of malha.features) {
      const cod = String((f.properties as { codarea?: string })?.codarea ?? "");
      const info = isp.porCod.get(cod);
      f.properties = {
        cod,
        nome: info?.nome ?? "",
        roubo_carga: info?.total ?? 0,
      };
    }

    const ranking: RouboCargaMunicipio[] = [...isp.porCod.entries()]
      .map(([cod, v]) => ({ cod, nome: v.nome, total: v.total }))
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
  } catch {
    return cache?.dados ?? null;
  }
}
