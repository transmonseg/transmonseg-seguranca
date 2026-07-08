"use client";

// Divisor arrastavel entre os 2 paineis de mapa no modo "ambos" (split view).
// Arrastar ate a borda e SOLTAR funde os 2 paineis num so, tela cheia do
// lado que sobrou -- igual arrastar uma aba de janela ate a beirada e
// "encaixar" (o pedido explicito do usuario: "tipo um navegador do Chrome
// no MacBook"). Pointer events puros (nao framer-motion "drag") de
// proposito: o valor que importa aqui e a RAZAO derivada da posicao do
// ponteiro dentro do container (nao um deslocamento proprio do elemento),
// entao usar "drag" da lib duplicaria o movimento (transform da lib +
// reposicionamento via `left`).
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number; // 0..1 — largura do painel esquerdo
  onChange: (r: number) => void;
  // Arrastou ate encostar numa borda e soltou: fundir pra tela cheia do
  // lado indicado (o outro painel "fecha").
  onFundir: (ladoQueFicaCheio: "todos" | "selecionados") => void;
  accent: string;
};

const RATIO_MIN = 0.12;
const RATIO_MAX = 0.88;
// Distancia da borda (em fracao 0..1) a partir da qual soltar o arrasto
// funde pra tela cheia em vez de so deixar um painel bem fino.
const LIMIAR_FUSAO = 0.03;

export default function SplitDivider({ containerRef, ratio, onChange, onFundir, accent }: Props) {
  const arrastandoRef = useRef(false);
  const ultimaRatioRef = useRef(ratio);
  const [hover, setHover] = useState(false);
  const [arrastando, setArrastando] = useState(false);

  const mover = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const bruta = (clientX - rect.left) / rect.width;
    const nova = Math.min(RATIO_MAX, Math.max(RATIO_MIN, bruta));
    ultimaRatioRef.current = bruta; // guarda a bruta (antes do clamp) pra detectar "empurrou ate a borda"
    onChange(nova);
  }, [containerRef, onChange]);

  useEffect(() => {
    function onMove(e: PointerEvent) { if (arrastandoRef.current) mover(e.clientX); }
    function onUp() {
      if (!arrastandoRef.current) return;
      arrastandoRef.current = false;
      setArrastando(false);
      const r = ultimaRatioRef.current;
      if (r <= RATIO_MIN + LIMIAR_FUSAO) { onFundir("selecionados"); return; }
      if (r >= RATIO_MAX - LIMIAR_FUSAO) { onFundir("todos"); return; }
      // Nudge pro Google Maps recalcular o tamanho do container apos o resize.
      window.dispatchEvent(new Event("resize"));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [mover, onFundir]);

  const ativo = hover || arrastando;
  // Perto o bastante da borda pra "prender" na fusao: da uma dica visual
  // (fica vermelho-ish/mais saturado) antes mesmo de soltar.
  const pertoDaFusao = arrastando && (ratio <= RATIO_MIN + LIMIAR_FUSAO + 0.02 || ratio >= RATIO_MAX - LIMIAR_FUSAO - 0.02);

  return (
    <div
      onPointerDown={(e) => { arrastandoRef.current = true; setArrastando(true); ultimaRatioRef.current = ratio; mover(e.clientX); }}
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
        background: pertoDaFusao ? "#ef4444" : accent,
        opacity: ativo ? 1 : 0.55,
        boxShadow: ativo ? `0 2px 14px ${(pertoDaFusao ? "#ef4444" : accent)}66` : "0 2px 8px rgba(0,0,0,0.35)",
        transition: "width .12s, height .12s, opacity .12s, background .12s",
      }} />
    </div>
  );
}
