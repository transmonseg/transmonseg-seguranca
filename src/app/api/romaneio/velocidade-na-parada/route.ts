import { createAdminClient } from "@/lib/supabase/admin";
import { normalizarPlaca } from "@/lib/romaneio";

// POST /api/romaneio/velocidade-na-parada -- Fase 2, item 3a da spec
// docs/superpowers/specs/2026-09-12-confiabilidade-kpi-nutrimax-design.md.
//
// O KPI confirma entrega usando as paradas que a API de alvos do Unitrac
// devolve (consolidaParadasApi, unitrac.ts la' no KPI) -- essas paradas NAO
// tem campo de velocidade. Dois problemas vem dai:
//   1. Um caminhao PASSANDO (nunca parando de verdade) pode ser creditado
//      com uma entrega se o Unitrac reportar QUALQUER parada perto do
//      endereco.
//   2. Confirmado em 14/09: 3 placas, 10 NFs, onde a propria API de paradas
//      do Unitrac devolveu coordenada que o trajeto de GPS independente
//      (posicoes_historico, coletado pelo poller do monitoramento -- MESMO
//      veiculo, mas caminho de codigo DIFERENTE da API de paradas do
//      Unitrac) prova errada por 3,6 a 18,3 km o dia inteiro.
//
// A correcao pros dois: antes de aceitar uma parada do Unitrac como
// confirmacao, cruzar com o NOSSO trajeto de GPS (posicoes_historico, so'
// existe na base `transmonseg`, que so' este projeto -- monitoramento --
// consegue alcancar) e' exigir pelo menos uma leitura estacionaria (
// velocidade <=5) dentro do raio e da janela de tempo da parada candidata.
//
// Quem chama: o projeto KPI transmonseg (repo irmao), via HTTP local no
// mesmo VPS (transmonseg-vps) -- mesmo motivo estrutural de geocode/route.ts
// e geocode-ancoras/route.ts (repos/node_modules separados, sem import
// direto possivel).
//
// Contrato de resposta (decisao explicita, ver task): esta rota reporta
// FATO -- nunca decide fail-open. `null` e' reservado SO' pra entrada
// malformada (faltando campo obrigatorio). Quem decide o que fazer com
// "sem dado nosso" (ex. aceitar como hoje, fail-open, por falta de GPS) e'
// o CHAMADOR (KPI), nao esta rota -- aqui embaixo a rota so' informa o que
// o GPS mostrou.
//
// Correcao pos-revisao (mesmo dia): a resposta original era so' um
// boolean (`temParadaComVelocidade`), e isso colapsava dois casos que a
// secao 3a da spec exige distinguir:
//   1. ZERO leituras pra aquela placa naquela janela/raio (fora de
//      cobertura do Unitrac/monitoramento) -- a spec manda fail-open aqui
//      ("nao inventar negativa por falta de dado"), o chamador deve
//      CONTINUAR confiando na parada do Unitrac como confirma hoje.
//   2. Leituras EXISTEM na janela/raio, mas todas com velocidade >5 --
//      contradicao real (o caminhao passou, nao parou) -- o chamador deve
//      DESCARTAR a parada do Unitrac.
// Os dois casos produziam o MESMO `false` na primeira versao -- o chamador
// nao tinha como diferenciar "sem dado" de "dado contradiz". `temCobertura`
// (existe ao menos 1 linha casando placa+janela+raio, com QUALQUER
// velocidade) resolve isso sem precisar de 2a chamada -- vem da MESMA
// query SQL (bool_or/count agregado por indice), so' mais uma coluna.
//
// Protegida pelo mesmo header x-motor-key + MOTOR_SECRET que as outras
// rotas de ponte deste projeto. Side-effect-free: SO' LE posicoes_historico
// e veiculos, nunca escreve em nenhuma tabela.
//
// Performance (achado real da mesma spec: uma consulta ingenua 1-por-linha
// jah' levou 1h46 num caso parecido deste projeto, contra 3,8s reescrita em
// lote sobre 8,7k linhas): 1 UNICA chamada SQL via RPC
// `posicoes_velocidade_na_parada_lote` (migration 049/085, unnest dos 6
// arrays em paralelo com WITH ORDINALITY), nunca 1 query por consulta do
// lote -- essencial pro caso de uso real (centenas de consultas numa unica
// geracao de KPI).

