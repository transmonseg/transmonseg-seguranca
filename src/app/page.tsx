/**
 * Pagina principal — Transmonseg Central
 *
 * Server Component que le dados do Supabase via createAdminClient (service_role).
 * Motivo: as tabelas tem RLS habilitado mas sem policies ativas, entao o cliente
 * anonimo nao consegue ler. Quando a fase de autenticacao for implementada, isto
 * sera substituido pelo cliente anonimo + policies RLS adequadas.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import FrotaGrid from "./components/FrotaGrid";

// Central ao vivo: renderiza a cada acesso, nunca prerender estatico.
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* Tipos                                                                */
/* ------------------------------------------------------------------ */

type NivelRisco = "verde" | "amarelo" | "vermelho";

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
  lat: number;
  lng: number;
  velocidade: number;
  ignicao: boolean;
  atraso_min: number;
  panico: boolean;
  bau_aberto: boolean;
  nivel: NivelRisco;
  motivo: string | null;
  parado_desde: string | null;
  updated_at: string;
}

interface Alerta {
  id: string;
  cliente_id: string;
  veiculo_id: string;
  nivel: NivelRisco;
  tipo: string;
  motivo: string | null;
  desde: string;
  status: string;
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

function IconPause({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
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
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
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
/* Componente: MetricaDestaque                                          */
/* ------------------------------------------------------------------ */

function MetricaDestaque({
  label,
  valor,
  cor,
  icone,
  sublabel,
}: {
  label: string;
  valor: number;
  cor?: string;
  icone: React.ReactNode;
  sublabel?: string;
}) {
  const corEfetiva = cor ?? "var(--accent)";
  return (
    <div
      className="relative flex flex-col gap-3 px-5 py-4 rounded-xl border overflow-hidden"
      style={{
        backgroundColor: "var(--card)",
        borderColor: cor ? `color-mix(in srgb, ${cor} 25%, var(--border))` : "var(--border)",
      }}
    >
      {/* Faixa de acento no topo */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{ backgroundColor: corEfetiva, opacity: cor ? 0.6 : 0.3 }}
      />

      {/* Icone + label */}
      <div className="flex items-center gap-2">
        <span style={{ color: corEfetiva }}>{icone}</span>
        <span className="text-xs font-medium uppercase tracking-widest" style={{ color: "var(--text-muted)", letterSpacing: "0.1em" }}>
          {label}
        </span>
      </div>

      {/* Numero grande */}
      <div>
        <p
          className="num-mono text-3xl font-bold leading-none"
          style={{ color: cor ? corEfetiva : "var(--text)", fontFamily: "var(--font-geist-mono, monospace)" }}
        >
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
/* Componente: PainelCliente                                            */
/* ------------------------------------------------------------------ */

function PainelCliente({
  nome,
  total,
  vermelho,
  amarelo,
  parados,
}: {
  nome: string;
  total: number;
  vermelho: number;
  amarelo: number;
  parados: number;
}) {
  const ativos = total - parados;
  const pctVermelho = total > 0 ? (vermelho / total) * 100 : 0;
  const pctAmarelo = total > 0 ? (amarelo / total) * 100 : 0;
  const pctAtivos = total > 0 ? (ativos / total) * 100 : 0;

  return (
    <div
      className="rounded-xl border px-5 py-4 flex flex-col gap-3"
      style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
    >
      {/* Cabecalho do painel */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span style={{ color: "var(--accent)" }}>
            <IconTruck size={14} />
          </span>
          <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            {nome}
          </span>
        </div>
        <span
          className="num-mono text-xl font-bold"
          style={{ color: "var(--text)", fontFamily: "var(--font-geist-mono, monospace)" }}
        >
          {total}
        </span>
      </div>

      {/* Barra de composicao */}
      <div className="h-1.5 rounded-full overflow-hidden flex" style={{ backgroundColor: "var(--border)" }}>
        {pctVermelho > 0 && (
          <div className="h-full rounded-full" style={{ width: `${pctVermelho}%`, backgroundColor: "var(--vermelho)" }} />
        )}
        {pctAmarelo > 0 && (
          <div className="h-full" style={{ width: `${pctAmarelo}%`, backgroundColor: "var(--amarelo)" }} />
        )}
        {pctAtivos > 0 && (
          <div className="h-full" style={{ width: `${Math.max(0, pctAtivos - pctVermelho - pctAmarelo)}%`, backgroundColor: "var(--verde)", opacity: 0.4 }} />
        )}
      </div>

      {/* Indicadores */}
      <div className="flex items-center gap-4 flex-wrap">
        {vermelho > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: "var(--vermelho)" }} />
            <span className="num-mono text-xs font-semibold" style={{ color: "var(--vermelho)", fontFamily: "var(--font-geist-mono, monospace)" }}>
              {vermelho} critico{vermelho > 1 ? "s" : ""}
            </span>
          </div>
        )}
        {amarelo > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: "var(--amarelo)" }} />
            <span className="num-mono text-xs font-semibold" style={{ color: "var(--amarelo)", fontFamily: "var(--font-geist-mono, monospace)" }}>
              {amarelo} atencao
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {parados} parado{parados !== 1 ? "s" : ""}
          </span>
        </div>
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
  clienteNome,
  motivo,
  desde,
}: {
  nivel: NivelRisco;
  tipo: string;
  placa: string;
  clienteNome: string;
  motivo: string | null;
  desde: string;
}) {
  const corNivel = nivel === "vermelho" ? "var(--vermelho)" : "var(--amarelo)";
  const bgNivel = nivel === "vermelho" ? "#1c0e0e" : "#1c150a";

  return (
    <div
      className="flex items-center gap-4 px-4 py-3 rounded-xl border transition-colors"
      style={{
        backgroundColor: bgNivel,
        borderColor: `color-mix(in srgb, ${corNivel} 20%, var(--border))`,
        borderLeftWidth: "3px",
        borderLeftColor: corNivel,
      }}
    >
      {/* Icone do tipo */}
      <span
        className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: `color-mix(in srgb, ${corNivel} 12%, transparent)`, color: corNivel }}
      >
        <IconTipoAlerta tipo={tipo} />
      </span>

      {/* Placa + cliente */}
      <div className="flex-shrink-0 min-w-[90px]">
        <p
          className="num-mono text-sm font-bold tracking-wider leading-none"
          style={{ color: "var(--text)", fontFamily: "var(--font-geist-mono, monospace)" }}
        >
          {placa}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          {clienteNome}
        </p>
      </div>

      {/* Tag do tipo */}
      <div className="hidden sm:flex flex-shrink-0">
        <span
          className="tag"
          style={{ backgroundColor: `color-mix(in srgb, ${corNivel} 10%, transparent)`, color: corNivel, border: `1px solid color-mix(in srgb, ${corNivel} 25%, transparent)` }}
        >
          {tipo}
        </span>
      </div>

      {/* Motivo */}
      {motivo && (
        <p className="flex-1 text-xs truncate" style={{ color: "var(--text-muted)" }}>
          {motivo}
        </p>
      )}

      {/* Tempo */}
      <div className="flex-shrink-0 flex items-center gap-1.5 ml-auto" style={{ color: "var(--text-muted)" }}>
        <IconClock size={12} />
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
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: dot }}
        />
      )}
      <h2
        className="text-xs font-semibold uppercase tracking-widest"
        style={{ color: "var(--text-muted)", letterSpacing: "0.12em" }}
      >
        {children}
      </h2>
      <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pagina principal                                                      */
