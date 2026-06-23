"use client";

import { useActionState, useState } from "react";
import { entrar, cadastrar, type EstadoAuth } from "./actions";

const estadoInicial: EstadoAuth = {};

export default function LoginForm() {
  const [modo, setModo] = useState<"entrar" | "cadastrar">("entrar");
  const acao = modo === "entrar" ? entrar : cadastrar;
  const [estado, formAction, pending] = useActionState(acao, estadoInicial);

  const ehCadastro = modo === "cadastrar";

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8">
        <h2 className="text-2xl font-semibold tracking-tight" style={{ color: "var(--text)" }}>
          {ehCadastro ? "Criar acesso" : "Acesso a central"}
        </h2>
        <p className="text-sm mt-1.5" style={{ color: "var(--text-muted)" }}>
          {ehCadastro
            ? "Cadastre um operador para monitorar as frotas."
            : "Entre para acompanhar as frotas em tempo real."}
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        {ehCadastro && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nome" className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Nome
            </label>
            <input
              id="nome"
              name="nome"
              type="text"
              autoComplete="name"
              required
              placeholder="Seu nome"
              className="px-3.5 py-2.5 rounded-lg text-sm outline-none transition-colors"
              style={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                color: "var(--text)",
              }}
            />
          </div>
        )}

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
            autoComplete={ehCadastro ? "new-password" : "current-password"}
            required
            placeholder={ehCadastro ? "Ao menos 6 caracteres" : "Sua senha"}
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
          {pending ? "Aguarde..." : ehCadastro ? "Criar e entrar" : "Entrar"}
        </button>
      </form>

      <div className="mt-6 text-sm" style={{ color: "var(--text-muted)" }}>
        {ehCadastro ? "Ja tem acesso? " : "Primeiro acesso? "}
        <button
          type="button"
          onClick={() => setModo(ehCadastro ? "entrar" : "cadastrar")}
          className="font-medium underline-offset-4 hover:underline"
          style={{ color: "var(--accent)" }}
        >
          {ehCadastro ? "Entrar" : "Criar acesso"}
        </button>
      </div>
    </div>
  );
}
