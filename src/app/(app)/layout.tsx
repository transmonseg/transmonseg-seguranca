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
      <header className="sticky top-0 z-[60] h-[52px] px-4 border-b border-border bg-bg/80 backdrop-blur-xl">
        <div className="flex items-center justify-between h-full">
          {/* Lado esquerdo: logo + identidade */}
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-[28px] h-[28px] rounded-[8px] flex-shrink-0"
              style={{ backgroundColor: "var(--accent-dim)", border: "1px solid var(--border)" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <h1 className="text-[15px] font-semibold tracking-tight leading-none text-text">
              Transmonseg
            </h1>
          </div>

          {/* Navegacao: 2 abas + engrenagem (ver NavPrincipal -- client
              component porque o menu precisa de estado; este layout continua
              server por causa do await createClient() acima). */}
          <NavPrincipal />

          {/* Lado direito: relógio + ao vivo + operador */}
          <div className="flex items-center gap-4">
            <RomaneioStatusBadge />
            <RelogioAoVivo />
            <div className="hidden sm:flex items-center gap-1.5">
              <span
                className="animate-pulse-live inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: "var(--verde)" }}
                aria-label="Sistema ao vivo"
              />
              <p className="text-[12px] font-medium text-verde leading-none">Ao vivo</p>
            </div>

            {/* Operador logado + sair */}
            <div className="flex items-center gap-2">
              <div
                className="flex items-center justify-center w-[28px] h-[28px] rounded-full text-[12px] font-semibold"
                style={{ backgroundColor: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--border)" }}
                aria-hidden="true"
              >
                {inicial}
              </div>
              <span className="hidden md:inline text-[12px] text-muted">{nome}</span>
              <form action={sair}>
                <button
                  type="submit"
                  className="flex items-center gap-1.5 rounded-full px-3 h-8 text-[13px] transition-colors hover:bg-card-hover active:translate-y-px text-muted border border-border"
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
