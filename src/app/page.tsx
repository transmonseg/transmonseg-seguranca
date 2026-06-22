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

// Central ao vivo: renderiza a cada acesso, nunca prerender estático.
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

function formatarTempo(iso: string): string {
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
/* Componentes de apresentacao                                          */
/* ------------------------------------------------------------------ */

function BadgeNivel({ nivel }: { nivel: NivelRisco }) {
  const cfg: Record<string, { cor: string; label: string }> = {
    vermelho: { cor: "var(--vermelho)", label: "Vermelho" },
    amarelo:  { cor: "var(--amarelo)",  label: "Atencao"  },
    verde:    { cor: "var(--verde)",    label: "Normal"   },
  };
  const { cor, label } = cfg[nivel] ?? { cor: "var(--text-muted)", label: nivel ?? "?" };
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
      style={{ backgroundColor: `${cor}22`, color: cor, border: `1px solid ${cor}44` }}
    >
      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: cor }} />
      {label}
    </span>
  );
}

function ChipResumo({
  label,
  valor,
  cor,
  icone,
}: {
  label: string;
  valor: number;
  cor?: string;
  icone: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-xl border"
      style={{
        backgroundColor: "var(--card)",
        borderColor: cor ? `${cor}33` : "var(--border)",
      }}
    >
      <span style={{ color: cor ?? "var(--accent)" }}>{icone}</span>
      <div>
        <p
          className="text-xl font-bold leading-none"
          style={{ color: cor ?? "var(--text)" }}
        >
          {valor}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          {label}
        </p>
      </div>
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
  // Resumo global
  // ------------------------------------------------------------------
  const veiculosComunicando = posicoes.length;
  const emAlertaVermelho = posicoes.filter((p) => p.nivel === "vermelho").length;
  const emAtencaoAmarelo  = posicoes.filter((p) => p.nivel === "amarelo").length;
  const parados = posicoes.filter((p) => !p.ignicao).length;

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

  // IDs de clientes para o filtro
  const clientesParaFiltro = [
    { id: "todos", nome: "Todos" },
    ...clientes.map((c) => ({ id: c.id, nome: c.nome })),
  ];

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div className="px-4 sm:px-6 py-6 max-w-screen-xl mx-auto space-y-8">

      {/* ============================================================
          RESUMO — chips de contagem
          ============================================================ */}
      <section aria-label="Resumo geral">
        <h2 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>
          Resumo geral
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ChipResumo
            label="Comunicando"
            valor={veiculosComunicando}
            icone={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            }
          />
          <ChipResumo
            label="Alerta vermelho"
            valor={emAlertaVermelho}
            cor="var(--vermelho)"
            icone={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            }
          />
          <ChipResumo
            label="Atencao"
            valor={emAtencaoAmarelo}
            cor="var(--amarelo)"
            icone={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            }
          />
          <ChipResumo
            label="Parados"
            valor={parados}
            icone={
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            }
          />
        </div>

        {/* Resumo por cliente */}
        {clientes.length > 0 && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {clientes.map((c) => {
              const r = resumoPorCliente[c.id];
              return (
                <div
                  key={c.id}
                  className="rounded-xl border px-4 py-3 flex items-center justify-between"
                  style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
                >
                  <span className="text-sm font-medium" style={{ color: "var(--text)" }}>{r.nome}</span>
                  <div className="flex items-center gap-3 text-xs" style={{ color: "var(--text-muted)" }}>
                    <span>{r.total} veic.</span>
                    {r.vermelho > 0 && (
                      <span className="font-semibold" style={{ color: "var(--vermelho)" }}>{r.vermelho} alert.</span>
                    )}
                    {r.parados > 0 && <span>{r.parados} parados</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ============================================================
          ALERTAS ATIVOS
          ============================================================ */}
      <section aria-label="Alertas ativos">
        <div className="flex items-center gap-2 mb-3">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: alertasEnriquecidos.length > 0 ? "var(--vermelho)" : "var(--verde)" }}
          />
          <h2 className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
            Alertas ativos
          </h2>
          {alertasEnriquecidos.length > 0 && (
            <span
              className="ml-1 px-2 py-0.5 rounded-full text-xs font-bold"
              style={{ backgroundColor: "var(--vermelho)22", color: "var(--vermelho)" }}
            >
              {alertasEnriquecidos.length}
            </span>
          )}
        </div>

        {alertasEnriquecidos.length === 0 ? (
          /* Estado vazio elegante */
          <div
            className="flex flex-col items-center justify-center gap-3 rounded-2xl border py-10 px-4 text-center"
            style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
          >
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--verde)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
              Nenhum alerta ativo no momento
            </p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Toda a frota opera dentro dos parametros normais.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {alertasEnriquecidos.map((a) => (
              <div
                key={a.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border px-4 py-3"
                style={{
                  backgroundColor: "var(--card)",
                  borderColor: a.nivel === "vermelho" ? "var(--vermelho)44" : "var(--amarelo)44",
                  borderLeftWidth: "3px",
                  borderLeftColor: a.nivel === "vermelho" ? "var(--vermelho)" : "var(--amarelo)",
                }}
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <BadgeNivel nivel={a.nivel} />
                  <span className="font-mono text-sm font-bold" style={{ color: "var(--text)" }}>
                    {a.placa}
                  </span>
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {a.clienteNome}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: "var(--border)", color: "var(--text-muted)" }}>
                    {a.tipo}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs" style={{ color: "var(--text-muted)" }}>
                  {a.motivo && (
                    <span style={{ color: "var(--text)" }}>{a.motivo}</span>
                  )}
                  <span>desde {formatarTempo(a.desde)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ============================================================
          FROTA — grid com filtro por cliente (Client Component)
          ============================================================ */}
      <section aria-label="Frota monitorada">
        <h2 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>
          Frota monitorada
        </h2>
        <FrotaGrid
          itens={frotaItems}
          clientes={clientesParaFiltro}
        />
      </section>

    </div>
  );
}
