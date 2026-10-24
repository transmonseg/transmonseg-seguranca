// src/app/api/romaneio/rioquality/route.ts
//
// Ponte estruturada KPI -> Monitoramento para a Rio Quality. A RQ não sobe
// PDF/planilha; o KPI (Fusion ou planilha manual do Ao vivo) manda as linhas
// do romaneio já lidas por este endpoint, servidor-a-servidor (x-motor-key),
// com a DATA do dia FIXA (nunca inferida de texto). Linha sem coordenada
// entra com geocode_status 'pendente' (o cron geocodifica, igual ao /upload);
// com a coordenada que o KPI já resolveu, entra pronta ('ok').
//
// F2-04 (plano mestre 23/10): reconciliação pela NF (src/lib/romaneio-rioquality.ts).
// - modo "substituir": o dia da RQ fica igual ao que veio (o upload manual
//   troca a versão da Fusion). Só linhas gravadas por esta ponte (marca no
//   enviado_por) são tocadas, nunca pela origem nem pela frota (F2-REV-09:
//   ponto da Nutry com placa de veículo da RQ era apagado a cada tick).
// - sem modo (KPI antigo): só acrescenta e corrige NF reatribuída a outro carro.
// - simular: devolve o plano sem gravar (teste a seco / backfill).
// F2-02: campos estruturados (rua, numero, bairro, cidade, uf, cep) viram o
// endereço no formato que o parser lê; enderecoBruto pronto continua aceito.
// F2-04-b (revisão Fase 2): só o KPI (x-motor-key) chama esta rota. Login do
// monitoramento não entra -- uma conta de um cliente só (operadores.cliente_id)
// apagaria o dia da RQ com {linhas: [], modo: "substituir"}. Nenhuma tela usa
// a rota.
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizarPlaca } from "@/lib/romaneio";
import {
  agruparPorColunas, ehPontoRQ, enviadoPorRQ, lerLinhasRQ, motivoParaNaoSubstituirRQ, planejarDiaRQ, type LinhaRQ, type PlanoRQ, type PontoRQ,
} from "@/lib/romaneio-rioquality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mesma chave do /upload (migration 059): romaneio_data,placa,nf,modo_teste,origem.
const CHAVE_UNICA_ROMANEIO_PONTOS = "romaneio_data,placa,nf,modo_teste,origem";
const COLUNAS_PONTO = "id, placa, nf, veiculo_id, cliente_codigo, cliente_nome, endereco_bruto, lat, lng, geocode_status, presenca_confirmada_em, enviado_por, criado_em";
const LOTE = 500;
const LOTE_IDS = 200;
const PAGINA = 1000;
const MAX_TENTATIVAS_23505 = 3;

