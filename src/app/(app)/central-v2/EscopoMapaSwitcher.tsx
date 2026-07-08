"use client";

// Alternador TODOS / AMBOS (lado a lado) / SELECIONADOS do mapa — clique
// direto num rotulo OU arraste o thumb pelos 3 estados (estilo iPad Split
// View / segmented control da Apple: extremo esquerdo = so "todos", extremo
// direito = so "selecionados", meio = os dois lado a lado).
// Reaproveita o estado ja existente de veiculosSelecionados/modoSelecionados
// + o novo splitView do MonitorV2 — este componente e so a interacao visual.
import { useEffect, useRef } from "react";
import { motion, useMotionValue, useTransform, animate as animateValue } from "framer-motion";

export type EscopoMapa = "todos" | "ambos" | "selecionados";

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

const LARGURA = 320;
const ALTURA = 34;
const PAD = 3;
const TERCO = (LARGURA - PAD * 2) / 3;
const SPRING = { type: "spring" as const, stiffness: 520, damping: 40 };

const POSICAO: Record<EscopoMapa, number> = { todos: 0, ambos: TERCO, selecionados: TERCO * 2 };

export default function EscopoMapaSwitcher({
  modo, totalSelecionados, temSelecao, onEscolher, onAbrirSeletor,
  tema, accent, border, muted,
}: Props) {
  const x = useMotionValue(POSICAO[modo]);
  const arrastandoRef = useRef(false);
  // Cor dos rotulos reage CONTINUAMENTE a posicao do thumb durante o arrasto
  // (nao so no fim) — o toque "vivo" que faz a interacao parecer boa.
  const corTodos = useTransform(x, [0, TERCO], ["#ffffff", muted]);
  const corAmbosEsq = useTransform(x, [0, TERCO], [muted, "#ffffff"]);
  const corAmbosDir = useTransform(x, [TERCO, TERCO * 2], ["#ffffff", muted]);
  const corSelecionados = useTransform(x, [TERCO, TERCO * 2], [muted, "#ffffff"]);

  useEffect(() => {
    if (arrastandoRef.current) return;
    animateValue(x, POSICAO[modo], SPRING);
  }, [modo, x]);

  function escolher(next: EscopoMapa) {
    if (next !== "todos" && !temSelecao) {
      onAbrirSeletor();
      animateValue(x, POSICAO.todos, SPRING); // nada selecionado ainda: thumb volta pra "todos"
      return;
    }
    if (next !== modo) onEscolher(next);
    animateValue(x, POSICAO[next], SPRING);
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
          x, position: "absolute", top: PAD, left: PAD,
          width: TERCO, height: ALTURA - PAD * 2,
          borderRadius: (ALTURA - PAD * 2) / 2,
          background: accent, cursor: "grab", zIndex: 2,
        }}
        dragConstraints={{ left: 0, right: TERCO * 2 }}
        dragElastic={0.06}
        dragMomentum={false}
        whileDrag={{ cursor: "grabbing" }}
        onDragStart={() => { arrastandoRef.current = true; }}
        onDragEnd={(_, info) => {
          arrastandoRef.current = false;
          // Lado mais proximo (das 3 posicoes) + um empurrao de velocidade
          // (flick rapido tambem completa a troca — feel Apple).
          const posComVelocidade = x.get() + info.velocity.x * 0.12;
          const alvo: EscopoMapa =
            posComVelocidade < TERCO / 2 ? "todos"
            : posComVelocidade < TERCO * 1.5 ? "ambos"
            : "selecionados";
          escolher(alvo);
        }}
      />

      <motion.button
        onClick={() => escolher("todos")}
        style={{
          position: "relative", zIndex: 1, flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {/* zIndex 3: acima do thumb (zIndex 2) — senao o rotulo do segmento
            ATIVO fica escondido embaixo do thumb opaco (bug achado ao vivo). */}
        <motion.span style={{
          position: "relative", zIndex: 3, color: corTodos,
          fontSize: 10.5, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}>
          TODOS
        </motion.span>
      </motion.button>

      <motion.button
        onClick={() => escolher("ambos")}
        style={{
          position: "relative", zIndex: 1, flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
        }}
      >
        <motion.span style={{
          position: "relative", zIndex: 3, color: corAmbosEsq,
          fontSize: 10.5, fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}>◧</motion.span>
        <span style={{
          position: "relative", zIndex: 3, color: modo === "ambos" ? "#fff" : muted,
          fontSize: 10.5, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}>
          AMBOS
        </span>
        <motion.span style={{
          position: "relative", zIndex: 3, color: corAmbosDir,
          fontSize: 10.5, fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}>◨</motion.span>
      </motion.button>

      <motion.button
        onClick={() => escolher("selecionados")}
        style={{
          position: "relative", zIndex: 1, flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        }}
      >
        <motion.span style={{
          position: "relative", zIndex: 3, color: corSelecionados,
          fontSize: 10.5, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}>
          SELECIONADOS
        </motion.span>
        {totalSelecionados > 0 && (
          <span style={{
            position: "relative", zIndex: 3,
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
