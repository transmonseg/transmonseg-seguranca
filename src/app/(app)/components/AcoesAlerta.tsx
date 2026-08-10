"use client";

import { useTransition, useState } from "react";
import { reconhecerAlerta, resolverAlerta, marcarFalsoPositivo, marcarFalsoPositivoDadoErrado } from "../acoes-alertas";
import CronometroSLA from "./CronometroSLA";

type Acao = (id: string) => Promise<{ ok?: boolean; erro?: string }>;

function Btn({
  onClick, pending, children, cor, titulo,
}: {
  onClick: () => void; pending: boolean; children: React.ReactNode; cor: string; titulo: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={titulo}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all active:translate-y-px disabled:opacity-50"
      style={{ border: `1px solid color-mix(in srgb, ${cor} 25%, transparent)`, color: cor, backgroundColor: `color-mix(in srgb, ${cor} 8%, transparent)` }}
    >
      {children}
    </button>
  );
}

export default function AcoesAlerta({
  id, status, desde, onSucesso,
}: {
  id: string; status: string; desde: string; onSucesso?: (id: string) => void;
}) {
  const [pending, start] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const reconhecido = status === "reconhecido";

  const exec = (fn: Acao, sucesso = false) =>
    start(async () => {
      setErro(null);
      const r = await fn(id);
      if (r?.erro) setErro(r.erro);
      else if (sucesso) onSucesso?.(id);
    });

  return (
    <div className="mt-4 pt-3.5" style={{ borderTop: "1px solid var(--border-subtle)" }}>
      <div className="mb-2.5">
        <CronometroSLA desde={desde} />
      </div>
      {reconhecido && (
        <div className="flex items-center gap-1.5 mb-2.5 text-xs" style={{ color: "var(--accent)" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Em atendimento por um operador
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {!reconhecido && (
          <Btn onClick={() => exec(reconhecerAlerta)} pending={pending} cor="var(--accent)" titulo="Assumir o atendimento">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Reconhecer
          </Btn>
        )}
        <Btn onClick={() => exec(resolverAlerta, true)} pending={pending} cor="var(--verde)" titulo="Encerrar: tratado">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Resolver
        </Btn>
        <Btn onClick={() => exec(marcarFalsoPositivo, true)} pending={pending} cor="var(--text-muted)" titulo="Engano: silencia o tipo por 2h e ensina o sistema">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Falso positivo
        </Btn>
        <Btn onClick={() => exec(marcarFalsoPositivoDadoErrado, true)} pending={pending} cor="var(--text-muted)" titulo="Marcação/endereço errado: silencia o tipo por 2h e NÃO conta contra o detector">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
            <line x1="9" y1="12" x2="15" y2="12" />
          </svg>
          Marcação errada
        </Btn>
        {pending && <span className="text-xs" style={{ color: "var(--text-dim)" }}>salvando...</span>}
      </div>
      {erro && <p className="text-xs mt-2" style={{ color: "var(--vermelho)" }}>{erro}</p>}
    </div>
  );
}
