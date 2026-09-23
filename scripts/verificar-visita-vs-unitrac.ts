// Verificacao SOMENTE LEITURA da regra "visita = parada real mais proxima em
// 500m" (commit 31106d9) contra o feitoISO dos alvos da Unitrac (snapshot do
// KPI). Compara chegada calculada (regra nova vs legado) com o horario que a
// Unitrac marcou como feito, para um dia/cliente.
//
// Entradas (arquivo-em, mesmo padrao de auditar-geocode-territorio.ts -- o
// banco do KPI nao e' acessivel com a credencial do monitoramento):
//   --romaneio  JSON de LinhaRomaneio[] (parseRomaneio do KPI sobre o PDF do dia)
//   --alvos     JSON do campo `alvos` de kpi_alvos_snapshot (cliente, data)
//   --cache     TSV (endereco, lat, lng, confiavel) de kpi_romaneio_geocode_cache
// Posicoes: posicoes_historico via DATABASE_URL (apenas SELECT).
//
// CONVENCAO DE TEMPO (bug de 3h ja ocorreu): posicoes/chegada = UTC REAL;
// feitoISO da Unitrac = digitos de Brasilia sem fuso ("2026-09-22T10:00:00");
// instanteDeFeitoISO(feito) = feito + 'Z' (fake UTC); real = fake + 3h.
//
// Uso: npx tsx scripts/verificar-visita-vs-unitrac.ts --data 2026-09-22 \
//   --romaneio r.json --alvos a.json --cache c.tsv [--legado]
// (--legado imprime so' o caminho antigo; sem a flag imprime os dois.)
import { readFileSync } from "node:fs";
import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { haversineM } from "@/lib/unitrac";
import { acharVisitasPorPonto, acharBlocoDentroDoRaio } from "@/app/api/kpi/base-horarios/route";

type Posicao = { lat: number; lng: number; criado_em: string; velocidade: number; atraso_min: number };
type Ponto = { id: string; lat: number; lng: number };
type Visita = { id: string; chegada: string | null; saida: string | null };
type Base = { lat: number; lng: number };

// Espelham route.ts (constantes nao exportadas).
const RAIO_ENTREGA_M = 500;
const RAIO_AMPLIADO_M = 800;
const RAIO_VIZINHANCA_M = 800;

const TRES_H = 3 * 60 * 60 * 1000;
const instanteDeFeitoISO = (feito: string) => Date.parse(feito + "Z"); // fake UTC
const feitoComoUtcReal = (feito: string) => instanteDeFeitoISO(feito) + TRES_H;

/** Caminho ANTIGO (pre-31106d9): passo direto = maior permanencia no raio de
 *  500 m; ampliado e vizinhanca identicos ao atual. */
function acharVisitasLegado(posicoes: Posicao[], pontos: Ponto[], bases: Base[]): Visita[] {
  const diretas: (Visita & { via?: string })[] = pontos.map((pt) => {
    const b = acharBlocoDentroDoRaio(pt as never, posicoes, RAIO_ENTREGA_M, bases);
    return b ? { id: pt.id, chegada: b.inicio, saida: b.fim } : { id: pt.id, chegada: null, saida: null };
  });
  const amp = diretas.map((v, i) => {
    if (v.chegada !== null) return v;
    const b = acharBlocoDentroDoRaio(pontos[i] as never, posicoes, RAIO_AMPLIADO_M, bases);
    return b ? { id: v.id, chegada: b.inicio, saida: b.fim } : v;
  });
  return amp.map((v, i) => {
    if (v.chegada !== null) return v;
    let melhor: Visita | null = null;
    let menor = Infinity;
    for (let j = 0; j < amp.length; j++) {
      if (j === i || amp[j].chegada === null) continue;
      const d = haversineM(pontos[i].lat, pontos[i].lng, pontos[j].lat, pontos[j].lng);
      if (d <= RAIO_VIZINHANCA_M && d < menor) { menor = d; melhor = amp[j]; }
    }
    return melhor ? { id: v.id, chegada: melhor.chegada, saida: melhor.saida } : v;
  });
}

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const normPlaca = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, "");

type Res = { n: number; nulos: number; d2: number; d10: number; desvios: number[]; saida2: number; saida10: number };
function resumir(nome: string, r: Res) {
  const s = [...r.desvios].sort((a, b) => a - b);
  const med = s.length ? s[Math.floor(s.length / 2)] : NaN;
  const naoNulos = r.n - r.nulos;
  const pct = (x: number, d: number) => (d ? ((100 * x) / d).toFixed(1) : "n/a") + "%";
  console.log(
    `${nome}: N=${r.n} | <=2min ${r.d2} (${pct(r.d2, r.n)}) | <=10min ${r.d10} (${pct(r.d10, r.n)}) | null ${r.nulos} (${pct(r.nulos, r.n)}) | ` +
      `sobre nao-nulos: <=2min ${pct(r.d2, naoNulos)}, <=10min ${pct(r.d10, naoNulos)} | mediana desvio (chegada - feito) ${med.toFixed(1)} min | (diag) SAIDA vs feito: <=2min ${r.saida2}, <=10min ${r.saida10}`,
  );
}

