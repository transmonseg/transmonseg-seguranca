import { buscarAlvos, agruparPontosPorPlaca, type PontoEntrega } from "@/lib/unitrac";
import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";

// Pool proprio e pequeno (mesmo padrao de recalibrar-desvio): esta rota so
// faz duas leituras curtas por request, e ja e servida por cache de 30s.
const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 2 });

// Cache EM MEMORIA (nao e tabela no banco, some sozinho, nunca precisa de
// limpeza) pela lista exata de cv's pedida — evita rebater na Unitrac quando
// varias telas pedem a mesma placa (ou a malha da frota inteira) quase ao
// mesmo tempo. TTL curto: alvos do dia mudam em minutos, nao em segundos.
type AlvosCacheEntry = { pontos: unknown[]; expiraEm: number };
const ALVOS_CACHE_MS = 30_000;
const cacheAlvosPorChave = new Map<string, AlvosCacheEntry>();

// Data de HOJE em Sao Paulo -- nunca current_date do Postgres: o servidor
// roda em +02 e SP e -03, entao das 19h as 23h59 (SP) o current_date do
// banco ja e o dia seguinte.
function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

type LinhaRomaneio = {
  placa: string;
  nf: string;
  cliente_nome: string;
  endereco_bruto: string;
  lat: number | null;
  lng: number | null;
};

// Achado real 01/08 (reclamacao do usuario: "ta ficando a mesma coisa do
// que vem pela API, nao aparece no mapa"): esta rota alimenta TODOS os
// pontos de entrega desenhados no mapa, e ate hoje era Unitrac puro --
// nunca leu romaneio_pontos. O operador subia 1.508 enderecos
// geocodificados e a tela ignorava os 1.508. O modo ROMANEIO do mapa so
// filtrava QUAIS VEICULOS aparecem, nunca trocou os pontos.
//
// Agora: os pontos da Unitrac continuam sendo a base (o motor segue usando
// so a Unitrac pra detectar desvio -- isso NAO muda), e o romaneio do dia
// entra por cima, casado por NF, para:
//   1. trazer o nome real do cliente e o endereco legivel (a Unitrac manda
//      so um identificador cru);
//   2. marcar como FEITO o que a Unitrac nao marcou mas o caminhao ja
//      entregou (entregas_presenca -- "parada no local conta como
//      entregue");
//   3. mostrar NF que so existe no romaneio, sem alvo correspondente na
//      Unitrac -- senao entrega real ficaria invisivel no mapa.
//
// A COORDENADA continua sendo a da Unitrac. A primeira versao desta rota
// preferia a do romaneio, por suposicao minha de que o endereco
// geocodificado seria mais fiel. MEDIDO e REFUTADO no mesmo dia (ver o
// comentario no merge abaixo): a coordenada da Unitrac erra menos
// (mediana 43m x 152m). O romaneio agrega TEXTO, nao precisao geografica.
async function buscarRomaneioPorPlaca(placas: string[]): Promise<Map<string, LinhaRomaneio[]>> {
  const mapa = new Map<string, LinhaRomaneio[]>();
  if (placas.length === 0) return mapa;
  const cliente = await pool.connect();
  try {
    const { rows } = await cliente.query<LinhaRomaneio>(
      `SELECT rp.placa, rp.nf, rp.cliente_nome, rp.endereco_bruto, rp.lat, rp.lng
         FROM romaneio_pontos rp
        WHERE rp.romaneio_data = $2::date
          AND rp.modo_teste = false
          AND rp.placa = ANY($1::text[])`,
      [placas, hojeSP()]
    );
    for (const r of rows) {
      const lista = mapa.get(r.placa) ?? [];
      lista.push(r);
      mapa.set(r.placa, lista);
    }
    return mapa;
  } catch {
    // Falha de leitura -> mapa vazio -> comportamento anterior (so Unitrac).
    return mapa;
  } finally {
    cliente.release();
  }
}

