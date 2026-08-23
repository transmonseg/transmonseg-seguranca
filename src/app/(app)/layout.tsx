import NavPrincipal from "./components/NavPrincipal";
import RelogioAoVivo from "./components/RelogioAoVivo";
import RomaneioStatusBadge from "./components/RomaneioStatusBadge";
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
    <div className="h-screen flex flex-col overflow-hidden">
      {/* ============================================================
          HEADER DE COMANDO
          ============================================================ */}
      {/* z-[60], não mais z-50: a toolbar do MonitorV2 também é z-index 50 e
          vem DEPOIS no DOM, então no empate ela ganhava. Enquanto o header
          não tinha nada que descesse sobre a página isso era invisível; com o
          menu da engrenagem, o primeiro item aparecia por baixo da toolbar
          (reproduzido em print na Central, 23/08). Só 60: continua abaixo de
          todas as camadas do MonitorV2 (badge 100, toasts 800, drawer 1000,
          pânico 2000), que seguem cobrindo o header exatamente como hoje. */}
      <header className="sticky top-0 z-[60] border-b" style={{ borderColor: "var(--border)", backgroundColor: "var(--bg)" }}>
        <div className="flex items-center justify-between px-6 py-2">
          {/* Lado esquerdo: logo + identidade */}
          <div className="flex items-center gap-4">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
              style={{ backgroundColor: "var(--accent-dim)", border: "1px solid var(--border)" }}
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

          {/* Navegacao: 2 abas + engrenagem (ver NavPrincipal -- client
              component porque o menu precisa de estado; este layout continua
              server por causa do await createClient() acima). */}
          <NavPrincipal />

          {/* Lado direito: relógio + ao vivo + operador */}
          <div className="flex items-center gap-5">
            <RomaneioStatusBadge />
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
                  style={{ backgroundColor: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--border)" }}
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
      {/* overflow-y-auto (nao overflow-hidden): paginas de conteudo normal
          (romaneio, analise) precisam rolar quando o resultado cresce --
          achado real 31/07, usuario nao conseguia descer pra ver a lista.
          A Central (MonitorV2) preenche exatamente height:100% e gerencia
          seu proprio overflow internamente, entao nao aparece scrollbar
          dupla nela. */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        {children}
      </main>

    </div>
  );
}
