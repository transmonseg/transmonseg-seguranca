import { createAdminClient } from "@/lib/supabase/admin";
import MonitorV2 from "../central-v2/MonitorV2";
import GateRomaneio from "./GateRomaneio";
import AvisoEscalaPao from "./AvisoEscalaPao";

// Espelha src/app/(app)/page.tsx (a Central), mas lê alertas_romaneio em vez
// de alertas — pipeline de detecção paralelo alimentado pelo romaneio (spec
// 2026-08-22-motor-romaneio-paralelo). Objetivo: comparar as duas fontes
// lado a lado. alertas_romaneio não tem coluna modo_teste (ver migration
// 055), por isso não há esse filtro aqui.
export const dynamic = "force-dynamic";

interface Cliente { id: string; nome: string; cod_user_unitrac: string; }
interface Veiculo { id: string; cliente_id: string; placa: string; cv: string; }
interface PosicaoAtual { veiculo_id: string; lat: number | null; lng: number | null; velocidade: number; ignicao: boolean; atraso_min: number; local: string | null; }
interface Alerta { id: string; cliente_id: string; veiculo_id: string; nivel: "critico" | "atencao"; tipo: string; motivo: string | null; desde: string; status: string; score: number | null; lat: number | null; lng: number | null; contexto: { rota_concluida?: unknown; progresso_destino?: { delta_m: number }; placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> }; calibracao?: { segmento: string | null; taxa_falso_positivo: number } } | null; }

// Data de HOJE em São Paulo. NUNCA current_date do Postgres: o servidor roda
// em CEST (UTC+2) e o Brasil é UTC-3 -- o dia do banco vira 5h antes do dia
// brasileiro. Mesmo padrão do motor (api/motor-romaneio) e do
// RomaneioStatusBadge.
function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function ordemSeveridade(tipo: string): number {
  const t = tipo?.toLowerCase() ?? "";
  if (t === "panico") return 0; if (t === "bau") return 1; if (t === "favela") return 2;
  if (t === "tiroteio") return 3; if (t === "ignicao_noturna") return 4;
  if (t === "saida_nao_autorizada") return 5; if (t === "parada_cliente") return 6;
  if (t === "parada_anomala") return 7; if (t === "parada_longa") return 8;
  if (t === "desvio" || t === "excesso" || t === "parada_fora_tapete") return 9;
  if (t === "jammer" || t.includes("sinal") || t.includes("bloqueio")) return 11;
  return 10;
}

