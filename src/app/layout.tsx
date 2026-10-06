import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Transmonseg Central",
  description: "Central de inteligencia de risco para frotas monitoradas",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Dentro da Central Transmonseg (05/10): marca antes de pintar pra
            moldura (logo, abas) já nascer escondida. */}
        <script dangerouslySetInnerHTML={{ __html: "try{if(window.self!==window.top)document.documentElement.dataset.embed='1'}catch(e){document.documentElement.dataset.embed='1'}" }} />
      </head>
      <body
        className="min-h-screen"
        style={{ backgroundColor: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-geist), sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