// Revisao Fase 2 (F2-04-d): apagar/atualizar/inserir vao em comandos
// separados do PostgREST, sem transacao. Dois envios do mesmo dia ao mesmo
// tempo (tick da Fusion + upload manual, ou dois ticks) liam o mesmo dia,
// planejavam os mesmos inserts e o segundo batia no indice parcial da 089
// (23505): o dia ficava pela metade (o que ja' tinha sido apagado nao voltava).
// Escolha: fila em memoria por dia -- o monitoramento roda num processo so'
// do pm2 (transmonseg-definitivo, fork_mode, conferido 24/10), entao a fila
// serializa todo envio real. Funcao/advisory lock no banco esta' fora (regra:
// nao criar funcoes). A rede para o que escapa da fila (outro processo, script
// manual) e' a retentativa: 23505 rele o dia e reconcilia de novo (o plano e'
// idempotente), ate' MAX_TENTATIVAS_23505 vezes.
const filaPorDia = new Map<string, Promise<unknown>>();
async function serializarPorDia<T>(chave: string, fn: () => Promise<T>): Promise<T> {
  const anterior = filaPorDia.get(chave) ?? Promise.resolve();
  const atual = anterior.catch(() => undefined).then(fn);
  const cauda = atual.catch(() => undefined);
  filaPorDia.set(chave, cauda);
  try {
    return await atual;
  } finally {
    if (filaPorDia.get(chave) === cauda) filaPorDia.delete(chave);
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

type Admin = ReturnType<typeof createAdminClient>;

/** A coluna pedido_erp vem da migration 089 (PENDENTE). Antes dela o
 *  endpoint segue sem gravar o pedido. */
async function temColunaPedidoErp(admin: Admin): Promise<boolean> {
  const { error } = await admin.from("romaneio_pontos").select("id, pedido_erp").limit(1);
  return !error;
}

/** F2-10-a: presenca_metodo vem da migration 088 (PENDENTE). Com ela, NF que
 *  muda de carro zera o metodo junto com a presenca. */
async function temColunaPresencaMetodo(admin: Admin): Promise<boolean> {
  const { error } = await admin.from("romaneio_pontos").select("id, presenca_metodo").limit(1);
  return !error;
}

async function pontosRQDoDia(admin: Admin, data: string, comPedidoErp: boolean): Promise<PontoRQ[]> {
  const cols = comPedidoErp ? `${COLUNAS_PONTO}, pedido_erp` : COLUNAS_PONTO;
  const todos: PontoRQ[] = [];
  for (let i = 0; ; i += PAGINA) {
    const { data: rs, error } = await admin.from("romaneio_pontos").select(cols)
      .eq("romaneio_data", data).eq("modo_teste", false).eq("origem", "romaneio")
      .order("id").range(i, i + PAGINA - 1);
    if (error) throw new Error(`pontos do dia: ${error.message}`);
    const pagina = (rs ?? []) as unknown as PontoRQ[];
    todos.push(...pagina);
    if (pagina.length < PAGINA) break;
  }
  return todos.filter((p) => ehPontoRQ(p));
}

export async function POST(request: Request) {
  const chaveMotor = request.headers.get("x-motor-key");
  const viaKpi = !!chaveMotor && !!process.env.MOTOR_SECRET && chaveMotor === process.env.MOTOR_SECRET;
  if (!viaKpi) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { data?: unknown; linhas?: unknown; modo?: unknown; simular?: unknown } | null;
  const data = str(body?.data);
  const brutas = Array.isArray(body?.linhas) ? (body!.linhas as unknown[]) : null;
  // data YYYY-MM-DD; linhas tem que ser array.
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !brutas) {
    return Response.json({ ok: false, erro: "Payload inválido (data YYYY-MM-DD + linhas[])." }, { status: 400 });
  }
  const pediuSubstituir = body?.modo === "substituir";
  const linhas = lerLinhasRQ(brutas);

  const admin = createAdminClient();
  const placasUnicas = [...new Set(linhas.map((l) => l.placa))];
  const { data: veiculos } = placasUnicas.length
    ? await admin.from("veiculos").select("id, placa").in("placa", placasUnicas)
    : { data: [] as { id: string; placa: string }[] };
  const veiculoPorPlaca = new Map((veiculos ?? []).map((v) => [normalizarPlaca(v.placa as string), v.id as string]));
  const placasNaoEncontradas = placasUnicas.filter((p) => !veiculoPorPlaca.has(p));
  const enviadoPor = enviadoPorRQ(request.headers.get("x-enviado-por"));

  // F2-04-d: um envio por dia de cada vez neste processo (ver serializarPorDia).
  return serializarPorDia(`rioquality:${data}`, () => reconciliarDia({
    admin, data, linhas, pediuSubstituir, simular: body?.simular === true, veiculoPorPlaca, placasNaoEncontradas, enviadoPor,
  }));
}

type ErroBanco = { code?: string; message: string };
type Aplicacao = { erro: { etapa: string; e: ErroBanco } | null; apagadas: number; atualizadas: number; inseridas: number };

/** Ordem: apagar (duplicatas e o que saiu), atualizar, inserir -- uma NF que
 *  muda de numero (pedido -> NF real) nunca bate numa duplicata ainda viva.
 *  Sem transacao (PostgREST): para no primeiro erro e devolve o que ja' fez. */
async function aplicarPlano(admin: Admin, plano: PlanoRQ): Promise<Aplicacao> {
  const r: Aplicacao = { erro: null, apagadas: 0, atualizadas: 0, inseridas: 0 };
  for (let i = 0; i < plano.apagar.length; i += LOTE_IDS) {
    const { data: ap, error } = await admin.from("romaneio_pontos").delete().in("id", plano.apagar.slice(i, i + LOTE_IDS)).select("id");
    if (error) return { ...r, erro: { etapa: "apagar", e: error } };
    r.apagadas += ap?.length ?? 0;
  }
  for (const grupo of agruparPorColunas(plano.atualizar)) {
    for (let i = 0; i < grupo.length; i += LOTE) {
      const lote = grupo.slice(i, i + LOTE);
      const { error } = await admin.from("romaneio_pontos").upsert(lote, { onConflict: "id" });
      if (error) return { ...r, erro: { etapa: "atualizar", e: error } };
      r.atualizadas += lote.length;
    }
  }
  for (let i = 0; i < plano.inserir.length; i += LOTE) {
    const { data: ins, error } = await admin
      .from("romaneio_pontos")
      .upsert(plano.inserir.slice(i, i + LOTE), { onConflict: CHAVE_UNICA_ROMANEIO_PONTOS, ignoreDuplicates: true })
      .select("id");
    if (error) return { ...r, erro: { etapa: "salvar", e: error } };
    r.inseridas += ins?.length ?? 0;
  }
  return r;
}

async function reconciliarDia(p: {
  admin: Admin; data: string; linhas: LinhaRQ[]; pediuSubstituir: boolean; simular: boolean;
  veiculoPorPlaca: Map<string, string>; placasNaoEncontradas: string[]; enviadoPor: string;
}): Promise<Response> {
  const { admin, data, linhas, pediuSubstituir, veiculoPorPlaca, placasNaoEncontradas, enviadoPor } = p;
  let comPedidoErp: boolean;
  let comPresencaMetodo: boolean;
  try {
    comPedidoErp = await temColunaPedidoErp(admin);
    comPresencaMetodo = await temColunaPresencaMetodo(admin);
  } catch (err) {
    return Response.json({ ok: false, erro: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  let linhasApagadas = 0;
  let linhasAtualizadas = 0;
  let linhasInseridas = 0;
  for (let tentativa = 1; ; tentativa++) {
    let existentes: PontoRQ[];
    try {
      existentes = await pontosRQDoDia(admin, data, comPedidoErp);
    } catch (err) {
      return Response.json({ ok: false, erro: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
    // F2-04-a: envio vazio ou encolhido nao apaga o dia (vira "so' acrescenta").
    const aviso = pediuSubstituir ? motivoParaNaoSubstituirRQ(existentes, linhas) : null;
    if (aviso && tentativa === 1) console.error(`${new Date().toISOString()} [romaneio/rioquality] ${data}: substituir recusado -- ${aviso}`);
    const substituir = pediuSubstituir && !aviso;
    const recusa = aviso ? { substituicaoRecusada: true, aviso } : {};
    const plano = planejarDiaRQ({ data, existentes, linhas, substituir, veiculoPorPlaca, enviadoPor, comPedidoErp, comPresencaMetodo });
    if (p.simular) {
      return Response.json({ ok: true, simulado: true, romaneioData: data, existentes: existentes.length, inserir: plano.inserir.length, atualizar: plano.atualizar.length, apagar: plano.apagar.length, placasNaoEncontradas, ...recusa });
    }

    const ap = await aplicarPlano(admin, plano);
    linhasApagadas += ap.apagadas;
    linhasAtualizadas += ap.atualizadas;
    linhasInseridas += ap.inseridas;
    if (ap.erro) {
      // F2-04-d: 23505 = outro escritor gravou a mesma NF da RQ (indice parcial
      // da 089) entre a leitura e a gravacao. O plano e' idempotente: rele o
      // dia e reconcilia de novo (a linha dele vira "atualizar").
      if (ap.erro.e.code === "23505" && tentativa < MAX_TENTATIVAS_23505) {
        console.error(`${new Date().toISOString()} [romaneio/rioquality] ${data}: 23505 ao ${ap.erro.etapa} (tentativa ${tentativa}) -- relendo o dia`);
        continue;
      }
      return Response.json({ ok: false, erro: `Erro ao ${ap.erro.etapa}: ${ap.erro.e.message}`, linhasInseridas, linhasAtualizadas, linhasApagadas }, { status: 500 });
    }
    return Response.json({
      ok: true, romaneioData: data, linhasInseridas, linhasAtualizadas, linhasApagadas,
      linhasDoDia: existentes.length - ap.apagadas + ap.inseridas, placasNaoEncontradas, ...recusa,
      ...(tentativa > 1 ? { retentativas: tentativa - 1 } : {}),
    });
  }
}