/* ------------------------------------------------------------------ */

export default async function DashboardPage() {
  const supabase = createAdminClient();

  // Busca paralela de todas as entidades necessarias
  const [
    { data: clientesRaw },
    { data: veiculosRaw },
    { data: posicoesRaw },
    { data: alertasRaw },
  ] = await Promise.all([
    supabase.from("clientes").select("id, nome, cod_user_unitrac"),
    supabase.from("veiculos").select("id, cliente_id, placa, cv"),
    supabase.from("posicoes_atuais").select(
      "veiculo_id, lat, lng, velocidade, ignicao, atraso_min, panico, bau_aberto, nivel, motivo, parado_desde, updated_at"
    ),
    supabase.from("alertas").select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status").eq("status", "ativo"),
  ]);

  const clientes: Cliente[] = clientesRaw ?? [];
  const veiculos: Veiculo[] = veiculosRaw ?? [];
  const posicoes: PosicaoAtual[] = posicoesRaw ?? [];
  const alertas: Alerta[] = alertasRaw ?? [];

  // Indices rapidos
  const clienteById = new Map(clientes.map((c) => [c.id, c]));
  const veiculoById = new Map(veiculos.map((v) => [v.id, v]));
  const posicaoPorVeiculo = new Map(posicoes.map((p) => [p.veiculo_id, p]));

  // ------------------------------------------------------------------
  // Metricas globais
  // ------------------------------------------------------------------
  const totalFrota = veiculos.length;
  const veiculosComunicando = posicoes.length;
  const emAlertaVermelho = posicoes.filter((p) => p.nivel === "vermelho").length;
  const emAtencaoAmarelo  = posicoes.filter((p) => p.nivel === "amarelo").length;
  const parados = posicoes.filter((p) => !p.ignicao).length;
  const semComunicacao = totalFrota - veiculosComunicando;

  // Resumo por cliente
  const resumoPorCliente: Record<
    string,
    { nome: string; total: number; vermelho: number; amarelo: number; parados: number }
  > = {};
  for (const cliente of clientes) {
    const veicsDeste = veiculos.filter((v) => v.cliente_id === cliente.id);
    const posDeste = veicsDeste.map((v) => posicaoPorVeiculo.get(v.id)).filter(Boolean) as PosicaoAtual[];
    resumoPorCliente[cliente.id] = {
      nome: cliente.nome,
      total:    posDeste.length,
      vermelho: posDeste.filter((p) => p.nivel === "vermelho").length,
      amarelo:  posDeste.filter((p) => p.nivel === "amarelo").length,
      parados:  posDeste.filter((p) => !p.ignicao).length,
    };
  }

  // ------------------------------------------------------------------
  // Dados de frota para o grid (enriquecidos)
  // ------------------------------------------------------------------
  const frotaItems = veiculos
    .map((v) => {
      const pos = posicaoPorVeiculo.get(v.id);
      const cliente = clienteById.get(v.cliente_id);
      return {
        id: v.id,
        placa: v.placa,
        cv: v.cv,
        clienteNome: cliente?.nome ?? "Desconhecido",
        clienteId: v.cliente_id,
        nivel: (pos?.nivel ?? "verde") as NivelRisco,
        motivo: pos?.motivo ?? null,
        velocidade: pos?.velocidade ?? 0,
        atraso_min: pos?.atraso_min ?? 0,
        ignicao: pos?.ignicao ?? false,
        panico: pos?.panico ?? false,
        bau_aberto: pos?.bau_aberto ?? false,
        parado_desde: pos?.parado_desde ?? null,
        updated_at: pos?.updated_at ?? null,
        semComunicacao: !pos,
      };
    })
    .sort((a, b) => {
      const ordem: Record<NivelRisco, number> = { vermelho: 0, amarelo: 1, verde: 2 };
      return ordem[a.nivel] - ordem[b.nivel];
    });

  // Alertas enriquecidos
  const alertasEnriquecidos = alertas.map((a) => {
    const veiculo = veiculoById.get(a.veiculo_id);
    const cliente = clienteById.get(a.cliente_id);
    return {
      ...a,
      placa: veiculo?.placa ?? "?????",
      clienteNome: cliente?.nome ?? "Desconhecido",
    };
  });

  // Ordenar alertas: vermelho primeiro
  alertasEnriquecidos.sort((a, b) => {
    if (a.nivel === "vermelho" && b.nivel !== "vermelho") return -1;
    if (a.nivel !== "vermelho" && b.nivel === "vermelho") return 1;
    return 0;
  });

  // IDs de clientes para o filtro
  const clientesParaFiltro = [
    { id: "todos", nome: "Todos" },
    ...clientes.map((c) => ({ id: c.id, nome: c.nome })),
  ];

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-screen-xl mx-auto space-y-10">

      {/* ============================================================
          PAINEL DE STATUS — metricas chave
          ============================================================ */}
      <section aria-label="Status operacional">
        <SectionLabel>Status operacional</SectionLabel>

        {/* Grid de metricas */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <MetricaDestaque
            label="Monitorados"
            valor={veiculosComunicando}
            sublabel={`${totalFrota} total na frota`}
            icone={<IconSignal size={15} />}
          />
          <MetricaDestaque
            label="Criticos"
            valor={emAlertaVermelho}
            cor={emAlertaVermelho > 0 ? "var(--vermelho)" : undefined}
            sublabel="alerta vermelho"
            icone={<IconAlertCircle size={15} />}
          />
          <MetricaDestaque
            label="Atencao"
            valor={emAtencaoAmarelo}
            cor={emAtencaoAmarelo > 0 ? "var(--amarelo)" : undefined}
            sublabel="nivel amarelo"
            icone={<IconTriangle size={15} />}
          />
          <MetricaDestaque
            label="Parados"
            valor={parados}
            sublabel={semComunicacao > 0 ? `+ ${semComunicacao} sem sinal` : "ignicao desligada"}
            icone={<IconPause size={15} />}
          />
        </div>

        {/* Paineis por cliente */}
        {clientes.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {clientes.map((c) => {
              const r = resumoPorCliente[c.id];
              return (
                <PainelCliente
                  key={c.id}
                  nome={r.nome}
                  total={r.total}
                  vermelho={r.vermelho}
                  amarelo={r.amarelo}
                  parados={r.parados}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ============================================================
          ALERTAS ATIVOS
          ============================================================ */}
      <section aria-label="Alertas ativos">
        <div className="flex items-center gap-3 mb-4">
          {/* Ponto pulsante quando ha alertas criticos */}
          {alertasEnriquecidos.length > 0 ? (
            <span
              className="animate-pulse-alert w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: "var(--vermelho)" }}
            />
          ) : (
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: "var(--verde)" }}
            />
          )}
          <h2
            className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: "var(--text-muted)", letterSpacing: "0.12em" }}
          >
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
          /* Estado vazio elegante */
          <div
            className="flex flex-col items-center justify-center gap-4 rounded-xl border py-12 px-4 text-center"
            style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
          >
            <span
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ backgroundColor: "color-mix(in srgb, var(--verde) 10%, transparent)", color: "var(--verde)" }}
            >
              <IconCheck size={20} />
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
                clienteNome={a.clienteNome}
                motivo={a.motivo}
                desde={a.desde}
              />
            ))}
          </div>
        )}
      </section>

      {/* ============================================================
          FROTA — grid com filtro por cliente (Client Component)
          ============================================================ */}
      <section aria-label="Frota monitorada">
        <SectionLabel>
          Frota monitorada
        </SectionLabel>
        <FrotaGrid
          itens={frotaItems}
          clientes={clientesParaFiltro}
        />
      </section>

    </div>
  );
}
