import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import RelogioAoVivo from "./components/RelogioAoVivo";
import AutoRefresh from "./components/AutoRefresh";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Transmonseg Central",
  description: "Central de inteligencia de risco para frotas monitoradas",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className={`${geist.variable} ${geistMono.variable}`}>
      <body
        className="min-h-screen flex flex-col"
        style={{ backgroundColor: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-geist), sans-serif" }}
      >
        {/* ============================================================
            HEADER DE COMANDO
            ============================================================ */}
        <header
          className="sticky top-0 z-50 border-b"
          style={{ borderColor: "var(--border)", backgroundColor: "var(--bg)" }}
        >
          {/* Linha superior: identidade + relógio + status */}
          <div
            className="flex items-center justify-between px-6 py-3"
          >
            {/* Lado esquerdo: logo + identidade */}
            <div className="flex items-center gap-4">
              {/* Escudo estilizado */}
              <div
                className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
                style={{ backgroundColor: "var(--accent-dim)", border: "1px solid #2a3a50" }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>

              <div>
                <div className="flex items-baseline gap-2">
                  <h1
                    className="text-sm font-semibold tracking-tight leading-none"
                    style={{ color: "var(--text)" }}
                  >
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
                  Inteligencia de risco em tempo real
                </p>
              </div>
            </div>

            {/* Lado direito: relógio + status ao vivo */}
            <div className="flex items-center gap-5">
              {/* Relógio ao vivo */}
              <RelogioAoVivo />

              {/* Divisor */}
              <div className="w-px h-8" style={{ backgroundColor: "var(--border)" }} />

              {/* Indicador ao vivo */}
              <div className="flex items-center gap-2">
                <span
                  className="animate-pulse-live inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: "var(--verde)" }}
                  aria-label="Sistema ao vivo"
                />
                <div>
                  <p className="text-xs font-semibold leading-none" style={{ color: "var(--verde)" }}>
                    AO VIVO
                  </p>
                  <p className="text-xs leading-none mt-0.5" style={{ color: "var(--text-muted)", fontSize: "10px" }}>
                    sistema operacional
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Barra de acento navy fina na base do header */}
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

        {/* Rodapé discreto */}
        <footer
          className="px-6 py-3 flex items-center justify-between border-t"
          style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
        >
          <span className="text-xs">
            Transmonseg Central &copy; {new Date().getFullYear()}
          </span>
          <span className="text-xs">
            Monitoramento autonomo de frotas
          </span>
        </footer>
      </body>
    </html>
  );
}
