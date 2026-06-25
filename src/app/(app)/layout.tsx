import Link from "next/link";
import RelogioAoVivo from "./components/RelogioAoVivo";
import AutoRefresh from "./components/AutoRefresh";
import { createClient } from "@/lib/supabase/server";
import { sair } from "../login/actions";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const nome = (user?.user_metadata?.nome as string | undefined) ?? user?.email ?? "operador";
  const inicial = nome.charAt(0).toUpperCase();

  return (
    <div className="min-h-screen flex flex-col">
      {/* ============================================================
          HEADER DE COMANDO
          ============================================================ */}
      <header className="sticky top-0 z-50 border-b" style={{ borderColor: "var(--border)", backgroundColor: "var(--bg)" }}>
        <div className="flex items-center justify-between px-6 py-3">
          {/* Lado esquerdo: logo + identidade */}
          <div className="flex items-center gap-4">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
              style={{ backgroundColor: "var(--accent-dim)", border: "1px solid #2a3a50" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <h1 className="text-sm font-semibold tracking-tight leading-none" style={{ color: "var(--text)" }}>
                  Transmonseg
                </h1>
                <span
                  className="text-xs font-medium px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: "var(--accent-dim)", color: "var(--accent)", fontSize: "10px", letterSpacing: "0.08em" }}
                >
                  CENTRAL
                </span>
              </div>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                Inteligência de risco em tempo real
              </p>
            </div>
          </div>

          {/* Navegacao discreta */}
          <nav className="hidden sm:flex items-center gap-1" aria-label="Navegação principal">
            <Link
              href="/"
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid transparent" }}
            >
              Central
            </Link>
            <Link
              href="/analise"
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid transparent" }}
            >
              Análise
            </Link>
          </nav>

          {/* Lado direito: relógio + ao vivo + operador */}
          <div className="flex items-center gap-5">
            <RelogioAoVivo />
            <div className="w-px h-8" style={{ backgroundColor: "var(--border)" }} />
            <div className="hidden sm:flex items-center gap-2">
              <span
                className="animate-pulse-live inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: "var(--verde)" }}
                aria-label="Sistema ao vivo"
              />
              <div>
                <p className="text-xs font-semibold leading-none" style={{ color: "var(--verde)" }}>AO VIVO</p>
                <p className="text-xs leading-none mt-0.5" style={{ color: "var(--text-muted)", fontSize: "10px" }}>
                  sistema operacional
                </p>
              </div>
            </div>
            <div className="w-px h-8 hidden sm:block" style={{ backgroundColor: "var(--border)" }} />

            {/* Operador logado + sair */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div
                  className="flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold"
                  style={{ backgroundColor: "var(--accent-dim)", color: "var(--accent)", border: "1px solid #2a3a50" }}
                  aria-hidden="true"
                >
                  {inicial}
                </div>
                <span className="hidden md:inline text-xs" style={{ color: "var(--text-muted)" }}>{nome}</span>
              </div>
              <form action={sair}>
                <button
                  type="submit"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-[color:var(--card-hover)] active:translate-y-px"
                  style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}
                  title="Encerrar sessão"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  <span className="hidden sm:inline">Sair</span>
                </button>
              </form>
            </div>
          </div>
        </div>

        <div
          className="h-px"
          style={{ background: "linear-gradient(to right, transparent, var(--accent) 30%, var(--accent) 70%, transparent)", opacity: 0.2 }}
        />
      </header>

      {/* Conteudo principal */}
      <main className="flex-1">
        <AutoRefresh segundos={30} />
        {children}
      </main>

      {/* Rodapé */}
      <footer className="px-6 py-3 flex items-center justify-between border-t" style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}>
        <span className="text-xs">Transmonseg Central &copy; {new Date().getFullYear()}</span>
        <span className="text-xs">Monitoramento autônomo de frotas</span>
      </footer>
    </div>
  );
}