export const maxDuration = 60;

// Teto defensivo por chamada -- mesmo numero de MAX_ENDERECOS_POR_CHAMADA em
// geocode/route.ts (convencao deste projeto pra rotas de ponte batch).
// Rejeitar explicitamente acima disso forca o chamador a dividir em lotes
// menores, em vez de truncar em silencio.
const MAX_CONSULTAS_POR_CHAMADA = 300;

type ConsultaEntrada = {
  placa: string;
  lat: number;
  lng: number;
  raioM: number;
  inicioIso: string;
  fimIso: string;
};

function ehConsultaValida(c: unknown): c is ConsultaEntrada {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.placa === "string" &&
    o.placa.trim().length > 0 &&
    typeof o.lat === "number" &&
    Number.isFinite(o.lat) &&
    typeof o.lng === "number" &&
    Number.isFinite(o.lng) &&
    typeof o.raioM === "number" &&
    Number.isFinite(o.raioM) &&
    o.raioM > 0 &&
    typeof o.inicioIso === "string" &&
    !Number.isNaN(Date.parse(o.inicioIso)) &&
    typeof o.fimIso === "string" &&
    !Number.isNaN(Date.parse(o.fimIso))
  );
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

  const consultas = (body as { consultas?: unknown })?.consultas;
  if (!Array.isArray(consultas)) {
    return Response.json({ erro: "'consultas' precisa ser um array" }, { status: 400 });
  }
  if (consultas.length > MAX_CONSULTAS_POR_CHAMADA) {
    return Response.json({ erro: `no maximo ${MAX_CONSULTAS_POR_CHAMADA} consultas por chamada` }, { status: 400 });
  }
  if (consultas.length === 0) {
    return Response.json({ resultados: [] });
  }

  // Entrada malformada vira `null` NESSA POSICAO (nunca derruba o lote
  // inteiro por causa de 1 item ruim) -- so' as validas viajam pro banco.
  // Mapa de indice-no-lote-valido -> indice-original pra remontar a
  // resposta na ordem certa depois.
  const validasComIndiceOriginal: { consulta: ConsultaEntrada; indiceOriginal: number }[] = [];
  consultas.forEach((c, indiceOriginal) => {
    if (ehConsultaValida(c)) validasComIndiceOriginal.push({ consulta: c, indiceOriginal });
  });

  type Resultado = { temParadaComVelocidade: boolean; temCobertura: boolean };
  const resultados: (Resultado | null)[] = new Array(consultas.length).fill(null);

  if (validasComIndiceOriginal.length === 0) {
    return Response.json({ resultados });
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("posicoes_velocidade_na_parada_lote", {
    p_placas: validasComIndiceOriginal.map((v) => normalizarPlaca(v.consulta.placa)),
    p_lats: validasComIndiceOriginal.map((v) => v.consulta.lat),
    p_lngs: validasComIndiceOriginal.map((v) => v.consulta.lng),
    p_raios: validasComIndiceOriginal.map((v) => v.consulta.raioM),
    p_inicios: validasComIndiceOriginal.map((v) => v.consulta.inicioIso),
    p_fins: validasComIndiceOriginal.map((v) => v.consulta.fimIso),
  });

  if (error) {
    return Response.json({ erro: `posicoes_velocidade_na_parada_lote: ${error.message}` }, { status: 500 });
  }

  // A funcao devolve so' as linhas com idx correspondente (0-based, na
  // ordem do lote MANDADO ao banco, nao do lote original recebido no
  // corpo). Ausencia de linha pro idx e' "sem leitura nenhuma casando
  // placa/janela/raio" -- vira { temParadaComVelocidade: false, temCobertura:
  // false } (ver contrato no topo do arquivo), nunca erro.
  const porIdx = new Map<number, Resultado>();
  for (const linha of (data ?? []) as { idx: number; tem_parada_com_velocidade: boolean; tem_cobertura: boolean }[]) {
    porIdx.set(linha.idx, { temParadaComVelocidade: linha.tem_parada_com_velocidade, temCobertura: linha.tem_cobertura });
  }
  validasComIndiceOriginal.forEach(({ indiceOriginal }, idxNoLote) => {
    resultados[indiceOriginal] = porIdx.get(idxNoLote) ?? { temParadaComVelocidade: false, temCobertura: false };
  });

  return Response.json({ resultados });
}
