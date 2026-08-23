"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { rotaAtiva } from "@/lib/nav-rota";

// Pedido do usuario 23/08: "melhor so' colocar duas opcoes la em cima:
// Central e Central Romaneio". As outras tres telas nao somem -- viram itens
// da engrenagem ao lado. A Analise entra no menu (e nao no lixo) porque e' a
// unica tela que ficaria inalcancavel: o painel de qualidade nao tem outro
// caminho.
//
// Client component de proposito: o AppLayout e' server (usa await
// createClient()) e o menu precisa de estado/teclado/clique-fora. So' a
// navegacao virou cliente, o resto do header continua no servidor.

const ABAS = [
  { href: "/", rotulo: "Central" },
  { href: "/central-romaneio", rotulo: "Central Romaneio" },
] as const;

const ITENS_MENU = [
  { href: "/romaneio", rotulo: "Configurar Romaneio" },
  { href: "/escala", rotulo: "Escala" },
  { href: "/analise", rotulo: "Análise" },
] as const;

export default function NavPrincipal() {
  const pathname = usePathname() ?? "/";
  const [aberto, setAberto] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const botaoRef = useRef<HTMLButtonElement | null>(null);
  const primeiroItemRef = useRef<HTMLAnchorElement | null>(null);

  // Fecha ao clicar fora e no Escape (devolvendo o foco pra engrenagem --
  // sem isso o teclado fica orfao no meio da pagina depois de fechar).
  useEffect(() => {
    if (!aberto) return;
    const aoClicarFora = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setAberto(false);
    };
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAberto(false);
        botaoRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", aoClicarFora);
    document.addEventListener("keydown", aoTeclar);
    return () => {
      document.removeEventListener("mousedown", aoClicarFora);
      document.removeEventListener("keydown", aoTeclar);
    };
  }, [aberto]);

  // Abrir por teclado tem que levar o foco pro primeiro item -- abrir um menu
  // e deixar o foco no botao e' o mesmo que nao abrir, pra quem navega por Tab.
  useEffect(() => {
    if (aberto) primeiroItemRef.current?.focus();
  }, [aberto]);

  const menuAtivo = ITENS_MENU.some((i) => rotaAtiva(pathname, i.href));

  return (
    <nav className="hidden sm:flex items-center gap-1" aria-label="Navegação principal">
      {ABAS.map((aba) => {
        const ativa = rotaAtiva(pathname, aba.href);
        return (
          <Link
            key={aba.href}
            href={aba.href}
            aria-current={ativa ? "page" : undefined}
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors hover:bg-[color:var(--card-hover)]"
            style={
              ativa
                ? { color: "var(--accent)", backgroundColor: "var(--accent-dim)", border: "1px solid var(--border)" }
                : { color: "var(--text-muted)", border: "1px solid transparent" }
            }
          >
            {aba.rotulo}
          </Link>
        );
      })}

      <div className="relative ml-1" ref={containerRef}>
        <button
          ref={botaoRef}
          type="button"
          onClick={() => setAberto((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={aberto}
          aria-label="Configurações"
          title="Configurações"
          className="flex items-center justify-center w-8 h-8 rounded-md transition-colors hover:bg-[color:var(--card-hover)]"
          style={{
            color: aberto || menuAtivo ? "var(--accent)" : "var(--text-muted)",
            backgroundColor: aberto || menuAtivo ? "var(--accent-dim)" : "transparent",
            border: `1px solid ${aberto || menuAtivo ? "var(--border)" : "transparent"}`,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        {/* Sem animate-fade-in de propósito: com a animação o menu ganha
            camada própria no compositor e o conteúdo animado da página (a
            tela do gate, os painéis do MonitorV2) aparece POR CIMA dele --
            reproduzido em print 23/08. Menu que abre instantâneo também é o
            certo pra um console denso. */}
        {aberto && (
          <div
            role="menu"
            aria-label="Configurações"
            className="absolute right-0 mt-1.5 min-w-[200px] rounded-md py-1 z-50"
            style={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            }}
          >
            {ITENS_MENU.map((item, i) => {
              const ativa = rotaAtiva(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  ref={i === 0 ? primeiroItemRef : undefined}
                  onClick={() => setAberto(false)}
                  aria-current={ativa ? "page" : undefined}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-xs transition-colors hover:bg-[color:var(--card-hover)] focus:bg-[color:var(--card-hover)] focus:outline-none"
                  style={{ color: ativa ? "var(--accent)" : "var(--text-muted)" }}
                >
                  {item.rotulo}
                  {ativa && (
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: "var(--accent)" }}
                      aria-hidden="true"
                    />
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );
}
