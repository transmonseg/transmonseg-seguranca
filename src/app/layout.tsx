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
    <html lang="pt-BR" className={`${geist.variable} ${geistMono.variable}`}>
      <body
        className="min-h-screen"
        style={{ backgroundColor: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-geist), sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
