"use client";

import { useActionState } from "react";
import { entrar, type EstadoAuth } from "./actions";

const estadoInicial: EstadoAuth = {};

export default function LoginForm() {
  const [estado, formAction, pending] = useActionState(entrar, estadoInicial);
  // Tela pedida antes do login (?volta=/escala): vai junto no envio.
  const enviar = (fd: FormData) => {
    fd.set("volta", new URLSearchParams(window.location.search).get("volta") ?? "");
    return formAction(fd);
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8">
        <h2 className="text-2xl font-semibold tracking-tight" style={{ color: "var(--text)" }}>
          Acesso a central
        </h2>
        <p className="text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
          Entre para acompanhar as frotas em tempo real.
        </p>
      </div>

      <form action={enviar} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="voce@transmonseg.com"
            className="px-3.5 py-2.5 rounded-lg text-sm outline-none transition-colors focus:border-[color:var(--accent)]"
            style={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--text)",
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="senha" className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Senha
          </label>
          <input
            id="senha"
            name="senha"
            type="password"
            autoComplete="current-password"
            required
            placeholder="Sua senha"
            className="px-3.5 py-2.5 rounded-lg text-sm outline-none transition-colors focus:border-[color:var(--accent)]"
            style={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--text)",
            }}
          />
        </div>

        {estado.erro && (
          <p
            className="text-xs px-3 py-2 rounded-lg animate-fade-in"
            style={{ backgroundColor: "rgba(239,68,68,0.1)", color: "var(--vermelho)", border: "1px solid rgba(239,68,68,0.2)" }}
          >
            {estado.erro}
          </p>
        )}
        {estado.ok && (
          <p
            className="text-xs px-3 py-2 rounded-lg animate-fade-in"
            style={{ backgroundColor: "rgba(34,197,94,0.1)", color: "var(--verde)", border: "1px solid rgba(34,197,94,0.2)" }}
          >
            {estado.ok}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="mt-1 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all active:translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ backgroundColor: "var(--accent)", color: "#0a0a0a" }}
        >
          {pending ? "Aguarde..." : "Entrar"}
        </button>
      </form>

      <p className="mt-6 text-sm" style={{ color: "var(--text-muted)" }}>
        Sem acesso? Peça um convite a quem administra o sistema.
      </p>
    </div>
  );
}
