import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
});

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
    <html lang="pt-BR" className={geist.className}>
      <body className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}>
        {/* Header global */}
        <header
          className="flex items-center justify-between px-6 py-4 border-b"
          style={{ borderColor: "var(--border)", backgroundColor: "var(--card)" }}
        >
          <div className="flex items-center gap-3">
            {/* Icone de escudo SVG */}
            <svg
              width="28"
              height="28"
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
            <div>
              <h1 className="text-base font-semibold tracking-tight leading-none" style={{ color: "var(--text)" }}>
                Transmonseg Central
              </h1>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                Central de inteligencia de risco
              </p>
            </div>
          </div>

          {/* Indicador ao vivo */}
          <div className="flex items-center gap-2">
            <span
              className="animate-pulse-live inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: "var(--verde)" }}
              aria-label="Sistema ao vivo"
            />
            <span className="text-xs font-medium" style={{ color: "var(--verde)" }}>
              ao vivo
            </span>
          </div>
        </header>

        {/* Conteudo principal */}
        <main className="flex-1">
          {children}
        </main>

        {/* Rodape minimalista */}
        <footer
          className="px-6 py-3 text-xs border-t"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          Transmonseg Central &copy; {new Date().getFullYear()} &middot; Monitoramento em tempo real
        </footer>
      </body>
    </html>
  );
}
