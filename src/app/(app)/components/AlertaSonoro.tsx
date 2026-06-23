"use client";

import { useEffect, useRef, useState } from "react";

// Apito da central: toca quando surge um NOVO alerta crítico (ex: tiroteio na
// rota de um caminhão). Precisa de um clique pra ativar (política de autoplay
// dos navegadores). Detecta novos comparando os IDs entre atualizações.
export default function AlertaSonoro({ criticosIds }: { criticosIds: string[] }) {
  const vistos = useRef<Set<string> | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const [ativo, setAtivo] = useState(false);

  function beep() {
    try {
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      const tocar = (t0: number, freq: number) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        o.start(t0);
        o.stop(t0 + 0.34);
      };
      const n = ctx.currentTime;
      tocar(n, 880);
      tocar(n + 0.4, 1040); // dois toques: chama atenção
    } catch {
      /* navegador sem áudio: silencioso */
    }
  }

  useEffect(() => {
    // primeira passagem: registra os atuais sem apitar (só apita NOVOS)
    if (vistos.current === null) {
      vistos.current = new Set(criticosIds);
      return;
    }
    const novos = criticosIds.filter((id) => !vistos.current!.has(id));
    for (const id of criticosIds) vistos.current!.add(id);
    if (novos.length > 0 && ativo) beep();
  }, [criticosIds, ativo]);

  function alternar() {
    try {
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      ctx.resume();
      if (!ativo) beep(); // confirma audível ao ligar
    } catch {
      /* ignora */
    }
    setAtivo((a) => !a);
  }

  return (
    <button
      type="button"
      onClick={alternar}
      title={ativo ? "Apito ligado: toca quando entra alerta crítico" : "Ativar apito de alerta crítico"}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors active:translate-y-px"
      style={{
        border: `1px solid ${ativo ? "color-mix(in srgb, var(--verde) 40%, transparent)" : "var(--border)"}`,
        color: ativo ? "var(--verde)" : "var(--text-muted)",
        backgroundColor: ativo ? "color-mix(in srgb, var(--verde) 8%, transparent)" : "var(--card)",
      }}
    >
      {ativo ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      )}
      {ativo ? "Apito ligado" : "Ativar apito"}
    </button>
  );
}
