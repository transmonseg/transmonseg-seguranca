// Rota HTTP isolada e SIDE-EFFECT-FREE (nunca escreve em nenhuma tabela)
// que expoe o historico continuo de posicao (posicoes_historico, ~30-40s
// de cadencia, ja coletado por este projeto pro motor de desvio) pro
// projeto IRMAO "KPI transmonseg" -- mesmo padrao de
// /api/romaneio/geocode (ver comentario la pro raciocinio completo de
// "por que HTTP e nao import direto").
//
// Por que essa rota existe (achado real 25/08, KPI Nutry Max): o KPI
// calculava SAIDA CD/CHEGADA CD e KM PERCORRIDO a partir do feed de
// "paradas" da propria Unitrac (/mapa_servicos/stops), que ja vem
// PRE-AGREGADO pela Unitrac com heuristica propria e opaca --
// reclusterizar isso do lado do KPI (com um limiar de duracao minima pra
// distinguir "parada real" de "blip de transito") criava uma classe
// inteira de casos ambiguos (parada curta mas real vs blip, cluster que
// devolve fim_real menor que o esperado, etc -- ver commit da correcao de
// 25/08 em KPI transmonseg/src/lib/unitrac-api/consolida.ts), e o
// KM PERCORRIDO (so' soma reta ENTRE paradas) subestimava o trajeto real
// em ~45% (140km vs 203km reais, mesmo veiculo/dia -- ver
// calcularKmContinuo abaixo). Este projeto ja tem dado MELHOR pro mesmo
// proposito: posicao continua real (lat/lng a cada ~30-40s, o dia
// inteiro) que o motor de desvio ja usa em producao -- da pra detectar a
// entrada/saida da base por CRUZAMENTO DE GEOFENCE direto no dado bruto
// (sem heuristica de cluster/duracao minima) e somar o km real percorrido
// ponto a ponto, sem pular trecho nenhum.
//
// Protegida pelo mesmo header x-motor-key + MOTOR_SECRET das outras rotas
// internas deste projeto -- chamada servidor-a-servidor, nunca do browser.

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { haversineM } from "@/lib/unitrac";

export const maxDuration = 30;

// Mesmo raio ja validado do lado do KPI (RAIO_BASE_METROS em
// kpi-romaneio/constants.ts) -- mantido igual aqui pra nao introduzir uma
// segunda nocao divergente de "o que conta como estar na base".
const RAIO_BASE_M = 500;

const MAX_PLACAS_POR_CHAMADA = 200;

type Posicao = { lat: number; lng: number; criado_em: string };
type BaseCentro = { lat: number; lng: number };

/** Dado o historico continuo (ordenado por tempo) e os centros de base do
 *  cliente, acha o instante em que o veiculo SAIU da base pela 1a vez no
 *  dia (transicao dentro->fora) e o instante em que CHEGOU na base pela
 *  ULTIMA vez (transicao fora->dentro) -- sem cluster, sem duracao minima,
 *  so' o cruzamento de geofence observado direto no dado bruto. Se o
 *  veiculo nunca aparece dentro do raio no dia inteiro (base errada pra
 *  essa rota, ou o veiculo so' opera fora do alcance rastreado), os dois
 *  ficam null -- nunca inventa horario. Se so' saiu mas ainda nao voltou
 *  (dia em andamento), chegada fica null -- mesma filosofia de
 *  "eventosBase.length >= 2" que ja existia do lado do KPI, so' que agora
 *  fundamentada em posicao real, nao em contagem de clusters da Unitrac.
 */
export function acharSaidaEChegadaBase(
  posicoes: Posicao[],
  basesCentro: BaseCentro[],
): { saidaBase: string | null; chegadaBase: string | null } {
  if (basesCentro.length === 0 || posicoes.length === 0) return { saidaBase: null, chegadaBase: null };

  const dentro = (p: Posicao) => basesCentro.some((b) => haversineM(b.lat, b.lng, p.lat, p.lng) <= RAIO_BASE_M);

  let saidaBase: string | null = null;
  let chegadaBase: string | null = null;
  let estadoAnterior: boolean | null = null;
  let anterior: Posicao | null = null;

  for (const p of posicoes) {
    const estaDentro = dentro(p);
    if (estadoAnterior === true && estaDentro === false && anterior) {
      // Transicao dentro->fora: guarda so' a PRIMEIRA do dia (a saida real
      // da manha) -- se ja tiver uma, uma saida posterior no meio do dia
      // (ex: volta rapida pra base e sai de novo) nao substitui.
      if (saidaBase === null) saidaBase = anterior.criado_em;
    }
    if (estadoAnterior === false && estaDentro === true) {
      // Transicao fora->dentro: guarda a ULTIMA do dia (sempre sobrescreve
      // -- a chegada que importa e' a mais recente, mesmo que o veiculo
      // tenha passado pela base mais de uma vez).
      chegadaBase = p.criado_em;
    }
    estadoAnterior = estaDentro;
    anterior = p;
  }

  return { saidaBase, chegadaBase };
}