async function main() {
  const data = arg("data") ?? "2026-09-22";
  const soLegado = process.argv.includes("--legado");
  const romaneio: { nf: string; placa: string; endereco: string }[] = JSON.parse(readFileSync(arg("romaneio")!, "utf8"));
  const alvos: { documento: string; placaNorm: string; feitoISO: string | null }[] = JSON.parse(readFileSync(arg("alvos")!, "utf8"));
  const cache = new Map<string, { lat: number; lng: number }>();
  for (const l of readFileSync(arg("cache")!, "utf8").split("\n")) {
    const [e, lat, lng] = l.split("\t");
    if (e && lat && lng) cache.set(e, { lat: Number(lat), lng: Number(lng) });
  }

  const feitoPorNf = new Map<string, string>();
  for (const a of alvos) if (a.feitoISO) feitoPorNf.set(a.documento, a.feitoISO);

  const pontosPorPlaca = new Map<string, Ponto[]>();
  let semGeo = 0;
  for (const l of romaneio) {
    const g = cache.get(l.endereco);
    if (!g) { semGeo++; continue; }
    const k = normPlaca(l.placa);
    if (!k) continue;
    (pontosPorPlaca.get(k) ?? pontosPorPlaca.set(k, []).get(k)!).push({ id: l.nf, lat: g.lat, lng: g.lng });
  }

  const inicio = new Date(`${data}T00:00:00-03:00`);
  const fim = new Date(inicio.getTime() + 24 * 3600 * 1000);
  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 2 });
  const novo: Res = { n: 0, nulos: 0, d2: 0, d10: 0, desvios: [], saida2: 0, saida10: 0 };
  const leg: Res = { n: 0, nulos: 0, d2: 0, d10: 0, desvios: [], saida2: 0, saida10: 0 };
  let placasSemVeiculo = 0;
  try {
    const { rows: veic } = await pool.query<{ id: string; placa: string; cliente_id: string }>("SELECT id, placa, cliente_id FROM veiculos");
    const porPlaca = new Map(veic.map((v) => [normPlaca(v.placa), v]));
    const clientes = [...new Set(veic.map((v) => v.cliente_id))];
    const { rows: basesRows } = await pool.query<{ cliente_id: string; lat: number; lng: number }>(
      `SELECT cliente_id, ST_Y(ST_Centroid(geom::geometry)) AS lat, ST_X(ST_Centroid(geom::geometry)) AS lng FROM bases WHERE cliente_id = ANY($1::uuid[])`,
      [clientes],
    );
    const basesPorCliente = new Map<string, Base[]>();
    for (const b of basesRows) (basesPorCliente.get(b.cliente_id) ?? basesPorCliente.set(b.cliente_id, []).get(b.cliente_id)!).push({ lat: Number(b.lat), lng: Number(b.lng) });

    const contar = (r: Res, v: Visita | undefined, feito: string) => {
      r.n++;
      if (!v || v.chegada === null) { r.nulos++; return; }
      const difMin = (Date.parse(v.chegada) - feitoComoUtcReal(feito)) / 60000;
      r.desvios.push(difMin);
      if (v.saida) {
        const dS = (Date.parse(v.saida) - feitoComoUtcReal(feito)) / 60000;
        if (Math.abs(dS) <= 2) r.saida2++;
        if (Math.abs(dS) <= 10) r.saida10++;
      }
      if (Math.abs(difMin) <= 2) r.d2++;
      if (Math.abs(difMin) <= 10) r.d10++;
    };

    for (const [placa, pontos] of pontosPorPlaca) {
      const v = porPlaca.get(placa);
      if (!v) { placasSemVeiculo++; continue; }
      const { rows } = await pool.query<Posicao>(
        `SELECT lat, lng, criado_em, velocidade, atraso_min FROM posicoes_historico WHERE veiculo_id = $1 AND criado_em >= $2 AND criado_em < $3 ORDER BY criado_em ASC`,
        [v.id, inicio.toISOString(), fim.toISOString()],
      );
      const posicoes = rows.map((r) => ({ ...r, criado_em: new Date(r.criado_em).toISOString() }));
      const bases = basesPorCliente.get(v.cliente_id) ?? [];
      const nova = acharVisitasPorPonto(posicoes as never, pontos, bases);
      const antiga = acharVisitasLegado(posicoes, pontos, bases);
      for (const p of pontos) {
        const feito = feitoPorNf.get(p.id);
        if (!feito) continue;
        contar(novo, nova.find((x) => x.id === p.id), feito);
        contar(leg, antiga.find((x) => x.id === p.id), feito);
      }
    }
  } finally {
    await pool.end();
  }
  console.log(`dia ${data} | NFs sem geocode no cache: ${semGeo} | placas sem veiculo: ${placasSemVeiculo}`);
  if (!soLegado) resumir("NOVA  ", novo);
  resumir("LEGADO", leg);
  const med = (r: Res) => { const s = [...r.desvios].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  if (Math.abs(med(novo)) > 120 || Math.abs(med(leg)) > 120) console.log("ALERTA: mediana perto de +-180min -> convencao de tempo provavelmente errada");
}

main().catch((e) => { console.error(e); process.exit(1); });
