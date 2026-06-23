import LoginForm from "./LoginForm";

export const metadata = {
  title: "Acesso — Transmonseg Central",
};

export default function LoginPage() {
  return (
    <div className="grid min-h-[100dvh] grid-cols-1 lg:grid-cols-2" style={{ backgroundColor: "var(--bg)" }}>
      {/* Painel de identidade (some no mobile) */}
      <aside
        className="relative hidden lg:flex flex-col justify-between p-12 overflow-hidden"
        style={{ borderRight: "1px solid var(--border)" }}
      >
        {/* Brilho navy sutil no canto, sem glow chamativo */}
        <div
          className="absolute -top-32 -left-32 w-96 h-96 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, var(--accent-dim) 0%, transparent 70%)", opacity: 0.6 }}
          aria-hidden="true"
        />

        <div className="relative flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-lg"
            style={{ backgroundColor: "var(--accent-dim)", border: "1px solid #2a3a50" }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight" style={{ color: "var(--text)" }}>
                Transmonseg
              </span>
              <span className="tag" style={{ backgroundColor: "var(--accent-dim)", color: "var(--accent)", fontSize: "10px", letterSpacing: "0.08em" }}>
                CENTRAL
              </span>
            </div>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Inteligencia de risco em tempo real
            </p>
          </div>
        </div>

        <div className="relative">
          <h1 className="text-4xl font-semibold tracking-tighter leading-tight" style={{ color: "var(--text)" }}>
            A frota deixa de ser rastreada.
            <br />
            <span style={{ color: "var(--accent)" }}>Passa a ser protegida.</span>
          </h1>
          <p className="text-base mt-4 leading-relaxed" style={{ color: "var(--text-muted)", maxWidth: "46ch" }}>
            Desvio de rota, parada anomala, bloqueador e zonas de risco monitorados
            ao vivo, com contexto para decidir em segundos.
          </p>
        </div>

        <div className="relative flex items-center gap-2">
          <span className="animate-pulse-live inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "var(--verde)" }} aria-hidden="true" />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Motor autonomo, frotas em operacao agora
          </span>
        </div>
      </aside>

      {/* Painel do formulario */}
      <main className="flex items-center justify-center p-6 sm:p-12">
        <LoginForm />
      </main>
    </div>
  );
}