export default async function CentralRomaneioPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { cliente: clienteParam } = await searchParams;
  const supabase = createAdminClient();
  const hoje = hojeSP();

  // ── Gate do dia ──────────────────────────────────────────────────────
  // Pedido do usuário 23/08: entrar aqui sem o romaneio do dia mostra a tela
  // de envio, não um mapa vazio. Critério IDÊNTICO ao que o motor usa pra
  // decidir se tem o que processar (api/motor-romaneio/route.ts): mesma data
  // de SP, modo_teste = false, veiculo_id NOT NULL. Se divergisse, a tela
  // diria "tem romaneio" enquanto o motor não gera alerta nenhum.
  const COLUNAS_ALERTAS_ROMANEIO = "id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status, score, lat, lng, contexto";

  const [
    { data: clientesRaw },
    { data: veiculosRaw },
    { data: posicoesRaw },
    { data: alertasRawComSombra, error: erroAlertasComSombra },
    contagemComVeiculo,
    contagemHoje,
    contagemEscalaPao,
  ] = await Promise.all([
    supabase.from("clientes").select("id, nome, cod_user_unitrac").order("cod_user_unitrac"),
    supabase.from("veiculos").select("id, cliente_id, placa, cv"),
    supabase.from("posicoes_atuais").select("veiculo_id, lat, lng, velocidade, ignicao, atraso_min, local"),
    // sombra=false filtra pra fora panico/jammer/excesso em shadow mode
    // (Task Fase 4 Incremento 1, 27/08 -- ver motor-romaneio/route.ts,
    // TIPOS_SOMBRA). `sombra` só existe a partir da migration contabo/062;
    // se ainda não foi aplicada, PostgREST erra por coluna inexistente e o
    // fallback abaixo repete sem o filtro (mesmo padrão do tratamento de
    // `origem` logo adiante nesta função).
    supabase.from("alertas_romaneio").select(COLUNAS_ALERTAS_ROMANEIO).in("status", ["ativo", "reconhecido"]).eq("sombra", false),
    supabase.from("romaneio_pontos").select("id", { count: "exact", head: true })
      .eq("romaneio_data", hoje).eq("modo_teste", false).not("veiculo_id", "is", null),
    supabase.from("romaneio_pontos").select("id", { count: "exact", head: true })
      .eq("romaneio_data", hoje).eq("modo_teste", false),
    // `origem` só existe a partir da migration 059 -- antes dela esta
    // consulta devolve erro de coluna inexistente. Nesse caso a resposta
    // honesta é "não dá pra saber", e um aviso que não dá pra sustentar não
    // aparece (ver tratamento de erro logo abaixo).
    supabase.from("romaneio_pontos").select("id", { count: "exact", head: true })
      .eq("romaneio_data", hoje).eq("modo_teste", false).eq("origem", "escala_pao"),
  ]);

  const alertasRaw = erroAlertasComSombra
    ? (await supabase.from("alertas_romaneio").select(COLUNAS_ALERTAS_ROMANEIO).in("status", ["ativo", "reconhecido"])).data
    : alertasRawComSombra;

  // Falha de consulta abre o mapa (fail-open) em vez de mostrar o gate: um
  // gate por erro de banco tirava do operador uma tela que ele já poderia
  // estar usando. Sem romaneio o mapa só fica sem pontos de entrega.
  const pontosComVeiculoHoje = contagemComVeiculo.error ? 1 : (contagemComVeiculo.count ?? 0);
  const linhasHoje = contagemHoje.error ? 0 : (contagemHoje.count ?? 0);
  const escalaPaoConhecida = !contagemEscalaPao.error;
  const temEscalaPaoHoje = (contagemEscalaPao.count ?? 0) > 0;

  if (pontosComVeiculoHoje === 0) {
    return <GateRomaneio hoje={hoje} linhasHojeSemVeiculo={linhasHoje} />;
  }

  const clientes: Cliente[] = clientesRaw ?? [];
  const todosVeiculos: Veiculo[] = veiculosRaw ?? [];
  const todasPosicoes: PosicaoAtual[] = (posicoesRaw ?? []) as PosicaoAtual[];
  const todosAlertas: Alerta[] = (alertasRaw ?? []) as Alerta[];

  const codParam = typeof clienteParam === "string" ? clienteParam : undefined;
  const clienteAtivo: Cliente = (codParam && clientes.find(c => c.cod_user_unitrac === codParam)) || clientes[0];
  if (!clienteAtivo) return null;

  const veiculos = todosVeiculos.filter(v => v.cliente_id === clienteAtivo.id);
  const veiculoIds = new Set(veiculos.map(v => v.id));
  const posicaoPorVeiculo = new Map(todasPosicoes.filter(p => veiculoIds.has(p.veiculo_id)).map(p => [p.veiculo_id, p]));
  const veiculoById = new Map(veiculos.map(v => [v.id, v]));

  const enriquecer = (a: Alerta) => {
    const v = veiculoById.get(a.veiculo_id);
    const p = posicaoPorVeiculo.get(a.veiculo_id);
    return {
      ...a,
      cv: v?.cv ?? "", placa: v?.placa ?? "?????", local: p?.local ?? null,
      // lat/lng = posição ATUAL do veículo (posicoes_atuais); origemLat/Lng =
      // ponto de ORIGEM do próprio alerta (para "desvio": onde começou).
      lat: p?.lat ?? null, lng: p?.lng ?? null,
      origemLat: a.lat, origemLng: a.lng,
      velocidade: p?.velocidade ?? null, ignicao: p?.ignicao ?? null, atraso_min: p?.atraso_min ?? null,
      rotaConcluida: (a.contexto as { rota_concluida?: unknown } | null)?.rota_concluida != null,
      progressoDestinoM: (a.contexto as { progresso_destino?: { delta_m: number } } | null)?.progresso_destino?.delta_m ?? null,
      placarSombra: (a.contexto as { placar_sombra?: { placar: number; componentes: Record<string, number | boolean | string> } } | null)?.placar_sombra ?? null,
      calibracao: (a.contexto as { calibracao?: { segmento: string | null; taxa_falso_positivo: number } } | null)?.calibracao ?? null,
      contexto: undefined,
    };
  };

  const alertasIniciais = [
    ...todosAlertas.filter(a => a.cliente_id === clienteAtivo.id && a.nivel === "critico").map(enriquecer).sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo)),
    ...todosAlertas.filter(a => a.cliente_id === clienteAtivo.id && a.nivel === "atencao").map(enriquecer).sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo)),
  ];

  const monitor = (
    <MonitorV2
      key={clienteAtivo.id}
      cliente={clienteAtivo.cod_user_unitrac}
      clientes={clientes.map(c => ({ id: c.id, nome: c.nome, cod: c.cod_user_unitrac }))}
      clienteAtivoId={clienteAtivo.id}
      veiculos={veiculos.map(v => ({ placa: v.placa, cv: v.cv }))}
      alertasIniciais={alertasIniciais}
      fonteAlertas="romaneio"
      hrefBaseClientes="/central-romaneio"
    />
  );

  // Sem aviso, o MonitorV2 continua sendo o filho direto do <main> (que é
  // flex-1 min-h-0 overflow-y-auto) -- exatamente como antes. Com aviso, o
  // wrapper h-full flex-col dá ao monitor um trilho de altura definida
  // (flex-1 min-h-0), então o height:100% dele resolve contra a sobra da
  // faixa em vez de estourar o <main> e criar scrollbar dupla.
  if (!escalaPaoConhecida || temEscalaPaoHoje) return monitor;

  return (
    <div className="h-full flex flex-col">
      <AvisoEscalaPao hoje={hoje} />
      <div className="flex-1 min-h-0">{monitor}</div>
    </div>
  );
}
