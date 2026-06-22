/**
 * Pagina principal — Transmonseg Central
 *
 * Server Component que le dados do Supabase via createAdminClient (service_role).
 * O cliente ativo e determinado pelo query param ?cliente=<cod_user_unitrac>.
 * Toda a tela reflete somente o cliente selecionado.
 *
 * ESTRUTURA (Nova — Central de Atencao):
 * 1. Seletor de cliente
 * 2. Resumo: metricas + entregas do dia
 * 3. Alertas ativos (vermelho + amarelo)
 * 4. Em operacao (verde) — limitado a 36 cards, resto colapsavel
 * 5. Concluidos (concluido) — faixa colapsavel
 * 6. Sem comunicacao (cinza) — faixa colapsavel
 */

import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import CardVeiculoOperacao from "./components/CardVeiculoOperacao";
import FaixaColapsavel from "./components/FaixaColapsavel";
import VerTodosBtn from "./components/VerTodosBtn";

// Central ao vivo: nunca prerender estatico.
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* Tipos                                                                */
/* ------------------------------------------------------------------ */

type NivelDB = "verde" | "amarelo" | "vermelho" | "cinza" | "concluido";

interface Cliente {
  id: string;
  nome: string;
  cod_user_unitrac: string;
}

interface Veiculo {
  id: string;
  cliente_id: string;
  placa: string;
  cv: string;
}

interface PosicaoAtual {
  veiculo_id: string;
  velocidade: number;
  ignicao: boolean;
  atraso_min: number;
  panico: boolean;
  bau_aberto: boolean;
  nivel: NivelDB;
  motivo: string | null;
  local: string | null;
  entregas_feitas: number | null;
  entregas_total: number | null;
  parado_desde: string | null;
  updated_at: string;
}

interface Alerta {
  id: string;
  cliente_id: string;
  veiculo_id: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  status: string;
}

/* Item de veiculo enriquecido para render */
export interface VeiculoItem {
  id: string;
  placa: string;
  cv: string;
  nivel: NivelDB;
  motivo: string | null;
  velocidade: number;
  ignicao: boolean;
  atraso_min: number;
  panico: boolean;
  bau_aberto: boolean;
  local: string | null;
  entregas_feitas: number;
  entregas_total: number;
  parado_desde: string | null;
  updated_at: string | null;
}

/* ------------------------------------------------------------------ */
/* Helpers de formatacao                                                */
/* ------------------------------------------------------------------ */

