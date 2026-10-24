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
  agruparPorColunas, ehPontoRQ, enviadoPorRQ, lerLinhasRQ, motivoParaNaoSubstituirRQ, planejarDiaRQ, type PontoRQ,
} from "@/lib/romaneio-rioquality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mesma chave do /upload (migration 059): romaneio_data,placa,nf,modo_teste,origem.
const CHAVE_UNICA_ROMANEIO_PONTOS = "romaneio_data,placa,nf,modo_teste,origem";
const COLUNAS_PONTO = "id, placa, nf, veiculo_id, cliente_codigo, cliente_nome, endereco_bruto, lat, lng, geocode_status, presenca_confirmada_em, enviado_por, criado_em";
const LOTE = 500;
const LOTE_IDS = 200;
const PAGINA = 1000;

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

  let comPedidoErp: boolean;
  let comPresencaMetodo: boolean;
  let existentes: PontoRQ[];
  try {
    comPedidoErp = await temColunaPedidoErp(admin);
    comPresencaMetodo = await temColunaPresencaMetodo(admin);
    existentes = await pontosRQDoDia(admin, data, comPedidoErp);
  } catch (err) {
    return Response.json({ ok: false, erro: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  // F2-04-a: envio vazio ou encolhido nao apaga o dia (vira "so' acrescenta").
  const aviso = pediuSubstituir ? motivoParaNaoSubstituirRQ(existentes, linhas) : null;
  if (aviso) console.error(`${new Date().toISOString()} [romaneio/rioquality] ${data}: substituir recusado -- ${aviso}`);
  const substituir = pediuSubstituir && !aviso;
  const recusa = aviso ? { substituicaoRecusada: true, aviso } : {};
  const plano = planejarDiaRQ({ data, existentes, linhas, substituir, veiculoPorPlaca, enviadoPor, comPedidoErp, comPresencaMetodo });
  if (body?.simular === true) {
    return Response.json({ ok: true, simulado: true, romaneioData: data, existentes: existentes.length, inserir: plano.inserir.length, atualizar: plano.atualizar.length, apagar: plano.apagar.length, placasNaoEncontradas, ...recusa });
  }

  // Ordem: apagar (duplicatas e o que saiu), atualizar, inserir -- uma NF que
  // muda de numero (pedido -> NF real) nunca bate numa duplicata ainda viva.
  const falhou = (etapa: string, msg: string) => Response.json({ ok: false, erro: `Erro ao ${etapa}: ${msg}` }, { status: 500 });
  let linhasApagadas = 0;
  for (let i = 0; i < plano.apagar.length; i += LOTE_IDS) {
    const { data: ap, error } = await admin.from("romaneio_pontos").delete().in("id", plano.apagar.slice(i, i + LOTE_IDS)).select("id");
    if (error) return falhou("apagar", error.message);
    linhasApagadas += ap?.length ?? 0;
  }
  let linhasAtualizadas = 0;
  for (const grupo of agruparPorColunas(plano.atualizar)) {
    for (let i = 0; i < grupo.length; i += LOTE) {
      const lote = grupo.slice(i, i + LOTE);
      const { error } = await admin.from("romaneio_pontos").upsert(lote, { onConflict: "id" });
      if (error) return falhou("atualizar", error.message);
      linhasAtualizadas += lote.length;
    }
  }
  let linhasInseridas = 0;
  for (let i = 0; i < plano.inserir.length; i += LOTE) {
    const { data: ins, error } = await admin
      .from("romaneio_pontos")
      .upsert(plano.inserir.slice(i, i + LOTE), { onConflict: CHAVE_UNICA_ROMANEIO_PONTOS, ignoreDuplicates: true })
      .select("id");
    if (error) return falhou("salvar", error.message);
    linhasInseridas += ins?.length ?? 0;
  }

  return Response.json({
    ok: true, romaneioData: data, linhasInseridas, linhasAtualizadas, linhasApagadas,
    linhasDoDia: existentes.length - linhasApagadas + linhasInseridas, placasNaoEncontradas, ...recusa,
  });
}
