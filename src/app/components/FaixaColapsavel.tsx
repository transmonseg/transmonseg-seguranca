"use client";

import { useState } from "react";

interface FaixaColapsavelProps {
  label: string;
  count: number;
  cor?: string;
  icone: React.ReactNode;
  children: React.ReactNode;
}

export default function FaixaColapsavel({
  label,
  count,
  cor,
  icone,
  children,
}: FaixaColapsavelProps) {
  const [aberto, setAberto] = useState(false);
  const corEfetiva = cor ?? "var(--text-muted)";

  if (count === 0) return null;

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
    >
      <button
        onClick={() => setAberto((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer transition-colors hover:bg-white/5"
        style={{ background: "transparent", border: "none", outline: "none" }}
      >
        <div className="flex items-center gap-3">
          <span style={{ color: corEfetiva }}>{icone}</span>
          <span className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
            {label}
          </span>
          <span
            className="num-mono text-xs font-bold px-2 py-0.5 rounded-md"
            style={{
              fontFamily: "var(--font-geist-mono, monospace)",
              backgroundColor: "var(--border)",
              color: "var(--text-muted)",
            }}
          >
            {count}
          </span>
        </div>

        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-dim)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: aberto ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
            flexShrink: 0,
          }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {aberto && (
        <div className="px-4 pb-4 animate-fade-in">
          <div
            className="pt-3 border-t"
            style={{ borderColor: "var(--border)" }}
          >
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