function formatarTempoRelativo(iso: string): string {
  const data = new Date(iso);
  const agora = new Date();
  const diffMin = Math.floor((agora.getTime() - data.getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

/* ------------------------------------------------------------------ */
/* Icones SVG reutilizaveis                                             */
/* ------------------------------------------------------------------ */

function IconShield({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconSignal({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function IconAlertCircle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconTriangle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function IconTruck({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="15" height="13" />
      <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
    </svg>
  );
}

function IconJammer({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  );
}

function IconMapPin({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconPause({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function IconClock({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconCheck({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconNoSignal({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  );
}

function IconPackage({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Icone de tipo de alerta                                              */
/* ------------------------------------------------------------------ */

function IconTipoAlerta({ tipo }: { tipo: string }) {
  const t = tipo?.toLowerCase() ?? "";
  if (t.includes("jammer") || t.includes("sinal") || t.includes("bloqueio")) {
    return <IconJammer size={14} />;
  }
  if (t.includes("favela") || t.includes("area") || t.includes("risco") || t.includes("zona")) {
    return <IconMapPin size={14} />;
  }
  if (t.includes("parada") || t.includes("parado") || t.includes("longa")) {
    return <IconPause size={14} />;
  }
  return <IconAlertCircle size={14} />;
}

/* ------------------------------------------------------------------ */
/* Componente: SeletorCliente                                           */
/* ------------------------------------------------------------------ */

function SeletorCliente({
  clientes,
  clienteAtualId,
  veiculosPorCliente,
}: {
  clientes: Cliente[];
  clienteAtualId: string;
  veiculosPorCliente: Record<string, number>;
}) {
  return (
    <div
      className="rounded-2xl border p-1 flex items-stretch gap-1 flex-wrap sm:flex-nowrap"
      style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
      role="tablist"
      aria-label="Selecionar cliente"
    >
      {clientes.map((c) => {
        const ativo = c.id === clienteAtualId;
        const nVeics = veiculosPorCliente[c.id] ?? 0;
        return (
          <Link
            key={c.id}
            href={`?cliente=${c.cod_user_unitrac}`}
            role="tab"
            aria-selected={ativo}
            className="flex-1 min-w-[140px] flex items-center justify-between gap-3 px-5 py-3.5 rounded-xl transition-all duration-150 no-underline"
            style={
              ativo
                ? {
                    backgroundColor: "var(--accent-dim)",
                    border: "1px solid var(--accent)",
                    color: "var(--accent)",
                  }
                : {
                    backgroundColor: "transparent",
                    border: "1px solid transparent",
                    color: "var(--text-muted)",
                  }
            }
          >
            <div className="flex items-center gap-2.5">
              <span style={{ color: ativo ? "var(--accent)" : "var(--text-dim)" }}>
                <IconTruck size={15} />
              </span>
              <span
                className="text-sm font-semibold leading-none"
                style={{ color: ativo ? "var(--accent)" : "var(--text-muted)" }}
              >
                {c.nome}
              </span>
            </div>
            <span
              className="num-mono text-xs font-bold flex-shrink-0 px-2 py-0.5 rounded-md"
              style={{
                fontFamily: "var(--font-geist-mono, monospace)",
                backgroundColor: ativo
                  ? "color-mix(in srgb, var(--accent) 15%, transparent)"
                  : "var(--border)",
                color: ativo ? "var(--accent)" : "var(--text-dim)",
              }}
            >
              {nVeics}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componente: ChipMetrica                                              */
/* ------------------------------------------------------------------ */

function ChipMetrica({
  label,
  valor,
  cor,
  icone,
  sublabel,
}: {
  label: string;
  valor: string | number;
  cor?: string;
  icone: React.ReactNode;
  sublabel?: string;
}) {
  const corEfetiva = cor ?? "var(--accent)";
  return (
    <div
      className="relative flex flex-col gap-2.5 px-4 py-3.5 rounded-xl border overflow-hidden"
      style={{
        backgroundColor: "var(--card)",
        borderColor: cor ? `color-mix(in srgb, ${cor} 22%, var(--border))` : "var(--border)",
      }}
    >
      <div className="absolute top-0 left-0 right-0 h-px"
        style={{ backgroundColor: corEfetiva, opacity: cor ? 0.55 : 0.25 }} />

      <div className="flex items-center gap-2">
        <span style={{ color: corEfetiva }}>{icone}</span>
        <span className="text-xs font-medium uppercase tracking-widest"
          style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}>
          {label}
        </span>
      </div>

      <div>
        <p className="num-mono text-2xl font-bold leading-none"
          style={{ color: cor ? corEfetiva : "var(--text)", fontFamily: "var(--font-geist-mono, monospace)" }}>
          {valor}
        </p>
        {sublabel && (
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            {sublabel}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componente: RowAlerta                                                */
/* ------------------------------------------------------------------ */

function RowAlerta({
  nivel,
  tipo,
  placa,
  motivo,
  local,
  desde,
}: {
  nivel: "critico" | "atencao";
  tipo: string;
  placa: string;
  motivo: string | null;
  local: string | null;
  desde: string;
}) {
  const corNivel = nivel === "critico" ? "var(--vermelho)" : "var(--amarelo)";
  const bgNivel = nivel === "critico" ? "#1c0e0e" : "#1c150a";

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-xl border transition-colors"
      style={{
        backgroundColor: bgNivel,
        borderColor: `color-mix(in srgb, ${corNivel} 20%, var(--border))`,
        borderLeftWidth: "3px",
        borderLeftColor: corNivel,
      }}
    >
      <span
        className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5"
        style={{ backgroundColor: `color-mix(in srgb, ${corNivel} 12%, transparent)`, color: corNivel }}
      >
        <IconTipoAlerta tipo={tipo} />
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="num-mono text-sm font-bold tracking-wider leading-none"
            style={{ color: "var(--text)", fontFamily: "var(--font-geist-mono, monospace)" }}>
            {placa}
          </p>
          <span
            className="tag hidden sm:inline-flex"
            style={{ backgroundColor: `color-mix(in srgb, ${corNivel} 10%, transparent)`, color: corNivel, border: `1px solid color-mix(in srgb, ${corNivel} 25%, transparent)` }}
          >
            {tipo}
          </span>
        </div>

        {motivo && (
          <p className="text-xs mt-1 truncate" style={{ color: "var(--text-muted)" }}>
            {motivo}
          </p>
        )}

        {local && (
          <div className="flex items-center gap-1 mt-1">
            <span style={{ color: "var(--text-dim)" }}>
              <IconMapPin size={11} />
            </span>
            <p className="text-xs truncate" style={{ color: "var(--text-dim)" }}>
              {local}
            </p>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 flex items-center gap-1.5 mt-0.5" style={{ color: "var(--text-muted)" }}>
        <IconClock size={11} />
        <span className="num-mono text-xs" style={{ fontFamily: "var(--font-geist-mono, monospace)" }}>
          {formatarTempoRelativo(desde)}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componente: SectionLabel                                             */
/* ------------------------------------------------------------------ */

function SectionLabel({ children, dot }: { children: React.ReactNode; dot?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      {dot && (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: dot }} />
      )}
      <h2 className="text-xs font-semibold uppercase tracking-widest"
        style={{ color: "var(--text-muted)", letterSpacing: "0.12em" }}>
        {children}
      </h2>
      <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pagina principal                                                      */
/* ------------------------------------------------------------------ */

const LIMITE_CARDS_OPERACAO = 36;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { cliente: clienteParam } = await searchParams;
  const supabase = createAdminClient();

  const [
    { data: clientesRaw },
    { data: veiculosRaw },
    { data: posicoesRaw },
    { data: alertasRaw },
  ] = await Promise.all([
    supabase.from("clientes").select("id, nome, cod_user_unitrac").order("cod_user_unitrac"),
    supabase.from("veiculos").select("id, cliente_id, placa, cv"),
    supabase.from("posicoes_atuais").select(
      "veiculo_id, velocidade, ignicao, atraso_min, panico, bau_aberto, nivel, motivo, local, entregas_feitas, entregas_total, parado_desde, updated_at"
    ),
    supabase
      .from("alertas")
      .select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status")
      .eq("status", "ativo"),
  ]);

  const clientes: Cliente[] = clientesRaw ?? [];
  const todosVeiculos: Veiculo[] = veiculosRaw ?? [];
  const todasPosicoes: PosicaoAtual[] = (posicoesRaw ?? []) as PosicaoAtual[];
  const todosAlertas: Alerta[] = (alertasRaw ?? []) as Alerta[];

  // ── Determinar cliente ativo ──────────────────────────────────────
  const codParam = typeof clienteParam === "string" ? clienteParam : undefined;
  const clienteAtivo: Cliente =
    (codParam && clientes.find((c) => c.cod_user_unitrac === codParam)) ||
    clientes[0];

  const veiculosPorCliente: Record<string, number> = {};
  for (const c of clientes) {
    veiculosPorCliente[c.id] = todosVeiculos.filter((v) => v.cliente_id === c.id).length;
  }

  // ── Filtrar para cliente ativo ────────────────────────────────────
  const veiculos = todosVeiculos.filter((v) => v.cliente_id === clienteAtivo.id);
  const veiculoIds = new Set(veiculos.map((v) => v.id));

  const posicaoPorVeiculo = new Map(
    todasPosicoes
      .filter((p) => veiculoIds.has(p.veiculo_id))
      .map((p) => [p.veiculo_id, p])
  );

  const alertas = todosAlertas.filter((a) => a.cliente_id === clienteAtivo.id);
  const veiculoById = new Map(veiculos.map((v) => [v.id, v]));

  // ── Construir itens enriquecidos ──────────────────────────────────
  const todosItens: VeiculoItem[] = veiculos.map((v) => {
    const pos = posicaoPorVeiculo.get(v.id);
    return {
      id: v.id,
      placa: v.placa,
      cv: v.cv,
      nivel: (pos?.nivel ?? "cinza") as NivelDB,
      motivo: pos?.motivo ?? null,
      velocidade: pos?.velocidade ?? 0,
      ignicao: pos?.ignicao ?? false,
      atraso_min: pos?.atraso_min ?? 9999,
      panico: pos?.panico ?? false,
      bau_aberto: pos?.bau_aberto ?? false,
      local: pos?.local ?? null,
      entregas_feitas: pos?.entregas_feitas ?? 0,
      entregas_total: pos?.entregas_total ?? 0,
      parado_desde: pos?.parado_desde ?? null,
      updated_at: pos?.updated_at ?? null,
    };
  });

  // ── Separar por nivel ─────────────────────────────────────────────
  const emOperacaoRaw = todosItens
    .filter((i) => i.nivel === "verde")
    .sort((a, b) => {
      // Em movimento primeiro
      const aMovendo = a.velocidade > 0 ? 0 : 1;
      const bMovendo = b.velocidade > 0 ? 0 : 1;
      if (aMovendo !== bMovendo) return aMovendo - bMovendo;
      // Depois por entregas pendentes (mais pendentes = mais relevante)
      const aPendentes = a.entregas_total - a.entregas_feitas;
      const bPendentes = b.entregas_total - b.entregas_feitas;
      return bPendentes - aPendentes;
    });

  const emOperacaoVisiveis = emOperacaoRaw.slice(0, LIMITE_CARDS_OPERACAO);
  const emOperacaoOcultos = emOperacaoRaw.slice(LIMITE_CARDS_OPERACAO);

  const concluidos = todosItens.filter((i) => i.nivel === "concluido");
  const semComunicacao = todosItens.filter((i) => i.nivel === "cinza");
  const emAlerta = todosItens.filter(
    (i) => i.nivel === "vermelho" || i.nivel === "amarelo"
  );

  // ── Metricas ──────────────────────────────────────────────────────
  const totalEmOperacao = emOperacaoRaw.length;
  const totalAlertas = emAlerta.length;
  const totalConcluidos = concluidos.length;
  const totalSemCom = semComunicacao.length;

  // Entregas do dia (soma do cliente)
  const entregasFeitas = todosItens.reduce((s, i) => s + i.entregas_feitas, 0);
  const entregasTotal = todosItens.reduce((s, i) => s + i.entregas_total, 0);
  const entregasFaltam = entregasTotal - entregasFeitas;

  // Alertas enriquecidos com placa + local
  const alertasEnriquecidos = alertas
    .map((a) => {
      const veiculo = veiculoById.get(a.veiculo_id);
      const pos = posicaoPorVeiculo.get(a.veiculo_id);
      return {
        ...a,
        placa: veiculo?.placa ?? "?????",
        local: pos?.local ?? null,
      };
    })
    .sort((a, b) => {
      if (a.nivel === "critico" && b.nivel !== "critico") return -1;
      if (a.nivel !== "critico" && b.nivel === "critico") return 1;
      return 0;
    });

  /* --------------------------------------------------------------- */
  /* Render                                                           */
  /* --------------------------------------------------------------- */

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-screen-xl mx-auto space-y-8">

      {/* ============================================================
          1. SELETOR DE CLIENTE
          ============================================================ */}
      <section aria-label="Selecionar cliente">
        <div className="mb-2 flex items-center gap-2" style={{ color: "var(--text-dim)" }}>
          <IconShield size={12} />
          <span className="text-xs font-medium uppercase tracking-widest" style={{ letterSpacing: "0.1em" }}>
            Cliente ativo
          </span>
        </div>
        <SeletorCliente
          clientes={clientes}
          clienteAtualId={clienteAtivo.id}
          veiculosPorCliente={veiculosPorCliente}
        />
      </section>

      {/* ============================================================
          2. RESUMO — metricas + entregas do dia
          ============================================================ */}
      <section aria-label="Resumo operacional">
        <SectionLabel>Resumo operacional</SectionLabel>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <ChipMetrica
            label="Em operacao"
            valor={totalEmOperacao}
            icone={<IconSignal size={14} />}
            sublabel="nivel verde"
          />
          <ChipMetrica
            label="Alertas"
            valor={totalAlertas}
            cor={totalAlertas > 0 ? "var(--vermelho)" : undefined}
            icone={<IconAlertCircle size={14} />}
            sublabel="vermelho + amarelo"
          />
          <ChipMetrica
            label="Concluidos"
            valor={totalConcluidos}
            cor="var(--verde)"
            icone={<IconCheck size={14} />}
            sublabel="rota encerrada"
          />
          <ChipMetrica
            label="Sem sinal"
            valor={totalSemCom}
            cor={totalSemCom > 0 ? "var(--text-dim)" : undefined}
            icone={<IconNoSignal size={14} />}
            sublabel="sem comunicacao"
          />
          {/* Entregas do dia — ocupa 2 colunas em telas grandes */}
          <div
            className="relative flex flex-col gap-2.5 px-4 py-3.5 rounded-xl border overflow-hidden col-span-2 sm:col-span-1 lg:col-span-1"
            style={{ backgroundColor: "var(--card)", borderColor: "color-mix(in srgb, var(--accent) 20%, var(--border))" }}
          >
            <div className="absolute top-0 left-0 right-0 h-px"
              style={{ backgroundColor: "var(--accent)", opacity: 0.4 }} />

            <div className="flex items-center gap-2">
              <span style={{ color: "var(--accent)" }}><IconPackage size={14} /></span>
              <span className="text-xs font-medium uppercase tracking-widest"
                style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}>
                Entregas do dia
              </span>
            </div>

            {entregasTotal > 0 ? (
              <>
                <p className="num-mono text-2xl font-bold leading-none"
                  style={{ color: "var(--accent)", fontFamily: "var(--font-geist-mono, monospace)" }}>
                  {entregasFeitas}
                  <span className="text-base font-medium" style={{ color: "var(--text-muted)" }}>
                    {" "}/{" "}{entregasTotal}
                  </span>
                </p>
                {/* Barra de progresso */}
                <div className="w-full rounded-full overflow-hidden" style={{ height: "4px", backgroundColor: "var(--border)" }}>
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, Math.round((entregasFeitas / entregasTotal) * 100))}%`,
                      backgroundColor: "var(--verde)",
                    }}
                  />
                </div>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {entregasFaltam > 0 ? `faltam ${entregasFaltam}` : "todas concluidas"}
                </p>
              </>
            ) : (
              <p className="text-xs" style={{ color: "var(--text-dim)" }}>
                sem dados de entrega
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ============================================================
          3. ALERTAS ATIVOS (vermelho + amarelo)
          ============================================================ */}
      <section aria-label="Alertas ativos">
        <div className="flex items-center gap-3 mb-4">
          {alertasEnriquecidos.length > 0 ? (
            <span
              className="animate-pulse-alert w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: "var(--vermelho)" }}
            />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: "var(--verde)" }} />
          )}
          <h2 className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: "var(--text-muted)", letterSpacing: "0.12em" }}>
            Alertas ativos
          </h2>
          {alertasEnriquecidos.length > 0 && (
            <span
              className="num-mono px-2 py-0.5 rounded text-xs font-bold"
              style={{
                backgroundColor: "color-mix(in srgb, var(--vermelho) 15%, transparent)",
                color: "var(--vermelho)",
                border: "1px solid color-mix(in srgb, var(--vermelho) 25%, transparent)",
                fontFamily: "var(--font-geist-mono, monospace)",
              }}
            >
              {alertasEnriquecidos.length}
            </span>
          )}
          <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
        </div>

        {alertasEnriquecidos.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-3 rounded-xl border py-10 px-4 text-center"
            style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
          >
            <span
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ backgroundColor: "color-mix(in srgb, var(--verde) 10%, transparent)", color: "var(--verde)" }}
            >
              <IconCheck size={18} />
            </span>
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                Nenhum alerta ativo
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                Toda a frota opera dentro dos parametros normais.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {alertasEnriquecidos.map((a) => (
              <RowAlerta
                key={a.id}
                nivel={a.nivel}
                tipo={a.tipo}
                placa={a.placa}
                motivo={a.motivo}
                local={a.local}
                desde={a.desde}
              />
            ))}
          </div>
        )}
      </section>

      {/* ============================================================
          4. EM OPERACAO (verde) — limitado a 36
          ============================================================ */}
      <section aria-label="Veiculos em operacao">
        <SectionLabel dot="var(--verde)">
          Em operacao
          {totalEmOperacao > 0 && (
            <span className="ml-2 num-mono" style={{ fontFamily: "var(--font-geist-mono, monospace)", color: "var(--verde)" }}>
              {totalEmOperacao}
            </span>
          )}
        </SectionLabel>

        {totalEmOperacao === 0 ? (
          <div
            className="flex items-center justify-center py-12 rounded-xl border text-sm"
            style={{ backgroundColor: "var(--card)", borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            Nenhum veiculo em operacao no momento.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {emOperacaoVisiveis.map((item) => (
                <CardVeiculoOperacao key={item.id} item={item} />
              ))}
            </div>

            {emOperacaoOcultos.length > 0 && (
              <VerTodosBtn totalOcultos={emOperacaoOcultos.length}>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                  {emOperacaoOcultos.map((item) => (
                    <CardVeiculoOperacao key={item.id} item={item} />
                  ))}
                </div>
              </VerTodosBtn>
            )}
          </>
        )}
      </section>

      {/* ============================================================
          5. CONCLUIDOS — faixa colapsavel
          ============================================================ */}
      <section aria-label="Veiculos concluidos">
        <SectionLabel dot="var(--verde)">Concluidos</SectionLabel>
        <FaixaColapsavel
          label="concluidos (rota encerrada)"
          count={totalConcluidos}
          cor="var(--verde)"
          icone={<IconCheck size={14} />}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {concluidos.map((item) => (
              <CardVeiculoOperacao key={item.id} item={item} />
            ))}
          </div>
        </FaixaColapsavel>
        {totalConcluidos === 0 && (
          <div
            className="flex items-center gap-3 rounded-xl border px-4 py-3"
            style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
          >
            <span style={{ color: "var(--text-dim)" }}><IconCheck size={14} /></span>
            <span className="text-xs" style={{ color: "var(--text-dim)" }}>
              Nenhum veiculo com rota encerrada.
            </span>
          </div>
        )}
      </section>

      {/* ============================================================
          6. SEM COMUNICACAO — faixa colapsavel
          ============================================================ */}
      <section aria-label="Veiculos sem comunicacao">
        <SectionLabel dot="var(--text-dim)">Sem comunicacao</SectionLabel>
        <FaixaColapsavel
          label="sem comunicacao"
          count={totalSemCom}
          icone={<IconNoSignal size={14} />}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {semComunicacao.map((item) => (
              <CardVeiculoOperacao key={item.id} item={item} />
            ))}
          </div>
        </FaixaColapsavel>
        {totalSemCom === 0 && (
          <div
            className="flex items-center gap-3 rounded-xl border px-4 py-3"
            style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
          >
            <span style={{ color: "var(--text-dim)" }}><IconNoSignal size={14} /></span>
            <span className="text-xs" style={{ color: "var(--text-dim)" }}>
              Todos os veiculos com comunicacao ativa.
            </span>
          </div>
        )}
      </section>

    </div>
  );
}
