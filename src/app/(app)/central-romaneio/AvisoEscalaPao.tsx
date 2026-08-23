"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";

// Aviso NÃO bloqueante: a escala do Pão do dia não subiu. Decisão do usuário
// (23/08) -- só o romaneio é obrigatório pra liberar o mapa, a escala nunca
// trava a tela.
//
// De propósito sem --vermelho/--amarelo: nesta casa essas cores são semáforo
// de RISCO (veículo em desvio, tiroteio). Arquivo faltando não é risco --
// vira ruído se competir visualmente com um alerta de verdade. Hierarquia
// aqui é tipográfica + --accent.
// O "dispensei este aviso" vive no sessionStorage, não em useState: qualquer
// router.refresh() disparado pelo MonitorV2 (resolver alerta, trocar cliente)
// remonta esta faixa, e trazer de volta um aviso que o operador já fechou é
// o tipo de ruído que faz gente parar de ler aviso. sessionStorage é um
// sistema externo ao React, então a leitura é via useSyncExternalStore --
// sem efeito que chama setState no mount (e sem mismatch de hidratação: no
// servidor a resposta é sempre "não dispensado").
const ouvintes = new Set<() => void>();

function assinarDispensa(aoMudar: () => void) {
  ouvintes.add(aoMudar);
  return () => { ouvintes.delete(aoMudar); };
}

export default function AvisoEscalaPao({ hoje }: { hoje: string }) {
  const chave = `aviso-escala-pao-dispensado:${hoje}`;

  const dispensado = useSyncExternalStore(
    assinarDispensa,
    () => window.sessionStorage.getItem(chave) === "1",
    () => false
  );

  if (dispensado) return null;

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 border-b animate-fade-in"
      style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
      role="status"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="flex-shrink-0">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8h.01M11 12h1v4h1" />
      </svg>
      <p className="text-xs flex-1 min-w-0" style={{ color: "var(--text-muted)" }}>
        <span className="font-semibold" style={{ color: "var(--text)" }}>
          Escala do Pão de hoje não foi enviada.
        </span>{" "}
        O mapa está no ar com o romaneio; os pontos da escala entram assim que o arquivo subir.
      </p>
      <Link
        href="/romaneio"
        className="text-xs font-medium px-2.5 py-1 rounded flex-shrink-0 transition-colors hover:bg-[color:var(--card-hover)]"
        style={{ color: "var(--accent)", border: "1px solid var(--border)" }}
      >
        Configurar Romaneio
      </Link>
      <button
        type="button"
        onClick={() => {
          window.sessionStorage.setItem(chave, "1");
          for (const aoMudar of ouvintes) aoMudar();
        }}
        aria-label="Dispensar aviso"
        title="Dispensar"
        className="flex items-center justify-center w-6 h-6 rounded flex-shrink-0 transition-colors hover:bg-[color:var(--card-hover)]"
        style={{ color: "var(--text-dim)" }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
