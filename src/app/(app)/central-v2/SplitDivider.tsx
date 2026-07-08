"use client";

// Divisor arrastavel entre os 2 paineis de mapa no modo "ambos" (split view).
// Pointer events puros (nao framer-motion "drag") de proposito: o valor que
// importa aqui e a RAZAO derivada da posicao do ponteiro dentro do container
// (nao um deslocamento proprio do elemento), entao usar "drag" da lib
// duplicaria o movimento (transform da lib + reposicionamento via `left`).
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number; // 0..1 — largura do painel esquerdo
  onChange: (r: number) => void;
  accent: string;
};

const RATIO_MIN = 0.18;
const RATIO_MAX = 0.82;

export default function SplitDivider({ containerRef, ratio, onChange, accent }: Props) {
  const arrastandoRef = useRef(false);
  const [hover, setHover] = useState(false);
  const [arrastando, setArrastando] = useState(false);

  const mover = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const nova = (clientX - rect.left) / rect.width;
    onChange(Math.min(RATIO_MAX, Math.max(RATIO_MIN, nova)));
  }, [containerRef, onChange]);

  useEffect(() => {
    function onMove(e: PointerEvent) { if (arrastandoRef.current) mover(e.clientX); }
    function onUp() {
      if (!arrastandoRef.current) return;
      arrastandoRef.current = false;
      setArrastando(false);
      // Nudge pro Google Maps recalcular o tamanho do container apos o resize.
      window.dispatchEvent(new Event("resize"));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [mover]);

  const ativo = hover || arrastando;

  return (
    <div
      onPointerDown={(e) => { arrastandoRef.current = true; setArrastando(true); mover(e.clientX); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute", top: 0, bottom: 0,
        left: `calc(${ratio * 100}% - 11px)`, width: 22,
        cursor: "col-resize", zIndex: 60, touchAction: "none",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{
        width: ativo ? 5 : 3, height: ativo ? 56 : 40, borderRadius: 3,
        background: accent, opacity: ativo ? 1 : 0.55,
        boxShadow: ativo ? `0 2px 14px ${accent}66` : "0 2px 8px rgba(0,0,0,0.35)",
        transition: "width .12s, height .12s, opacity .12s",
      }} />
    </div>
  );
}
