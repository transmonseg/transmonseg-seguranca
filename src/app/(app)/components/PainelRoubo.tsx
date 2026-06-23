// Painel de roubo de carga no RJ (ISP-RJ, últimos 12 meses). Server component:
// busca direto da lib (cache em memória). Ranking dos municípios com barras.
import { obterRouboCarga } from "@/lib/roubocarga";

export default async function PainelRoubo() {
  const dados = await obterRouboCarga();
  if (!dados || dados.ranking.length === 0) return null;

  const top = dados.ranking.filter((m) => m.total > 0).slice(0, 8);
  const max = top[0]?.total ?? 1;

  return (
    <section aria-label="Roubo de carga no RJ" style={{ marginBottom: "3.5rem" }}>
      <div className="flex items-center gap-4 mb-5">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: "#dc2626" }} />
        <h2 className="text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={{ color: "var(--text-muted)", letterSpacing: "0.14em" }}>
          Roubo de carga · RJ
          <span className="num-mono ml-3 font-bold" style={{ fontFamily: "var(--font-geist-mono, monospace)", color: "#dc2626", fontSize: "0.85rem" }}>
            {dados.total.toLocaleString("pt-BR")}
          </span>
        </h2>
        <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
        <span className="text-xs whitespace-nowrap" style={{ color: "var(--text-dim)" }}>
          {dados.periodo} · ISP-RJ
        </span>
      </div>

      <div className="rounded-2xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)", padding: "1.5rem 1.75rem" }}>
        <div className="flex flex-col gap-3">
          {top.map((m) => (
            <div key={m.cod} className="flex items-center gap-3">
              <span className="text-sm flex-shrink-0" style={{ color: "var(--text-muted)", width: "11rem" }}>
                {m.nome}
              </span>
              <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: "var(--border-subtle)" }}>
                <div style={{ height: "100%", width: `${Math.max(3, Math.round((m.total / max) * 100))}%`, backgroundColor: "#dc2626", borderRadius: "9999px", opacity: 0.85 }} />
              </div>
              <span className="num-mono text-sm font-semibold flex-shrink-0 text-right" style={{ fontFamily: "var(--font-geist-mono, monospace)", color: "var(--text)", width: "3.5rem" }}>
                {m.total.toLocaleString("pt-BR")}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs mt-4" style={{ color: "var(--text-dim)" }}>
          Registros oficiais por município (o ponto exato é sigiloso). No mapa, ative a camada
          &ldquo;Roubo de carga&rdquo; para ver o calor por regi&atilde;o.
        </p>
      </div>
    </section>
  );
}