// "Parada no local conta como entregue" -- chave "placa:ponto_codigo".
// Casa pelo pontoCodigo do alvo da Unitrac (que e o que entregas_presenca
// grava), NAO pela NF do romaneio: romaneio_pontos nao tem ponto_codigo, e
// juntar so por veiculo marcaria TODAS as entregas do caminhao como feitas.
async function buscarPresencaPorPlaca(placas: string[]): Promise<Set<string>> {
  if (placas.length === 0) return new Set();
  const cliente = await pool.connect();
  try {
    const { rows } = await cliente.query<{ placa: string; ponto_codigo: string }>(
      `SELECT v.placa, ep.ponto_codigo
         FROM entregas_presenca ep
         JOIN veiculos v ON v.id = ep.veiculo_id
        WHERE ep.dia = $2::date AND v.placa = ANY($1::text[])`,
      [placas, hojeSP()]
    );
    return new Set(rows.map((r) => `${r.placa}:${r.ponto_codigo}`));
  } catch {
    return new Set();
  } finally {
    cliente.release();
  }
}

function normalizarNf(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/^0+/, "").toUpperCase();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Suporta ?cv=X (único) ou múltiplos ?cv=A&cv=B (frota completa)
  const cvs = searchParams.getAll("cv");
  if (cvs.length === 0) return Response.json({ pontos: [] }, { status: 400 });

  const chave = [...cvs].sort().join(",");
  const cache = cacheAlvosPorChave.get(chave);
  if (cache && cache.expiraEm > Date.now()) {
    return Response.json({ pontos: cache.pontos });
  }

  try {
    const raw = await buscarAlvos(cvs);
    const mapa = agruparPontosPorPlaca(raw);
    const placas = [...mapa.keys()];
    const [romaneioPorPlaca, presenca] = await Promise.all([
      buscarRomaneioPorPlaca(placas),
      buscarPresencaPorPlaca(placas),
    ]);

    const todos: PontoEntrega[] = [];
    for (const [placa, pontosUnitrac] of mapa.entries()) {
      const doRomaneio = romaneioPorPlaca.get(placa) ?? [];
      const porNf = new Map(doRomaneio.map((r) => [normalizarNf(r.nf), r]));
      const nfsUsadas = new Set<string>();

      for (const pt of pontosUnitrac) {
        const entreguePorParada =
          pt.pontoCodigo != null && presenca.has(`${placa}:${pt.pontoCodigo}`);
        const r = porNf.get(normalizarNf(pt.documento));
        if (!r) {
          todos.push(entreguePorParada ? { ...pt, feito: true } : pt);
          continue;
        }
        nfsUsadas.add(normalizarNf(r.nf));
        todos.push({
          ...pt,
          // COORDENADA: fica a da Unitrac, sempre. A primeira versao desta
          // rota preferia a do romaneio -- MEDIDO e refutado no mesmo dia,
          // comparando 1.253 NFs (romaneio x alvo da Unitrac, mesma NF)
          // contra as paradas reais dos caminhoes em 01/08:
          //
          //            mediana do erro   <=100m   <=300m
          //   Unitrac        43m           65%      80%
          //   Romaneio      152m           43%      63%
          //   (romaneio so fica mais perto em 30% dos casos)
          //
          // O endereco do romaneio passa por geocodificacao (CNEFE/OSM/
          // Nominatim), que erra mais que a coordenada que a Unitrac ja tem
          // cadastrada do ponto. O romaneio agrega TEXTO (nome do cliente,
          // endereco legivel), nao precisao geografica.
          nome: r.cliente_nome || pt.nome,
          observacoes: r.endereco_bruto || pt.observacoes,
          feito: pt.feito || entreguePorParada,
        });
      }

      // NFs que so existem no romaneio (a Unitrac nao trouxe alvo pra elas)
      // -- sem isto, entrega real ficaria invisivel no mapa. Sem alvo da
      // Unitrac nao ha pontoCodigo, entao nao da pra cruzar com presenca:
      // entra como pendente.
      for (const r of doRomaneio) {
        const nf = normalizarNf(r.nf);
        if (nfsUsadas.has(nf) || r.lat == null || r.lng == null) continue;
        todos.push({
          lat: r.lat,
          lng: r.lng,
          raio: 50,
          ordem: 999,
          nome: r.cliente_nome,
          feito: false,
          situacao: 0,
          codigo: null,
          pontoCodigo: null,
          documento: r.nf,
          identificador: null,
          dataInicio: null,
          dataRealizado: null,
          observacoes: r.endereco_bruto,
          rota: null,
          placa,
        });
      }
    }

    cacheAlvosPorChave.set(chave, { pontos: todos, expiraEm: Date.now() + ALVOS_CACHE_MS });
    return Response.json({ pontos: todos });
  } catch (err) {
    return Response.json({ pontos: [], erro: String(err) });
  }
}
