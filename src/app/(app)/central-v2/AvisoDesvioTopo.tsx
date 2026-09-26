"use client";

// Topo do mapa: pílula "Ver mais desvios (n)" que vira aviso destacado por
// 8 s quando chega alerta notificável novo, e abre a lista ao clicar. O mapa
// só se move por "ver no mapa". Spec:
// docs/superpowers/specs/2026-09-26-topo-mapa-aviso-desvio-design.md
import { useEffect, useRef, useState } from "react";
import {
  AVISO_DESVIO_MS, type ModoAviso, proximoModo, rotuloPilula, textoAviso, novosDoLoteNoEscopo,
} from "./aviso-desvio";

export type ItemAvisoDesvio = {
  id: string; placa: string; tipo: string; nivel: "critico" | "atencao";
  desde: string; lat: number | null; lng: number | null; cv: string;
};
export type CoresAviso = { red: string; yellow: string; text: string; muted: string; dim: string; border: string; card: string };

const FONT_MONO = "var(--font-geist-mono), ui-monospace, 'Cascadia Code', monospace";

export default function AvisoDesvioTopo(props: {
  itens: ItemAvisoDesvio[];
  lote: { ids: string[]; seq: number };
  left: string; width: string;
  compacto?: boolean;
  tema: "dark" | "light";
  cores: CoresAviso;
  nomeTipo: (tipo: string) => string;
  tempoAtras: (desde: string) => string;
  onVerNoMapa: (item: ItemAvisoDesvio) => void;
}) {
  const { itens, lote, cores, tema } = props;
  const n = itens.length;
  const [modo, setModo] = useState<ModoAviso>("pilula");
  const [texto, setTexto] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raiz = useRef<HTMLDivElement | null>(null);
  const seqVisto = useRef(lote.seq);

  // Lote novo do poll -> aviso (e reinicia os 8 s).
  useEffect(() => {
    if (lote.seq === seqVisto.current) return;
    seqVisto.current = lote.seq;
    const novos = novosDoLoteNoEscopo(lote.ids, itens);
    if (novos.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTexto(textoAviso(novos, props.nomeTipo));
    setModo(m => proximoModo(m, { tipo: "novos", quantidade: novos.length }, n));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setModo(m => proximoModo(m, { tipo: "timeout" }, n)), AVISO_DESVIO_MS);
  }, [lote.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // n caiu pra 0 (resolveram o último): fecha tudo.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (n === 0) setModo("pilula"); }, [n]);

  // Esc e clique fora fecham a lista.
  useEffect(() => {
    if (modo !== "lista") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setModo(m => proximoModo(m, { tipo: "fechar" }, n)); };
    const onDown = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setModo(m => proximoModo(m, { tipo: "fechar" }, n));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [modo, n]);

  const rotulo = rotuloPilula(n);
  if (!rotulo) return null;

  const clicar = () => setModo(m => proximoModo(m, { tipo: "clique" }, n));
  const fundo = tema === "dark" ? "rgba(10,10,10,0.9)" : "rgba(255,255,255,0.94)";

  return (
    <div style={{ position: "absolute", top: 56, left: props.left, width: props.width, display: "flex", justifyContent: "center", zIndex: 800, pointerEvents: "none" }}>
      <div ref={raiz} style={{ pointerEvents: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        {modo === "aviso" ? (
          <button type="button" onClick={clicar} style={{
            display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
            padding: props.compacto ? "7px 12px" : "9px 16px", borderRadius: 999,
            background: tema === "dark" ? "#1a0b0c" : "#fff1f1", border: `1px solid ${cores.red}`,
            boxShadow: `0 0 0 4px ${cores.red}2e, 0 8px 22px rgba(0,0,0,0.35)`,
            color: cores.text, fontWeight: 800, fontSize: props.compacto ? 12 : 13,
          }}>
            <span className="animate-pulse-live" style={{ width: 9, height: 9, borderRadius: "50%", background: cores.red }} />
            {texto}
          </button>
        ) : (
          <button type="button" onClick={clicar} aria-expanded={modo === "lista"} style={{
            display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
            padding: props.compacto ? "5px 11px" : "6px 13px", borderRadius: 999,
            background: fundo, border: `1px solid ${cores.red}66`, backdropFilter: "blur(6px)",
            color: cores.red, fontWeight: 800, fontSize: props.compacto ? 11 : 12,
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
          }}>
            {rotulo}<span aria-hidden style={{ fontSize: 10 }}>{modo === "lista" ? "▴" : "▾"}</span>
          </button>
        )}

        {modo === "lista" && (
          <div role="dialog" aria-label="Desvios abertos" style={{
            width: props.compacto ? 260 : 320, maxHeight: 320, overflowY: "auto",
            background: cores.card, border: `1px solid ${cores.border}`, borderRadius: 10, padding: 6,
            boxShadow: "0 14px 30px rgba(0,0,0,0.45)",
          }}>
            {itens.map(a => {
              const cor = a.nivel === "critico" ? cores.red : cores.yellow;
              return (
                <button key={a.id} type="button"
                  onClick={() => { props.onVerNoMapa(a); setModo(m => proximoModo(m, { tipo: "fechar" }, n)); }}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                    padding: "7px 8px", borderRadius: 7, background: "transparent", border: "none",
                    borderLeft: `3px solid ${cor}`, marginBottom: 2, color: cores.text, textAlign: "left",
                  }}>
                  <span style={{ fontFamily: FONT_MONO, fontWeight: 900, fontSize: 12 }}>{a.placa}</span>
                  <span style={{ fontSize: 10.5, color: cor, fontWeight: 700 }}>{props.nomeTipo(a.tipo)}</span>
                  <span suppressHydrationWarning style={{ fontSize: 10.5, color: cores.dim, fontFamily: FONT_MONO }}>{props.tempoAtras(a.desde)}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: cores.muted }}>ver no mapa →</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
