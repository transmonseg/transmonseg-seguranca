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
import { RAIO, FONT_SANS, FONT_MONO, material, type Tema } from "./design";

export type EscopoMapa = "todos" | "ambos" | "selecionados" | "romaneio";

type Props = {
  modo: EscopoMapa;
  totalSelecionados: number;
  temSelecao: boolean;
  totalComRomaneio: number;
  onEscolher: (modo: EscopoMapa) => void;
  onAbrirSeletor: () => void;
  tema: Tema;
  accent: string;
  // 26/09 (redesign Apple): o thumb virou neutro (T.thumb/T.thumbShadow, ver
  // design.ts) em vez de colorido com `accent` -- por isso o rotulo ativo
  // passa a usar `text` (cor de texto primaria), que contrasta bem com um
  // thumb cinza/branco neutro nos dois temas (antes precisava de accentFg
  // pra contrastar com o thumb azul solido -- achado real 03/09).
  text: string;
  border: string;
  muted: string;
  // Opcionais pra nao quebrar quem ainda nao passa (default cai pro cinza
  // neutro do tema escuro, mas o caller real sempre passa T.thumb/T.thumbShadow).
  thumb?: string;
  thumbShadow?: string;
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
  tema, accent, text, border, muted, thumb, thumbShadow,
}: Props) {
  const x = useMotionValue(POSICAO[modo]);
  const arrastandoRef = useRef(false);
  const corThumb = thumb ?? (tema === "dark" ? "#636366" : "#ffffff");
  const sombraThumb = thumbShadow ?? (tema === "dark" ? "0 1px 3px rgba(0,0,0,0.4)" : "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)");
  // Cor dos rotulos reage CONTINUAMENTE a posicao do thumb durante o arrasto
  // (nao so no fim) — o toque "vivo" que faz a interacao parecer boa. So os
  // extremos (todos/romaneio) tem esse efeito continuo; os 2 do meio
  // (ambos/selecionados) so trocam de cor no fim do arrasto (mesmo
  // comportamento que "ambos" ja tinha antes da 4a opcao existir).
  const corTodos = useTransform(x, [0, QUARTO], [text, muted]);
  const corRomaneio = useTransform(x, [QUARTO * 2, QUARTO * 3], [muted, text]);

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
        borderRadius: RAIO.capsule,
        ...material(tema),
        border: `1px solid ${border}`,
        display: "flex", alignItems: "center",
        padding: PAD, userSelect: "none",
      }}
    >
      <motion.div
        drag="x"
        style={{
          x, position: "absolute", top: PAD, left: PAD,
          width: QUARTO, height: ALTURA - PAD * 2,
          borderRadius: RAIO.capsule,
          background: corThumb, boxShadow: sombraThumb, cursor: "grab", zIndex: 2,
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
          position: "relative", flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {/* zIndex 3: acima do thumb (zIndex 2) — senao o rotulo do segmento
            ATIVO fica escondido embaixo do thumb opaco (bug achado ao vivo).
            26/09: isso so' funciona porque os <button> NAO tem z-index. Ate
            aqui cada botao tinha `position: relative; zIndex: 1`, o que cria
            um stacking context proprio: o zIndex 3 do texto valia so' DENTRO
            do botao, e o botao inteiro (texto junto) pintava ABAIXO do thumb
            (zIndex 2) -- o rotulo do segmento ativo sumia nos 4 estados e nos
            2 temas (o fix de cor de 03/09, accentFg, estava certo mas
            invisivel). pointerEvents "none" no texto deixa o arrasto comecar
            em cima do rotulo ativo e o clique nos outros cair no botao. */}
        <motion.span style={{
          position: "relative", zIndex: 3, pointerEvents: "none", color: corTodos,
          fontSize: 12, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: FONT_SANS,
        }}>
          TODOS
        </motion.span>
      </motion.button>

      <motion.button
        onClick={() => escolher("ambos")}
        style={{
          position: "relative", flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <span style={{
          position: "relative", zIndex: 3, pointerEvents: "none", color: modo === "ambos" ? text : muted,
          fontSize: 12, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: FONT_SANS,
        }}>
          AMBOS
        </span>
      </motion.button>

      <motion.button
        onClick={() => escolher("selecionados")}
        style={{
          position: "relative", flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        }}
      >
        <span style={{
          position: "relative", zIndex: 3, pointerEvents: "none", color: modo === "selecionados" ? text : muted,
          fontSize: 12, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: FONT_SANS,
        }}>
          SELECIONADOS
        </span>
        {totalSelecionados > 0 && (
          <span style={{
            position: "relative", zIndex: 3, pointerEvents: "none",
            fontSize: 12, fontFamily: FONT_MONO,
            background: modo === "selecionados" ? `color-mix(in srgb, ${text} 22%, transparent)` : `${accent}22`,
            color: modo === "selecionados" ? text : accent,
            borderRadius: 8, padding: "1px 5px", fontWeight: 800,
          }}>
            {totalSelecionados}
          </span>
        )}
      </motion.button>

      <motion.button
        onClick={() => escolher("romaneio")}
        style={{
          position: "relative", flex: 1, height: "100%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        }}
      >
        <motion.span style={{
          position: "relative", zIndex: 3, pointerEvents: "none", color: corRomaneio,
          fontSize: 12, fontWeight: 700, letterSpacing: ".03em",
          fontFamily: FONT_SANS,
        }}>
          ROMANEIO
        </motion.span>
        {totalComRomaneio > 0 && (
          <span style={{
            position: "relative", zIndex: 3, pointerEvents: "none",
            fontSize: 12, fontFamily: FONT_MONO,
            background: modo === "romaneio" ? `color-mix(in srgb, ${text} 22%, transparent)` : `${accent}22`,
            color: modo === "romaneio" ? text : accent,
            borderRadius: 8, padding: "1px 5px", fontWeight: 800,
          }}>
            {totalComRomaneio}
          </span>
        )}
      </motion.button>
    </div>
  );
}
