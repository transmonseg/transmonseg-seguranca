"use client";

// Alternador "TODOS" x "SELECIONADOS" do mapa — clique direto num rotulo OU
// arraste o thumb (estilo iPad Split View / segmented control da Apple).
// Reaproveita o estado ja existente de veiculosSelecionados/modoSelecionados
// do MonitorV2 — este componente e so a interacao visual, nao dono do estado.
import { useEffect, useRef } from "react";
import { motion, useMotionValue, useTransform, animate as animateValue } from "framer-motion";

export type EscopoMapa = "todos" | "selecionados";

type Props = {
  modo: EscopoMapa;
  totalSelecionados: number;
  temSelecao: boolean;
  onEscolher: (modo: EscopoMapa) => void;
  onAbrirSeletor: () => void;
  tema: "dark" | "light";
  accent: string;
  border: string;
  muted: string;
};

const LARGURA = 252;
const ALTURA = 34;
const PAD = 3;
const METADE = (LARGURA - PAD * 2) / 2;
const SPRING = { type: "spring" as const, stiffness: 520, damping: 40 };

export default function EscopoMapaSwitcher({
  modo, totalSelecionados, temSelecao, onEscolher, onAbrirSeletor,
  tema, accent, border, muted,
}: Props) {
  const x = useMotionValue(modo === "todos" ? 0 : METADE);
  const arrastandoRef = useRef(false);
  // Cor dos rotulos reage CONTINUAMENTE a posicao do thumb durante o arrasto
  // (nao so no fim) — o toque "vivo" que faz a interacao parecer boa.
  const corTodos = useTransform(x, [0, METADE], ["#ffffff", muted]);
  const corSelecionados = useTransform(x, [0, METADE], [muted, "#ffffff"]);

  useEffect(() => {
    if (arrastandoRef.current) return;
    animateValue(x, modo === "todos" ? 0 : METADE, SPRING);
  }, [modo, x]);

  function escolher(next: EscopoMapa) {
    if (next === "selecionados" && !temSelecao) {
      onAbrirSeletor();
      animateValue(x, 0, SPRING); // nada selecionado ainda: thumb volta pra "todos"
      return;
    }
    if (next !== modo) onEscolher(next);
    animateValue(x, next === "todos" ? 0 : METADE, SPRING);
  }

  return (
    <div
      style={{
        position: "relative", width: LARGURA, height: ALTURA,
        borderRadius: ALTURA / 2,
        background: tema === "dark" ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.9)",
        backdropFilter: "blur(8px)",
        border: `1px solid ${border}`,
        boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
        display: "flex", alignItems: "center",
        padding: PAD, userSelect: "none",
      }}
    >
      <motion.div
        drag="x"
        style={{
          x, position: "absolute", top: PAD, left: 0,
          width: METADE, height: ALTURA - PAD * 2,
          borderRadius: (ALTURA - PAD * 2) / 2,
          background: accent, cursor: "grab", zIndex: 2,
        }}
        dragConstraints={{ left: 0, right: METADE }}
        dragElastic={0.1}
        dragMomentum={false}
        whileDrag={{ cursor: "grabbing" }}
        onDragStart={() => { arrastandoRef.current = true; }}
        onDragEnd={(_, info) => {
          arrastandoRef.current = false;
          // Lado mais proximo + um empurrao de velocidade (flick rapido tambem
          // completa a troca mesmo sem arrastar ate a metade — feel Apple).
          const posComVelocidade = x.get() + info.velocity.x * 0.12;
          escolher(posComVelocidade > METADE / 2 ? "selecionados" : "todos");
        }}
      />

      <motion.button
        onClick={() => escolher("todos")}
        style={{
          position: "relative", zIndex: 1, flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: corTodos,
          fontSize: 11, fontWeight: 700, letterSpacing: ".04em",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}
      >
        TODOS
      </motion.button>

      <motion.button
        onClick={() => escolher("selecionados")}
        style={{
          position: "relative", zIndex: 1, flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          color: corSelecionados,
          fontSize: 11, fontWeight: 700, letterSpacing: ".04em",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}
      >
        SELECIONADOS
        {totalSelecionados > 0 && (
          <span style={{
            fontSize: 9, fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            background: modo === "selecionados" ? "rgba(255,255,255,0.22)" : `${accent}22`,
            color: modo === "selecionados" ? "#fff" : accent,
            borderRadius: 8, padding: "1px 5px", fontWeight: 800,
          }}>
            {totalSelecionados}
          </span>
        )}
      </motion.button>
    </div>
  );
}
