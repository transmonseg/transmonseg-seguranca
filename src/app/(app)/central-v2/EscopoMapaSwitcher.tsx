"use client";

// Alternador TODOS / AMBOS (lado a lado) / SELECIONADOS / ROMANEIO do mapa —
// clique direto num rotulo OU arraste o thumb pelos 4 estados (estilo iPad
// Split View / segmented control da Apple). ROMANEIO (18/07): mostra so os
// veiculos com romaneio geocodificado hoje -- modo exclusivo, nao combina
// com "ambos" (ver docs/superpowers/specs/2026-07-18-modo-romaneio-escopo-mapa-design.md).
// Reaproveita o estado ja existente de veiculosSelecionados/modoSelecionados
// + splitView + o novo modoRomaneio do MonitorV2 — este componente e so a
// interacao visual.
import { useEffect, useRef } from "react";
import { motion, useMotionValue, useTransform, animate as animateValue } from "framer-motion";

export type EscopoMapa = "todos" | "ambos" | "selecionados" | "romaneio";

type Props = {
  modo: EscopoMapa;
  totalSelecionados: number;
  temSelecao: boolean;
  totalComRomaneio: number;
  onEscolher: (modo: EscopoMapa) => void;
  onAbrirSeletor: () => void;
  tema: "dark" | "light";
  accent: string;
  // Achado real 03/09 (reclamacao no grupo + reproduzido ao vivo com
  // Puppeteer): cor de texto que CONTRASTA com `accent` -- nao pode ser
  // sempre branco fixo, porque o accent do tema escuro e' um azul pastel
  // claro (branco sobre ele fica ilegivel). Ver comentario da definicao em
  // MonitorV2.tsx.
  accentFg: string;
  border: string;
  muted: string;
};

const LARGURA = 425;
const ALTURA = 34;
const PAD = 3;
const QUARTO = (LARGURA - PAD * 2) / 4;
const SPRING = { type: "spring" as const, stiffness: 520, damping: 40 };

const POSICAO: Record<EscopoMapa, number> = {
  todos: 0,
  ambos: QUARTO,
  selecionados: QUARTO * 2,
  romaneio: QUARTO * 3,
};

export default function EscopoMapaSwitcher({
  modo, totalSelecionados, temSelecao, totalComRomaneio, onEscolher, onAbrirSeletor,
  tema, accent, accentFg, border, muted,
}: Props) {
  const x = useMotionValue(POSICAO[modo]);
  const arrastandoRef = useRef(false);
  // Cor dos rotulos reage CONTINUAMENTE a posicao do thumb durante o arrasto
  // (nao so no fim) — o toque "vivo" que faz a interacao parecer boa. So os
  // extremos (todos/romaneio) tem esse efeito continuo; os 2 do meio
  // (ambos/selecionados) so trocam de cor no fim do arrasto (mesmo
  // comportamento que "ambos" ja tinha antes da 4a opcao existir).
  const corTodos = useTransform(x, [0, QUARTO], [accentFg, muted]);
  const corRomaneio = useTransform(x, [QUARTO * 2, QUARTO * 3], [muted, accentFg]);

  useEffect(() => {
    if (arrastandoRef.current) return;
    animateValue(x, POSICAO[modo], SPRING);
  }, [modo, x]);

  function escolher(next: EscopoMapa) {
    // ROMANEIO nao exige selecao previa (diferente de ambos/selecionados) --
    // conta com o que o romaneio importado hoje ja trouxe, mesmo que seja 0.
    if (next !== "todos" && next !== "romaneio" && !temSelecao) {
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
          width: QUARTO, height: ALTURA - PAD * 2,
          borderRadius: (ALTURA - PAD * 2) / 2,
          background: accent, cursor: "grab", zIndex: 2,
        }}
        dragConstraints={{ left: 0, right: QUARTO * 3 }}
        dragElastic={0.06}
        dragMomentum={false}
        whileDrag={{ cursor: "grabbing" }}
        onDragStart={() => { arrastandoRef.current = true; }}
        onDragEnd={(_, info) => {
          arrastandoRef.current = false;
          // Lado mais proximo (das 4 posicoes) + um empurrao de velocidade
          // (flick rapido tambem completa a troca — feel Apple).
          const posComVelocidade = x.get() + info.velocity.x * 0.12;
          const alvo: EscopoMapa =
            posComVelocidade < QUARTO / 2 ? "todos"
            : posComVelocidade < QUARTO * 1.5 ? "ambos"
            : posComVelocidade < QUARTO * 2.5 ? "selecionados"
            : "romaneio";
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
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <span style={{
          position: "relative", zIndex: 3, color: modo === "ambos" ? accentFg : muted,
          fontSize: 10.5, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}>
          AMBOS
        </span>
      </motion.button>

      <motion.button
        onClick={() => escolher("selecionados")}
        style={{
          position: "relative", zIndex: 1, flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        }}
      >
        <span style={{
          position: "relative", zIndex: 3, color: modo === "selecionados" ? accentFg : muted,
          fontSize: 10.5, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}>
          SELECIONADOS
        </span>
        {totalSelecionados > 0 && (
          <span style={{
            position: "relative", zIndex: 3,
            fontSize: 9, fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            background: modo === "selecionados" ? `color-mix(in srgb, ${accentFg} 22%, transparent)` : `${accent}22`,
            color: modo === "selecionados" ? accentFg : accent,
            borderRadius: 8, padding: "1px 5px", fontWeight: 800,
          }}>
            {totalSelecionados}
          </span>
        )}
      </motion.button>

      <motion.button
        onClick={() => escolher("romaneio")}
        style={{
          position: "relative", zIndex: 1, flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        }}
      >
        <motion.span style={{
          position: "relative", zIndex: 3, color: corRomaneio,
          fontSize: 10.5, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: "var(--font-geist), system-ui, sans-serif",
        }}>
          ROMANEIO
        </motion.span>
        {totalComRomaneio > 0 && (
          <span style={{
            position: "relative", zIndex: 3,
            fontSize: 9, fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            background: modo === "romaneio" ? `color-mix(in srgb, ${accentFg} 22%, transparent)` : `${accent}22`,
            color: modo === "romaneio" ? accentFg : accent,
            borderRadius: 8, padding: "1px 5px", fontWeight: 800,
          }}>
            {totalComRomaneio}
          </span>
        )}
      </motion.button>
    </div>
  );
}