/** Achado real 25/08 (dado real RBI-0J25): o KM PERCORRIDO do lado do KPI
 *  soma distancia em linha reta so' ENTRE as paradas da Unitrac (~20-30
 *  pontos no dia) -- pula todo o trajeto real entre elas. Comparando os
 *  dois pro mesmo veiculo/dia: 140.2km (so' paradas) vs 203.4km (posicao
 *  continua, ~2100 pontos) -- 45% de subestimativa. Soma haversine entre
 *  TODA leitura consecutiva do dia (~30-40s de cadencia) fica muito mais
 *  perto do km real rodado (ainda uma leve subestimativa em curva fechada
 *  dentro de uma unica janela de ~40s, mas ordens de grandeza melhor que
 *  pular o trajeto inteiro entre paradas distantes). */
export function calcularKmContinuo(posicoes: Posicao[]): number | null {
  if (posicoes.length < 2) return null
  let metros = 0
  for (let i = 1; i < posicoes.length; i++) {
    metros += haversineM(posicoes[i - 1].lat, posicoes[i - 1].lng, posicoes[i].lat, posicoes[i].lng)
  }
  return metros / 1000
}

function normPlaca(p: string): string {
  return p.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ erro: "corpo invalido, esperado JSON" }, { status: 400 });
  }

  const { placas, data } = body as { placas?: unknown; data?: unknown };
  if (!Array.isArray(placas) || !placas.every((p) => typeof p === "string")) {
    return Response.json({ erro: "'placas' precisa ser um array de strings" }, { status: 400 });
  }
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ erro: "'data' precisa ser YYYY-MM-DD" }, { status: 400 });
  }
  if (placas.length > MAX_PLACAS_POR_CHAMADA) {
    return Response.json({ erro: `no maximo ${MAX_PLACAS_POR_CHAMADA} placas por chamada` }, { status: 400 });
  }
  if (placas.length === 0) {
    return Response.json({ resultados: [] });
  }

  // Brasil nao observa horario de verao -- offset fixo -03:00, sem
  // precisar de conversao de fuso via banco (ver mesmo raciocinio em
  // formatarTituloData do lado do KPI).
  const inicioUTC = new Date(`${data}T00:00:00-03:00`);
  const fimUTC = new Date(inicioUTC.getTime() + 24 * 60 * 60 * 1000);

  const admin = createAdminClient();

  const { data: veiculosRows, error: erroVeiculos } = await admin
    .from("veiculos")
    .select("id, placa, cliente_id");
  if (erroVeiculos) {
    return Response.json({ erro: `erro ao carregar veiculos: ${erroVeiculos.message}` }, { status: 500 });
  }
  const veiculoPorPlacaNorm = new Map((veiculosRows ?? []).map((v) => [normPlaca(v.placa), v]));

  const clientesNecessarios = new Set<string>();
  for (const placaBruta of placas) {
    const v = veiculoPorPlacaNorm.get(normPlaca(placaBruta));
    if (v) clientesNecessarios.add(v.cliente_id);
  }

  const basesPorCliente = new Map<string, BaseCentro[]>();
  if (clientesNecessarios.size > 0) {
    const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 2 });
    try {
      const { rows: basesRows } = await pool.query<{ cliente_id: string; lat: number; lng: number }>(
        `SELECT cliente_id,
                ST_Y(ST_Centroid(geom::geometry)) AS lat,
                ST_X(ST_Centroid(geom::geometry)) AS lng
           FROM bases
          WHERE cliente_id = ANY($1::uuid[])`,
        [[...clientesNecessarios]],
      );
      for (const b of basesRows) {
        const lista = basesPorCliente.get(b.cliente_id) ?? [];
        lista.push({ lat: Number(b.lat), lng: Number(b.lng) });
        basesPorCliente.set(b.cliente_id, lista);
      }
    } finally {
      await pool.end();
    }
  }

  const resultados: { placa: string; saidaBase: string | null; chegadaBase: string | null; kmPercorrido: number | null }[] = [];
  for (const placaBruta of placas) {
    const v = veiculoPorPlacaNorm.get(normPlaca(placaBruta));
    if (!v) {
      resultados.push({ placa: placaBruta, saidaBase: null, chegadaBase: null, kmPercorrido: null });
      continue;
    }
    const basesCentro = basesPorCliente.get(v.cliente_id) ?? [];
    const { data: posicoesRows, error: erroPosicoes } = await admin
      .from("posicoes_historico")
      .select("lat, lng, criado_em")
      .eq("veiculo_id", v.id)
      .gte("criado_em", inicioUTC.toISOString())
      .lt("criado_em", fimUTC.toISOString())
      .order("criado_em", { ascending: true });
    if (erroPosicoes) {
      resultados.push({ placa: placaBruta, saidaBase: null, chegadaBase: null, kmPercorrido: null });
      continue;
    }
    const posicoes = (posicoesRows ?? []) as Posicao[];
    const { saidaBase, chegadaBase } = acharSaidaEChegadaBase(posicoes, basesCentro);
    const kmPercorrido = calcularKmContinuo(posicoes);
    resultados.push({ placa: placaBruta, saidaBase, chegadaBase, kmPercorrido });
  }

  return Response.json({ resultados });
}
