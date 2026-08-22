import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { apurarQualidade, type ResumoQualidade } from "@/lib/qualidade-tratamento";

export const dynamic = "force-dynamic";

const TZ = "America/Sao_Paulo";

const LABEL_TIPO: Record<string, string> = {
  panico: "Pânico",
  bau: "Báu aberto",
  saida_nao_autorizada: "Saída não autorizada",
  desvio: "Desvio em movimento",
  parada_fora_tapete: "Parada fora do esperado",
  parada_anomala: "Parada anômala",
  parada_longa: "Parada longa",
  parada_cliente: "Parada em cliente",
  favela: "Área de risco",
  jammer: "Jammer",
  tiroteio: "Área de tiroteio",
  excesso: "Excesso de velocidade",
  excesso_velocidade: "Excesso de velocidade",
  sem_comunicacao: "Sem comunicação",
};

const COR_TIPO: Record<string, string> = {
  panico: "#ef4444",
  bau: "#f43f5e",
  saida_nao_autorizada: "#f97316",
  desvio: "#f59e0b",
  parada_anomala: "#fb923c",
  parada_longa: "#64748b",
  parada_cliente: "#3b82f6",
  favela: "#dc2626",
  jammer: "#a855f7",
  tiroteio: "#b91c1c",
  excesso: "#ea580c",
  excesso_velocidade: "#ea580c",
  sem_comunicacao: "#78716c",
};

const LABEL_STATUS: Record<string, string> = {
  ativo: "Ativo",
  reconhecido: "Em atendimento",
  resolvido: "Resolvido",
  falso_positivo: "Falso positivo",
  // Status novo (28/07): "Limpar avisos" tira da tela sem revisao caso a
  // caso (ver limparVarios em acoes-alertas.ts) -- visivel como aba propria
  // (o operador precisa achar essas linhas), mas rotulado de forma que nao
  // se confunda com "Resolvido" (que implica veredito humano de verdade).
  limpo: "Limpo (sem revisão)",
};

const COR_STATUS: Record<string, string> = {
  ativo: "#ef4444",
  reconhecido: "#f59e0b",
  resolvido: "#22c55e",
  falso_positivo: "#6b7280",
  // Azul neutro, distinto do verde (resolvido) e do cinza (falso_positivo)
  // -- nem "sucesso" nem "descartado", so "fora da tela".
  limpo: "#0ea5e9",
};

const NOMES_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function tempoAteResolver(desde: string, resolvido_em: string | null): string {
  if (!resolvido_em) return "em aberto";
  const diff = new Date(resolvido_em).getTime() - new Date(desde).getTime();
  return formatarMin(Math.round(diff / 60000));
}

function formatarMin(min: number): string {
  if (min < 1) return "< 1min";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatarQuando(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Hora local de Brasília (0-23)
function horaBR(iso: string): number {
  const h = new Date(iso).toLocaleString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    hour12: false,
  });
  return Number(h) % 24;
}

