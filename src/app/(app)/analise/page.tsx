import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const LABEL_TIPO: Record<string, string> = {
  panico: "Panico",
  desvio: "Desvio de rota",
  parada_anomala: "Parada anômala",
  parada_longa: "Parada longa",
  parada_cliente: "Parada em cliente",
  favela: "Área de risco",
  jammer: "Jammer",
  tiroteio: "Área de tiroteio",
  excesso_velocidade: "Excesso de velocidade",
  sem_comunicacao: "Sem comunicação",
};

const COR_TIPO: Record<string, string> = {
  panico: "#ef4444",
  desvio: "#f59e0b",
  parada_anomala: "#f97316",
  parada_longa: "#64748b",
  parada_cliente: "#3b82f6",
  favela: "#dc2626",
  jammer: "#a855f7",
  tiroteio: "#b91c1c",
  excesso_velocidade: "#ea580c",
  sem_comunicacao: "#78716c",
};

const LABEL_STATUS: Record<string, string> = {
  ativo: "Ativo",
  reconhecido: "Em atendimento",
  resolvido: "Resolvido",
  falso_positivo: "Falso positivo",
};

const COR_STATUS: Record<string, string> = {
  ativo: "#ef4444",
  reconhecido: "#f59e0b",
  resolvido: "#22c55e",
  falso_positivo: "#6b7280",
};

