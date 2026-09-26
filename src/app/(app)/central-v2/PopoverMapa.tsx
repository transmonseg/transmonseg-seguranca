"use client";

// Popover "Mapa" da toolbar (26/09, redesign estilo Apple). Junta num lugar so'
// os controles de visualizacao do mapa que antes eram 7 botoes soltos na
// toolbar (RUA/QUADRA/BAIRRO/CIDADE, VEICULOS, SAT, TRANSITO). Cada item chama
// EXATAMENTE a mesma funcao que o botao antigo chamava -- so' mudou o lugar.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { material, RAIO, TIPO, MOLA, FONT_SANS, type TemaT } from "./design";

export interface PopoverMapaProps {
  tema: "dark" | "light";
  T: TemaT;
  zoomLabels: [string, number][];
  onZoom: (z: number) => void;
  // Opcional: destaca o nivel de zoom atual (o botao antigo fazia isso).
  zoomAtual?: number;
  onEnquadrarFrota: () => void;
  satelite: boolean; onSatelite: (v: boolean) => void;
  trafego: boolean; onTrafego: (v: boolean) => void;
}

// Mesmo valor de Z.settings no MonitorV2 (900). O painel vive DENTRO do
// container da toolbar (zIndex 1500, stacking context proprio), entao ja
// pinta acima do mapa; esse zIndex so' ordena contra os irmaos da toolbar.
const Z_POPOVER = 900;

function Switch({ ligado, T }: { ligado: boolean; T: TemaT }) {
  return (
    <span aria-hidden style={{
      display: "inline-block", position: "relative", width: 36, height: 22, borderRadius: RAIO.capsule, flexShrink: 0,
      background: ligado ? T.green : T.border, transition: "background .2s",
    }}>
      <motion.span
        animate={{ x: ligado ? 16 : 2 }}
        transition={MOLA}
        style={{
          position: "absolute", top: 2, left: 0, width: 18, height: 18, borderRadius: "50%",
          background: "#ffffff", boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        }}
      />
    </span>
  );
}

export default function PopoverMapa(props: PopoverMapaProps): React.JSX.Element {
  const { tema, T, zoomLabels, onZoom, zoomAtual, onEnquadrarFrota, satelite, onSatelite, trafego, onTrafego } = props;
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setAberto(false); }
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [aberto]);

  const linha: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 10, width: "100%",
    height: 36, padding: "0 10px", borderRadius: RAIO.control,
    background: "transparent", border: "none", cursor: "pointer",
    color: T.text, fontFamily: FONT_SANS, ...TIPO.body, textAlign: "left",
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setAberto(v => !v)}
        aria-expanded={aberto}
        aria-haspopup="dialog"
        title="Opcoes do mapa"
        style={{
          display: "flex", alignItems: "center", gap: 6,
          height: 30, padding: "0 12px", borderRadius: RAIO.capsule, cursor: "pointer",
          fontSize: 13, fontWeight: 500, fontFamily: FONT_SANS,
          color: aberto ? T.accent : T.text,
          background: aberto ? T.accentDim : "transparent",
          border: `1px solid ${aberto ? "transparent" : T.border}`,
          transition: "background .12s, color .12s",
        }}>
        Mapa
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: aberto ? "rotate(180deg)" : "none", transition: "transform .2s" }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <AnimatePresence>
        {aberto && (
          <motion.div
            role="dialog"
            aria-label="Opcoes do mapa"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={MOLA}
            style={{
              position: "absolute", top: 36, right: 0, width: 260,
              ...material(tema),
              borderRadius: RAIO.panel, padding: 8, zIndex: Z_POPOVER,
              transformOrigin: "top right", fontFamily: FONT_SANS,
            }}>
            <div style={{ ...TIPO.caption, color: T.muted, padding: "4px 6px 6px" }}>Zoom</div>
            <div style={{
              display: "flex", gap: 2, padding: 2, borderRadius: RAIO.capsule,
              background: tema === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
            }}>
              {zoomLabels.map(([label, z]) => {
                const ativo = zoomAtual === z;
                return (
                  <button key={label} onClick={() => onZoom(z)}
                    style={{
                      flex: 1, height: 28, borderRadius: RAIO.capsule, cursor: "pointer",
                      border: "none", fontFamily: FONT_SANS, fontSize: 12, fontWeight: ativo ? 600 : 500,
                      background: ativo ? T.thumb : "transparent",
                      boxShadow: ativo ? T.thumbShadow : "none",
                      color: ativo ? T.text : T.muted,
                      transition: "background .12s, color .12s",
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>

            <button onClick={onEnquadrarFrota} style={{ ...linha, marginTop: 6 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
              </svg>
              Enquadrar frota
            </button>

            <div style={{ height: 0.5, background: T.border, margin: "6px 4px" }} />

            <button onClick={() => onSatelite(!satelite)} role="switch" aria-checked={satelite} style={linha}>
              Satélite
              <span style={{ marginLeft: "auto", display: "flex" }}><Switch ligado={satelite} T={T} /></span>
            </button>
            <button onClick={() => onTrafego(!trafego)} role="switch" aria-checked={trafego} style={linha}>
              Trânsito
              <span style={{ marginLeft: "auto", display: "flex" }}><Switch ligado={trafego} T={T} /></span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