// Dia da semana de Brasília (0=Dom … 6=Sáb)
function diaSemanaBR(iso: string): number {
  const wd = new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" });
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

// Chave de dia "DD/MM" no fuso de Brasília
function chaveDiaBR(d: Date): string {
  return d.toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
}

type AlertaRow = {
  id: string;
  nivel: string;
  tipo: string;
  status: string;
  desde: string;
  resolvido_em: string | null;
  motivo: string | null;
  operador_id: string | null;
  veiculos: { placa: string } | null;
};

type AlertaAnt = {
  nivel: string;
  tipo: string;
  status: string;
  desde: string;
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
  const agoraMs = Date.now();
  const cutoff = new Date(agoraMs - dias * 24 * 60 * 60 * 1000).toISOString();
  const cutoffAnterior = new Date(agoraMs - 2 * dias * 24 * 60 * 60 * 1000).toISOString();

  const [atualRes, antRes, operadoresRes] = await Promise.all([
    admin
      .from("alertas")
      .select("id, nivel, tipo, status, desde, resolvido_em, motivo, operador_id, veiculos(placa)")
      .eq("modo_teste", false)
      .gte("desde", cutoff)
      .order("desde", { ascending: false })
      .limit(2000),
    admin
      .from("alertas")
      .select("nivel, tipo, status, desde")
      .eq("modo_teste", false)
      .gte("desde", cutoffAnterior)
      .lt("desde", cutoff)
      .order("desde", { ascending: false })
      .limit(2000),
    // "Resolvido por": o dado (operador_id) já era gravado em toda acao de
    // Resolver/Falso positivo/Limpar (ver acoes-alertas.ts) mas nunca
    // aparecia em lugar nenhum da tela -- so' juntar aqui pro nome, sem
    // mudar nada no fluxo de resolucao (achado real 16/08, pedido direto
    // do usuario: "so quero saber qual login foi").
    admin.from("operadores").select("id, nome"),
  ]);

  // Qualidade de tratamento (COMO os alertas foram tratados) usa a mesma
  // agregacao SQL da rota /api/qualidade -- chamada direto aqui (Server
  // Component) em vez de por fetch, evitando um round-trip HTTP
  // desnecessario. Nao entra no Promise.all acima porque respeita os
  // filtros de tipo E nivel (tipoFiltro, nivelFiltro), diferente das
  // queries de admin que trazem tudo e filtram depois em JS. `statusFiltro`
  // deliberadamente NAO e' repassado (achado Important da revisao final,
  // 22/08): os baldes desta secao ja particionam por status por construcao
  // (aberto/limpo/individual/massa/auto derivam de status+origem_acao), um
  // filtro de status por cima zeraria baldes inteiros sem avisar -- ver
  // nota na propria secao.
  //
  // try/catch de proposito (achado de revisao): esta chamada introduz uma
  // dependencia de rede nova nesta pagina -- conexao pg direta ao Postgres
  // do Contabo, separada do caminho @supabase/ssr que o resto da pagina
  // usa. Se essa conexao falhar (rede, timeout, credencial), so a secao de
  // qualidade degrada (mostra estado vazio) -- as outras secoes, que ja
  // buscaram seus dados via Supabase com sucesso, continuam renderizando
  // normalmente em vez de derrubar a pagina inteira.
  let qualidade: ResumoQualidade | null = null;
  try {
    qualidade = await apurarQualidade(dias, tipoFiltro, nivelFiltro);
  } catch (e) {
    console.error("[analise] apurarQualidade falhou:", e instanceof Error ? e.message : String(e));
  }

  const todos = (atualRes.data ?? []) as unknown as AlertaRow[];
  const todosAnt = (antRes.data ?? []) as unknown as AlertaAnt[];
  const nomePorOperador = new Map(
    ((operadoresRes.data ?? []) as { id: string; nome: string }[]).map((o) => [o.id, o.nome])
  );

  const aplicaFiltro = <T extends { tipo: string; nivel: string; status: string }>(r: T) =>
    (!tipoFiltro || r.tipo === tipoFiltro) &&
    (!nivelFiltro || r.nivel === nivelFiltro) &&
    (!statusFiltro || r.status === statusFiltro);

  const filtrados = todos.filter(aplicaFiltro);
  const filtradosAnt = todosAnt.filter(aplicaFiltro);

  // ─── KPIs ────────────────────────────────────────────────────────────
  const total = filtrados.length;
  const criticos = filtrados.filter((r) => r.nivel === "critico").length;
  // "limpo" (28/07) já fica de fora aqui por construção — não é
  // "resolvido" nem "falso_positivo", nunca deve contar como tratado de
  // verdade (não passou por revisão caso a caso, ver limparVarios).
  const resolvidos = filtrados.filter(
    (r) => r.status === "resolvido" || r.status === "falso_positivo"
  ).length;
  const falsos = filtrados.filter((r) => r.status === "falso_positivo").length;
  const emAberto = filtrados.filter(
    (r) => r.status === "ativo" || r.status === "reconhecido"
  ).length;

  const totalAnt = filtradosAnt.length;
  const variacao = totalAnt > 0 ? Math.round(((total - totalAnt) / totalAnt) * 100) : null;

  const taxaResol = total > 0 ? Math.round((resolvidos / total) * 100) : 0;
  const taxaFalso = total > 0 ? Math.round((falsos / total) * 100) : 0;

  // status !== "limpo" (28/07): limparVarios TAMBÉM grava resolvido_em (pra
  // aproveitar a mesma varredura de retenção/privacidade do motor) — sem
  // este filtro, um "Limpar avisos" em massa no fim do turno contaminaria o
  // MTTR com um monte de "resolvido" instantâneo que não foi revisão
  // nenhuma, só a tela sendo limpa.
  const comResolucao = filtrados.filter((r) => r.resolvido_em && r.status !== "limpo");
  const mttrMin =
    comResolucao.length > 0
      ? Math.round(
          comResolucao.reduce(
            (s, r) =>
              s + (new Date(r.resolvido_em!).getTime() - new Date(r.desde).getTime()) / 60000,
            0
          ) / comResolucao.length
        )
      : null;

  // ─── Série diária (empilhada por nível) ──────────────────────────────
  const nDiasSerie = Math.min(dias, 30);
  const contagemDia = new Map<string, { critico: number; atencao: number }>();
  for (const r of filtrados) {
    const k = chaveDiaBR(new Date(r.desde));
    const e = contagemDia.get(k) ?? { critico: 0, atencao: 0 };
    if (r.nivel === "critico") e.critico++;
    else e.atencao++;
    contagemDia.set(k, e);
  }
  const serieDias: { label: string; critico: number; atencao: number; total: number }[] = [];
  for (let i = nDiasSerie - 1; i >= 0; i--) {
    const d = new Date(agoraMs - i * 24 * 60 * 60 * 1000);
    const k = chaveDiaBR(d);
    const e = contagemDia.get(k) ?? { critico: 0, atencao: 0 };
    serieDias.push({ label: k, critico: e.critico, atencao: e.atencao, total: e.critico + e.atencao });
  }
  const maxSerie = Math.max(1, ...serieDias.map((s) => s.total));
  const passoLabel = Math.max(1, Math.ceil(nDiasSerie / 7));

  // ─── Por hora do dia ─────────────────────────────────────────────────
  const horas = Array.from({ length: 24 }, () => 0);
  for (const r of filtrados) horas[horaBR(r.desde)]++;
  const maxHora = Math.max(1, ...horas);
  const horaPico = horas.indexOf(maxHora);

  // ─── Por dia da semana ───────────────────────────────────────────────
  const semana = Array.from({ length: 7 }, () => 0);
  for (const r of filtrados) semana[diaSemanaBR(r.desde)]++;
  const maxSemana = Math.max(1, ...semana);

  // ─── Por tipo ────────────────────────────────────────────────────────
  const porTipo = new Map<string, number>();
  for (const r of filtrados) porTipo.set(r.tipo, (porTipo.get(r.tipo) ?? 0) + 1);
  const tiposOrdenados = [...porTipo.entries()].sort((a, b) => b[1] - a[1]);
  const maxTipo = tiposOrdenados[0]?.[1] ?? 1;

  // ─── Top veículos ────────────────────────────────────────────────────
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

  const contTodos = todos;
  function contNivel(n: string)  { return contTodos.filter((r) => r.nivel  === n).length; }
  function contStatus(s: string) { return contTodos.filter((r) => r.status === s).length; }

  const temFiltroAtivo = !!(tipoFiltro || nivelFiltro || statusFiltro);

  // KPIs: cada card decide cor/variação
  const kpis: {
    label: string;
    valor: string;
    cor: string;
    sub?: string;
    variacao?: number | null;
    variacaoRuimSobe?: boolean;
  }[] = [
    { label: "Total de alertas", valor: String(total), cor: "var(--text)", variacao, variacaoRuimSobe: true,
      sub: totalAnt > 0 ? `${totalAnt} no período anterior` : "sem base anterior" },
    { label: "Críticos", valor: String(criticos), cor: "#ef4444",
      sub: total > 0 ? `${Math.round((criticos / total) * 100)}% do total` : undefined },
    { label: "Em aberto agora", valor: String(emAberto), cor: emAberto > 0 ? "#f59e0b" : "#22c55e",
      sub: emAberto > 0 ? "aguardando atendimento" : "tudo tratado" },
    { label: "Tempo médio resposta", valor: mttrMin != null ? formatarMin(mttrMin) : "—", cor: "var(--accent)",
      sub: comResolucao.length > 0 ? `base: ${comResolucao.length} resolvidos` : "sem resoluções" },
    { label: "Taxa de resolução", valor: `${taxaResol}%`, cor: taxaResol >= 70 ? "#22c55e" : taxaResol >= 40 ? "#f59e0b" : "#ef4444",
      sub: `${resolvidos} de ${total} tratados` },
    { label: "Falsos positivos", valor: `${taxaFalso}%`, cor: "#6b7280",
      sub: `${falsos} alerta${falsos !== 1 ? "s" : ""}` },
  ];

  return (
    <div
      className="max-w-6xl mx-auto px-6 py-8 space-y-8"
      style={{ color: "var(--text)" }}
    >
      {/* Cabecalho: titulo + filtros */}
      <div className="space-y-4">
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

        {/* Chips de filtro */}
        <div
          className="flex flex-wrap items-center gap-1.5 p-3 rounded-xl"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
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

          <div style={{ width: "1px", height: "20px", backgroundColor: "var(--border)", flexShrink: 0, margin: "0 4px" }} />

          <span className="text-xs uppercase tracking-widest leading-none mr-1" style={{ color: "var(--text-dim)", fontSize: "9px" }}>
            Status
          </span>
          {(["ativo", "reconhecido", "resolvido", "falso_positivo", "limpo"] as const).map((s) => {
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

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((k) => {
          const v = k.variacao;
          const mostraVar = v != null && v !== 0;
          const sobe = (v ?? 0) > 0;
          const ruim = k.variacaoRuimSobe ? sobe : !sobe;
          const corVar = ruim ? "#ef4444" : "#22c55e";
          return (
            <div
              key={k.label}
              className="rounded-xl p-4 flex flex-col"
              style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
            >
              <p className="text-xs leading-tight" style={{ color: "var(--text-muted)", fontSize: "11px" }}>
                {k.label}
              </p>
              <div className="flex items-baseline gap-1.5 mt-1.5">
                <p className="text-2xl font-bold tabular-nums leading-none" style={{ color: k.cor }}>
                  {k.valor}
                </p>
                {mostraVar && (
                  <span className="inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums" style={{ color: corVar }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: sobe ? "none" : "rotate(180deg)" }}>
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                    {Math.abs(v!)}%
                  </span>
                )}
              </div>
              {k.sub && (
                <p className="text-xs mt-auto pt-2" style={{ color: "var(--text-dim)", fontSize: "10px" }}>
                  {k.sub}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Tendência diária */}
      <div
        className="rounded-xl p-6"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold">Tendência por dia</h3>
          <div className="flex items-center gap-4 text-xs" style={{ color: "var(--text-muted)" }}>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#ef4444" }} /> Crítico
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: "#f59e0b" }} /> Atenção
            </span>
          </div>
        </div>

        {total === 0 ? (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Nenhum alerta no período.</p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-end", height: "140px", gap: "3px" }}>
              {serieDias.map((s, i) => (
                <div
                  key={i}
                  title={`${s.label}: ${s.total} alerta${s.total !== 1 ? "s" : ""} (${s.critico} crít. / ${s.atencao} aten.)`}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-end",
                    height: "100%",
                    minWidth: 0,
                  }}
                >
                  <div style={{ height: `${(s.atencao / maxSerie) * 100}%`, backgroundColor: "#f59e0b", borderRadius: "2px 2px 0 0", transition: "height .2s" }} />
                  <div style={{ height: `${(s.critico / maxSerie) * 100}%`, backgroundColor: "#ef4444", borderRadius: s.atencao === 0 ? "2px 2px 0 0" : "0", transition: "height .2s" }} />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "3px", marginTop: "6px" }}>
              {serieDias.map((s, i) => (
                <div key={i} style={{ flex: 1, textAlign: "center", minWidth: 0 }}>
                  {i % passoLabel === 0 && (
                    <span style={{ fontSize: "9px", color: "var(--text-dim)" }}>{s.label}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Por hora + Por dia da semana */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Por hora do dia */}
        <div
          className="rounded-xl p-6"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-sm font-semibold">Por hora do dia</h3>
            {total > 0 && (
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                pico às {String(horaPico).padStart(2, "0")}h
              </span>
            )}
          </div>
          {total === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Nenhum alerta no período.</p>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "flex-end", height: "100px", gap: "2px" }}>
                {horas.map((q, h) => (
                  <div
                    key={h}
                    title={`${String(h).padStart(2, "0")}h: ${q} alerta${q !== 1 ? "s" : ""}`}
                    style={{
                      flex: 1,
                      height: `${(q / maxHora) * 100}%`,
                      minHeight: q > 0 ? "2px" : "0",
                      backgroundColor: h === horaPico ? "#ef4444" : "var(--accent)",
                      opacity: h === horaPico ? 1 : 0.55,
                      borderRadius: "2px 2px 0 0",
                    }}
                  />
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "9px", color: "var(--text-dim)" }}>
                <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
              </div>
            </>
          )}
        </div>

        {/* Por dia da semana */}
        <div
          className="rounded-xl p-6"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          <h3 className="text-sm font-semibold mb-5">Por dia da semana</h3>
          {total === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Nenhum alerta no período.</p>
          ) : (
            <div className="space-y-2.5">
              {semana.map((q, d) => {
                const pct = Math.round((q / maxSemana) * 100);
                const ehMax = q === maxSemana && q > 0;
                return (
                  <div key={d} className="flex items-center gap-3">
                    <span className="text-xs w-8 flex-shrink-0" style={{ color: "var(--text-muted)" }}>
                      {NOMES_SEMANA[d]}
                    </span>
                    <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ backgroundColor: "var(--bg)" }}>
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: ehMax ? "#ef4444" : "var(--accent)", opacity: ehMax ? 1 : 0.6 }} />
                    </div>
                    <span className="text-xs font-semibold tabular-nums w-6 text-right flex-shrink-0" style={{ color: "var(--text)" }}>
                      {q}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Por tipo + Top veiculos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div
          className="rounded-xl p-6"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          <h3 className="text-sm font-semibold mb-4">Alertas por tipo</h3>
          {tiposOrdenados.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Nenhum alerta no período.</p>
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
                      <span className="text-xs" style={{ color: ativo ? cor : "var(--text-muted)" }}>
                        {LABEL_TIPO[tipo] ?? tipo}
                      </span>
                      <span className="text-xs font-semibold tabular-nums" style={{ color: cor }}>
                        {qtd}
                      </span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: "var(--bg)" }}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: cor, opacity: ativo ? 1 : 0.7 }} />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div
          className="rounded-xl p-6"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          <h3 className="text-sm font-semibold mb-4">Top veículos por alertas</h3>
          {topVeiculos.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Nenhum dado no período.</p>
          ) : (
            <div className="space-y-3">
              {topVeiculos.map(({ placa, count, tipoFreq }, i) => {
                const corTipo = COR_TIPO[tipoFreq] ?? "#64748b";
                const pctBar = Math.round((count / (topVeiculos[0]?.count ?? 1)) * 100);
                return (
                  <div key={placa} className="flex items-center gap-3">
                    <span className="text-xs font-bold tabular-nums w-5 text-right flex-shrink-0" style={{ color: "var(--text-dim)" }}>
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-mono font-semibold tracking-widest">{placa}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: `${corTipo}22`, color: corTipo, fontSize: "10px" }}>
                            {LABEL_TIPO[tipoFreq] ?? tipoFreq}
                          </span>
                          <span className="text-xs font-semibold tabular-nums" style={{ color: "var(--text)" }}>
                            {count}
                          </span>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: "var(--bg)" }}>
                        <div className="h-full rounded-full" style={{ width: `${pctBar}%`, backgroundColor: "var(--accent)" }} />
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
      <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ backgroundColor: "var(--card)", borderBottom: "1px solid var(--border)" }}
        >
          <h3 className="text-sm font-semibold">Histórico de alertas</h3>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {filtrados.length > 100 ? `mostrando 100 de ${filtrados.length}` : `${filtrados.length} registros`}
          </span>
        </div>

        {filtrados.length === 0 ? (
          <div className="px-6 py-12 text-center" style={{ backgroundColor: "var(--bg)" }}>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Nenhum alerta no período selecionado.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto" style={{ backgroundColor: "var(--bg)" }}>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Tipo", "Placa", "Quando", "Status", "Tempo até resolver", "Resolvido por"].map((h) => (
                    <th key={h} className="text-left px-4 py-3 font-medium" style={{ color: "var(--text-muted)" }}>
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
                        <span className="inline-flex items-center gap-1.5" style={{ color: cor }}>
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: cor }} />
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
                        <span className="px-2 py-0.5 rounded text-xs" style={{ backgroundColor: `${corSt}22`, color: corSt }}>
                          {LABEL_STATUS[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: "var(--text-muted)" }}>
                        {tempoAteResolver(r.desde, r.resolvido_em)}
                      </td>
                      <td className="px-4 py-3" style={{ color: "var(--text-muted)" }}>
                        {r.operador_id ? (nomePorOperador.get(r.operador_id) ?? "—") : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Qualidade de tratamento — COMO os alertas foram tratados.
          Achado real 19-21/08: "resolvido" sozinho nao diz nada, porque
          29 de 35 "corretos" de desvio vinham de clique em lote. Aqui o
          que importa e' o balde "revisao individual". */}
      <div
        className="rounded-xl p-6"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
      >
        <h3 className="text-sm font-semibold mb-1">Qualidade do tratamento</h3>
        <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>
          Como os alertas do período foram tratados. Só &quot;revisão individual&quot; vale como veredito caso a caso.
        </p>
        <p className="text-xs mb-1" style={{ color: "var(--text-dim)" }}>
          Apurado direto no banco sobre o período inteiro (sem o teto de 2000 registros das seções acima — por
          isso os totais aqui podem não bater com o &quot;Total de alertas&quot; do topo). Respeita os filtros de
          nível e tipo, mas não o de status: os baldes abaixo já particionam por status.
        </p>
        <p className="text-xs mb-4" style={{ color: "var(--text-dim)" }}>
          Quebra de série em 22/08/2026 pra &quot;Parada anômala&quot; e &quot;Parada longa&quot;: a partir dessa data o
          motor passou a suprimir re-disparo do mesmo episódio de parada já tratado (cooldown, achado TUG-9D18).
          Menos duplicata individual tratada e latência (mediana/P90) mais alta depois dessa data não significam
          que a operação piorou — significam que o alerta duplicado deixou de nascer.
        </p>

        {!qualidade ? (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Não foi possível carregar os dados de qualidade agora. As demais seções desta página continuam válidas.
          </p>
        ) : (
        <>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          {[
            { chave: "individual", label: "Revisão individual", cor: "#22c55e" },
            { chave: "massa", label: "Ação em massa", cor: "#f59e0b" },
            { chave: "limpo", label: "Limpo (sem revisão)", cor: "#0ea5e9" },
            { chave: "auto", label: "Auto-resolvido", cor: "#64748b" },
            { chave: "aberto", label: "Em aberto", cor: "#ef4444" },
          ].map((b) => (
            <div key={b.chave} className="rounded-xl p-4 flex flex-col" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)" }}>
              <p className="text-xs leading-tight" style={{ color: "var(--text-muted)", fontSize: "11px" }}>{b.label}</p>
              <p className="text-2xl font-bold tabular-nums leading-none mt-1.5" style={{ color: b.cor }}>
                {qualidade.baldes[b.chave] ?? 0}
              </p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <h4 className="text-xs font-semibold mb-3" style={{ color: "var(--text-muted)" }}>Tempo até o tratamento (revisão individual)</h4>
            {qualidade.latencia.amostras === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Nenhuma revisão individual no período.</p>
            ) : (
              <div className="flex gap-6">
                <div>
                  <p className="text-xs" style={{ color: "var(--text-muted)", fontSize: "11px" }}>Mediana</p>
                  <p className="text-2xl font-bold tabular-nums leading-none mt-1" style={{ color: "var(--text)" }}>
                    {Math.round(qualidade.latencia.medianaMin ?? 0)}<span className="text-sm font-normal"> min</span>
                  </p>
                </div>
                <div>
                  <p className="text-xs" style={{ color: "var(--text-muted)", fontSize: "11px" }}>P90</p>
                  <p className="text-2xl font-bold tabular-nums leading-none mt-1" style={{ color: "var(--text)" }}>
                    {Math.round(qualidade.latencia.p90Min ?? 0)}<span className="text-sm font-normal"> min</span>
                  </p>
                </div>
                <div>
                  <p className="text-xs" style={{ color: "var(--text-muted)", fontSize: "11px" }}>Amostras</p>
                  <p className="text-2xl font-bold tabular-nums leading-none mt-1" style={{ color: "var(--text-dim)" }}>
                    {qualidade.latencia.amostras}
                  </p>
                </div>
              </div>
            )}

            <h4 className="text-xs font-semibold mb-3 mt-6" style={{ color: "var(--text-muted)" }}>Motivos de falso (revisão individual)</h4>
            {qualidade.falsosPorMotivo.filter((f) => f.motivo).length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Nenhum falso categorizado no período.</p>
            ) : (
              <div className="space-y-2">
                {qualidade.falsosPorMotivo.filter((f) => f.motivo).sort((a, b) => b.n - a.n).map((f) => (
                  <div key={f.motivo} className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>{f.motivo}</span>
                    <span className="text-xs font-semibold tabular-nums" style={{ color: "var(--text)" }}>{f.n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h4 className="text-xs font-semibold mb-3" style={{ color: "var(--text-muted)" }}>Por operador</h4>
            {qualidade.porOperador.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Nenhum tratamento no período.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: "var(--text-dim)" }}>
                    <th className="text-left font-medium pb-2">Operador</th>
                    <th className="text-right font-medium pb-2">Individual</th>
                    <th className="text-right font-medium pb-2">Massa</th>
                    <th className="text-right font-medium pb-2">Limpo</th>
                  </tr>
                </thead>
                <tbody>
                  {[...new Set(qualidade.porOperador.map((p) => p.operador))]
                    .filter((nome) => nome !== "sem operador")
                    .map((nome) => {
                      const doOperador = (balde: string) =>
                        qualidade.porOperador.find((p) => p.operador === nome && p.balde === balde)?.n ?? 0;
                      return (
                        <tr key={nome} style={{ borderTop: "1px solid var(--border)" }}>
                          <td className="py-2" style={{ color: "var(--text)" }}>{nome}</td>
                          <td className="py-2 text-right tabular-nums" style={{ color: "#22c55e" }}>{doOperador("individual")}</td>
                          <td className="py-2 text-right tabular-nums" style={{ color: "#f59e0b" }}>{doOperador("massa")}</td>
                          <td className="py-2 text-right tabular-nums" style={{ color: "#0ea5e9" }}>{doOperador("limpo")}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