function tempoAteResolver(desde: string, resolvido_em: string | null): string {
  if (!resolvido_em) return "em aberto";
  const diff = new Date(resolvido_em).getTime() - new Date(desde).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "< 1min";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatarQuando(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type AlertaRow = {
  id: string;
  nivel: string;
  tipo: string;
  status: string;
  desde: string;
  resolvido_em: string | null;
  motivo: string | null;
  veiculos: { placa: string } | null;
};

export default async function AnalisePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const dias        = Math.max(1, Math.min(90, parseInt((params.dias as string) ?? "30")));
  const tipoFiltro  = (params.tipo as string)   || null;
  const nivelFiltro = (params.nivel as string)  || null;
  const statusFiltro = (params.status as string) || null;

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await admin
    .from("alertas")
    .select("id, nivel, tipo, status, desde, resolvido_em, motivo, veiculos(placa)")
    .gte("desde", cutoff)
    .order("desde", { ascending: false })
    .limit(500);

  const todos = (data ?? []) as unknown as AlertaRow[];
  const filtrados = todos
    .filter((r) => !tipoFiltro   || r.tipo   === tipoFiltro)
    .filter((r) => !nivelFiltro  || r.nivel  === nivelFiltro)
    .filter((r) => !statusFiltro || r.status === statusFiltro);

  const total = filtrados.length;
  const criticos = filtrados.filter((r) => r.nivel === "critico").length;
  const resolvidos = filtrados.filter(
    (r) => r.status === "resolvido" || r.status === "falso_positivo"
  ).length;
  const falsos = filtrados.filter((r) => r.status === "falso_positivo").length;

  const porTipo = new Map<string, number>();
  for (const r of filtrados) {
    porTipo.set(r.tipo, (porTipo.get(r.tipo) ?? 0) + 1);
  }
  const tiposOrdenados = [...porTipo.entries()].sort((a, b) => b[1] - a[1]);
  const maxTipo = tiposOrdenados[0]?.[1] ?? 1;

  const porPlaca = new Map<string, { count: number; tiposCont: Map<string, number> }>();
  for (const r of filtrados) {
    const placa = r.veiculos?.placa ?? "?";
    const entry = porPlaca.get(placa) ?? { count: 0, tiposCont: new Map() };
    entry.count++;
    entry.tiposCont.set(r.tipo, (entry.tiposCont.get(r.tipo) ?? 0) + 1);
    porPlaca.set(placa, entry);
  }
  const topVeiculos = [...porPlaca.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([placa, d]) => ({
      placa,
      count: d.count,
      tipoFreq: [...d.tiposCont.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?",
    }));

  // Helpers de URL que preservam todos os filtros ativos
  function buildHref(overrides: {
    dias?: number;
    tipo?: string | null;
    nivel?: string | null;
    status?: string | null;
  } = {}) {
    const d  = overrides.dias   !== undefined ? overrides.dias   : dias;
    const ti = overrides.tipo   !== undefined ? overrides.tipo   : tipoFiltro;
    const ni = overrides.nivel  !== undefined ? overrides.nivel  : nivelFiltro;
    const st = overrides.status !== undefined ? overrides.status : statusFiltro;
    const p  = new URLSearchParams({ dias: String(d) });
    if (ti) p.set("tipo",   ti);
    if (ni) p.set("nivel",  ni);
    if (st) p.set("status", st);
    return `/analise?${p.toString()}`;
  }

  // Contagens de todos os dados (sem filtros) para os badges
  const contTodos = todos;
  function contNivel(n: string)  { return contTodos.filter((r) => r.nivel  === n).length; }
  function contStatus(s: string) { return contTodos.filter((r) => r.status === s).length; }

  const temFiltroAtivo = !!(tipoFiltro || nivelFiltro || statusFiltro);

  return (
    <div
      className="max-w-6xl mx-auto px-6 py-8 space-y-8"
      style={{ color: "var(--text)" }}
    >
      {/* Cabecalho: titulo + filtros */}
      <div className="space-y-4">
        {/* Linha 1: titulo + periodo */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Análise histórica</h2>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              {total} alerta{total !== 1 ? "s" : ""} nos últimos {dias} dias
              {temFiltroAtivo && (
                <span style={{ color: "var(--accent)" }}> &bull; filtros ativos</span>
              )}
            </p>
          </div>

          {/* Seletor de periodo */}
          <div className="flex items-center gap-1">
            {[7, 14, 30].map((d) => (
              <Link
                key={d}
                href={buildHref({ dias: d })}
                className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                style={{
                  backgroundColor: dias === d ? "var(--accent-dim)" : "var(--card)",
                  color: dias === d ? "var(--accent)" : "var(--text-muted)",
                  border: `1px solid ${dias === d ? "var(--accent)" : "var(--border)"}`,
                }}
              >
                {d} dias
              </Link>
            ))}
          </div>
        </div>

        {/* Linha 2: chips de filtro */}
        <div
          className="flex flex-wrap items-center gap-1.5 p-3 rounded-xl"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          {/* Grupo: Nivel */}
          <span className="text-xs uppercase tracking-widest leading-none mr-1" style={{ color: "var(--text-dim)", fontSize: "9px" }}>
            Nível
          </span>
          {(["critico", "atencao"] as const).map((n) => {
            const ativo = nivelFiltro === n;
            const cor   = n === "critico" ? "#ef4444" : "#f59e0b";
            const cnt   = contNivel(n);
            return (
              <Link
                key={n}
                href={buildHref({ nivel: ativo ? null : n })}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors"
                style={ativo
                  ? { backgroundColor: cor + "22", border: `1px solid ${cor}`, color: cor }
                  : { backgroundColor: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)" }
                }
              >
                {n === "critico" ? "Crítico" : "Atenção"}
                {cnt > 0 && (
                  <span style={{ fontSize: "9px", fontWeight: 700, backgroundColor: cor + "33", color: cor, borderRadius: "999px", padding: "0 3px", minWidth: "15px", height: "15px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    {cnt}
                  </span>
                )}
              </Link>
            );
          })}

          {/* Divider */}
          <div style={{ width: "1px", height: "20px", backgroundColor: "var(--border)", flexShrink: 0, margin: "0 4px" }} />

          {/* Grupo: Status */}
          <span className="text-xs uppercase tracking-widest leading-none mr-1" style={{ color: "var(--text-dim)", fontSize: "9px" }}>
            Status
          </span>
          {(["ativo", "reconhecido", "resolvido", "falso_positivo"] as const).map((s) => {
            const ativo  = statusFiltro === s;
            const cor    = COR_STATUS[s] ?? "var(--text-muted)";
            const cnt    = contStatus(s);
            const label  = LABEL_STATUS[s] ?? s;
            return (
              <Link
                key={s}
                href={buildHref({ status: ativo ? null : s })}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors"
                style={ativo
                  ? { backgroundColor: cor + "22", border: `1px solid ${cor}`, color: cor }
                  : { backgroundColor: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)" }
                }
              >
                {label}
                {cnt > 0 && (
                  <span style={{ fontSize: "9px", fontWeight: 700, backgroundColor: cor + "33", color: cor, borderRadius: "999px", padding: "0 3px", minWidth: "15px", height: "15px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    {cnt}
                  </span>
                )}
              </Link>
            );
          })}

          {/* Limpar tudo */}
          {temFiltroAtivo && (
            <>
              <div style={{ width: "1px", height: "20px", backgroundColor: "var(--border)", flexShrink: 0, margin: "0 4px" }} />
              <Link
                href={buildHref({ tipo: null, nivel: null, status: null })}
                className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg"
                style={{ color: "var(--text-dim)" }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Limpar
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Cards de resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Total de alertas", valor: total, cor: "var(--text)" },
          { label: "Críticos", valor: criticos, cor: "#ef4444" },
          { label: "Resolvidos", valor: resolvidos, cor: "#22c55e" },
          { label: "Falsos positivos", valor: falsos, cor: "#6b7280" },
        ].map(({ label, valor, cor }) => (
          <div
            key={label}
            className="rounded-xl p-5"
            style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
          >
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {label}
            </p>
            <p className="text-3xl font-bold mt-1 tabular-nums" style={{ color: cor }}>
              {valor}
            </p>
            {total > 0 && (
              <p className="text-xs mt-1" style={{ color: "var(--text-dim)" }}>
                {Math.round((valor / total) * 100)}% do total
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Linha: Barras por tipo + Top veiculos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Barras por tipo */}
        <div
          className="rounded-xl p-6"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          <h3 className="text-sm font-semibold mb-4">Alertas por tipo</h3>
          {tiposOrdenados.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Nenhum alerta no período.
            </p>
          ) : (
            <div className="space-y-3">
              {tiposOrdenados.map(([tipo, qtd]) => {
                const cor = COR_TIPO[tipo] ?? "#64748b";
                const pct = Math.round((qtd / maxTipo) * 100);
                const ativo = tipoFiltro === tipo;
                return (
                  <Link
                    key={tipo}
                    href={buildHref({ tipo: ativo ? null : tipo })}
                    className="block group"
                    title={ativo ? "Remover filtro" : `Filtrar por ${LABEL_TIPO[tipo] ?? tipo}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className="text-xs"
                        style={{ color: ativo ? cor : "var(--text-muted)" }}
                      >
                        {LABEL_TIPO[tipo] ?? tipo}
                      </span>
                      <span className="text-xs font-semibold tabular-nums" style={{ color: cor }}>
                        {qtd}
                      </span>
                    </div>
                    <div
                      className="h-2 rounded-full overflow-hidden"
                      style={{ backgroundColor: "var(--bg)" }}
                    >
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: cor,
                          opacity: ativo ? 1 : 0.7,
                        }}
                      />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Top veiculos */}
        <div
          className="rounded-xl p-6"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          <h3 className="text-sm font-semibold mb-4">Top veículos por alertas</h3>
          {topVeiculos.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Nenhum dado no período.
            </p>
          ) : (
            <div className="space-y-3">
              {topVeiculos.map(({ placa, count, tipoFreq }, i) => {
                const corTipo = COR_TIPO[tipoFreq] ?? "#64748b";
                const pctBar = Math.round((count / (topVeiculos[0]?.count ?? 1)) * 100);
                return (
                  <div key={placa} className="flex items-center gap-3">
                    <span
                      className="text-xs font-bold tabular-nums w-5 text-right flex-shrink-0"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-mono font-semibold tracking-widest">
                          {placa}
                        </span>
                        <div className="flex items-center gap-2">
                          <span
                            className="text-xs px-1.5 py-0.5 rounded"
                            style={{
                              backgroundColor: `${corTipo}22`,
                              color: corTipo,
                              fontSize: "10px",
                            }}
                          >
                            {LABEL_TIPO[tipoFreq] ?? tipoFreq}
                          </span>
                          <span
                            className="text-xs font-semibold tabular-nums"
                            style={{ color: "var(--text)" }}
                          >
                            {count}
                          </span>
                        </div>
                      </div>
                      <div
                        className="h-1.5 rounded-full overflow-hidden"
                        style={{ backgroundColor: "var(--bg)" }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${pctBar}%`, backgroundColor: "var(--accent)" }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Tabela historica */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ border: "1px solid var(--border)" }}
      >
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ backgroundColor: "var(--card)", borderBottom: "1px solid var(--border)" }}
        >
          <h3 className="text-sm font-semibold">Histórico de alertas</h3>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {filtrados.length > 100
              ? `mostrando 100 de ${filtrados.length}`
              : `${filtrados.length} registros`}
          </span>
        </div>

        {filtrados.length === 0 ? (
          <div
            className="px-6 py-12 text-center"
            style={{ backgroundColor: "var(--bg)" }}
          >
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Nenhum alerta no período selecionado.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto" style={{ backgroundColor: "var(--bg)" }}>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Tipo", "Placa", "Quando", "Status", "Tempo até resolver"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 font-medium"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtrados.slice(0, 100).map((r, idx) => {
                  const cor = COR_TIPO[r.tipo] ?? "#64748b";
                  const corSt = COR_STATUS[r.status] ?? "var(--text-muted)";
                  return (
                    <tr
                      key={r.id}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        backgroundColor: idx % 2 === 0 ? "transparent" : "var(--card)",
                      }}
                    >
                      <td className="px-4 py-3">
                        <span
                          className="inline-flex items-center gap-1.5"
                          style={{ color: cor }}
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: cor }}
                          />
                          {LABEL_TIPO[r.tipo] ?? r.tipo}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono font-semibold tracking-widest">
                        {r.veiculos?.placa ?? "?"}
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: "var(--text-muted)" }}>
                        {formatarQuando(r.desde)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="px-2 py-0.5 rounded text-xs"
                          style={{
                            backgroundColor: `${corSt}22`,
                            color: corSt,
                          }}
                        >
                          {LABEL_STATUS[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: "var(--text-muted)" }}>
                        {tempoAteResolver(r.desde, r.resolvido_em)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
