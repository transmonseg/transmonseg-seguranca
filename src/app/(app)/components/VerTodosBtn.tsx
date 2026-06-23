"use client";

import { useState } from "react";

interface VerTodosBtnProps {
  totalOcultos: number;
  children: React.ReactNode;
}

export default function VerTodosBtn({ totalOcultos, children }: VerTodosBtnProps) {
  const [expandido, setExpandido] = useState(false);

  if (totalOcultos <= 0) return null;

  if (expandido) {
    return (
      <div className="mt-3 animate-fade-in">
        {children}
        <button
          onClick={() => setExpandido(false)}
          className="mt-3 text-xs cursor-pointer transition-colors"
          style={{ color: "var(--text-dim)", background: "none", border: "none", outline: "none", padding: 0 }}
        >
          Recolher
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-between px-4 py-3 rounded-xl border mt-3"
      style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
    >
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        <span className="num-mono font-semibold" style={{ fontFamily: "var(--font-geist-mono, monospace)", color: "var(--text)" }}>
          +{totalOcultos}
        </span>
        {" "}outros em operacao
      </span>
      <button
        onClick={() => setExpandido(true)}
        className="text-xs font-medium cursor-pointer transition-colors"
        style={{ color: "var(--accent)", background: "none", border: "none", outline: "none", padding: 0 }}
      >
        Ver todos
      </button>
    </div>
  );
}
