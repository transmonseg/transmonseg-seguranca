"use client";

import type { VeiculoItem } from "../page";

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function formataAtraso(min: number): string {
  if (min < 2)    return "agora";
  if (min < 60)   return `${min}m`;
  const horas = Math.floor(min / 60);
  const resto = min % 60;
  if (horas < 24) return resto > 0 ? `${horas}h${resto}m` : `${horas}h`;
  const dias = Math.floor(horas / 24);
  return `${dias}d`;
}

/* ------------------------------------------------------------------ */
/* Icones SVG inline                                                    */
/* ------------------------------------------------------------------ */

function IconMapPin({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconIgnicao({ on }: { on: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke={on ? "var(--verde)" : "var(--text-dim)"}
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-label={on ? "Ignicao ligada" : "Ignicao desligada"}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function IconSemSinal() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  );
}

function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Cor e aparencia por nivel                                            */
/* ------------------------------------------------------------------ */

type NivelDB = "verde" | "amarelo" | "vermelho" | "cinza" | "concluido";

function nivelVisual(nivel: NivelDB) {
  switch (nivel) {
    case "vermelho":
      return {
        bg: "#130909",
        border: "color-mix(in srgb, var(--vermelho) 30%, var(--border))",
        faixa: "var(--vermelho)",
        placa: "var(--text)",
        opacidade: 1,
      };
    case "amarelo":
      return {
        bg: "#13100a",
        border: "color-mix(in srgb, var(--amarelo) 25%, var(--border))",
        faixa: "var(--amarelo)",
        placa: "var(--text)",
        opacidade: 1,
      };
    case "concluido":
      return {
        bg: "#161b16",
        border: "color-mix(in srgb, var(--verde) 22%, #2a2a2a)",
        faixa: "var(--verde)",
        placa: "var(--text-muted)",
        opacidade: 0.85,
      };
    case "cinza":
      return {
        bg: "#141414",
        border: "#242424",
        faixa: "#2a2a2a",
        placa: "var(--text-dim)",
        opacidade: 0.5,
      };
    default: // verde
      return {
        bg: "#181818",
        border: "#2a2a2a",
        faixa: "transparent",
        placa: "var(--text)",
        opacidade: 1,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Card grande e arejado — 2 por linha no desktop                      */
/* ------------------------------------------------------------------ */

export default function CardVeiculoOperacao({ item }: { item: VeiculoItem }) {
  const visual = nivelVisual(item.nivel);
  const ehCinza = item.nivel === "cinza";
  const ehConcluido = item.nivel === "concluido";
  const ehAlerta = item.nivel === "vermelho" || item.nivel === "amarelo";
  const mostraEntregas = item.entregas_total > 0;
  const pct = mostraEntregas
    ? Math.min(100, Math.round((item.entregas_feitas / item.entregas_total) * 100))
    : 0;
  const corAlerta = item.nivel === "vermelho" ? "var(--vermelho)" : "var(--amarelo)";

  return (
    <div
      className="relative rounded-2xl border overflow-hidden transition-opacity duration-150"
      style={{
        backgroundColor: visual.bg,
        borderColor: visual.border,
        opacity: visual.opacidade,
      }}
    >
      {/* Faixa lateral de nivel */}
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ width: "3px", backgroundColor: visual.faixa }}
      />

      <div style={{ padding: "2rem 2rem 2rem 2.25rem" }}>

        {/* LINHA 1: Placa grande + status de ignicao */}
        <div className="flex items-start justify-between gap-3 mb-5">
          <div className="min-w-0">
            {/* Placa — principal, bem legivel */}
            <p
              className="num-mono font-bold tracking-widest leading-none"
              style={{
                color: visual.placa,
                fontFamily: "var(--font-geist-mono, monospace)",
                fontSize: "1.25rem",
                letterSpacing: "0.1em",
              }}
            >
              {item.placa}
            </p>
            {item.cv && (
              <p
                className="text-xs mt-1 truncate"
                style={{ color: "var(--text-dim)" }}
              >
                {item.cv}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {item.panico && !ehCinza && (
              <span
                className="animate-pulse-alert text-xs font-bold px-2 py-1 rounded-lg"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--vermelho) 15%, transparent)",
                  color: "var(--vermelho)",
                  border: "1px solid color-mix(in srgb, var(--vermelho) 30%, transparent)",
                  fontFamily: "var(--font-geist-mono, monospace)",
                  fontSize: "10px",
                  letterSpacing: "0.06em",
                }}
              >
                PANICO
              </span>
            )}
            {ehCinza ? <IconSemSinal /> : <IconIgnicao on={item.ignicao} />}
          </div>
        </div>

        {/* LINHA 2: Localizacao real */}
        {item.local && (
          <div className="flex items-start gap-2 mb-5" style={{ color: "var(--text-dim)" }}>
            <span className="flex-shrink-0 mt-0.5">
              <IconMapPin size={12} />
            </span>
            <p
              className="text-sm leading-snug line-clamp-2"
              style={{ color: "var(--text-muted)" }}
            >
              {item.local}
            </p>
          </div>
        )}

        {/* LINHA 3: Status / motivo do alerta */}
        {ehAlerta && item.motivo ? (
          <div
            className="rounded-xl px-3 py-2.5 mb-5"
            style={{
              backgroundColor: `color-mix(in srgb, ${corAlerta} 8%, transparent)`,
              border: `1px solid color-mix(in srgb, ${corAlerta} 18%, transparent)`,
            }}
          >
            <p className="text-sm leading-relaxed" style={{ color: corAlerta }}>
              {item.motivo}
            </p>
          </div>
        ) : !ehAlerta ? (
          <div className="flex items-center gap-2 mb-5">
            {ehConcluido ? (
              <span style={{ color: "var(--verde)" }}>
                <IconCheck size={12} />
              </span>
            ) : (
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: ehCinza
                    ? "var(--text-dim)"
                    : item.ignicao
                    ? "var(--verde)"
                    : "var(--text-dim)",
                }}
              />
            )}
            <p
              className="text-sm"
              style={{
                color: ehCinza
                  ? "var(--text-dim)"
                  : ehConcluido
                  ? "var(--verde)"
                  : item.velocidade > 0
                  ? "var(--text)"
                  : item.ignicao
                  ? "var(--text-muted)"
                  : "var(--text-dim)",
              }}
            >
              {ehCinza
                ? `sem sinal ha ${formataAtraso(item.atraso_min)}`
                : ehConcluido
                ? "rota encerrada"
                : item.velocidade > 0
                ? `${item.velocidade} km/h`
                : item.ignicao
                ? "parado com ignicao"
                : "parado"}
            </p>
          </div>
        ) : null}

        {/* LINHA 4: Barra de entregas elegante */}
        {mostraEntregas && (
          <div
            className="pt-5 border-t"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                entregas
              </span>
              <span
                className="num-mono text-sm font-semibold"
                style={{
                  fontFamily: "var(--font-geist-mono, monospace)",
                  color: pct === 100 ? "var(--verde)" : "var(--text-muted)",
                }}
              >
                {item.entregas_feitas} / {item.entregas_total}
              </span>
            </div>
            {/* Barra fina e elegante */}
            <div
              style={{
                height: "2px",
                borderRadius: "2px",
                backgroundColor: "var(--border-subtle)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  borderRadius: "2px",
                  backgroundColor:
                    pct === 100
                      ? "var(--verde)"
                      : pct > 60
                      ? "var(--accent)"
                      : "var(--amarelo)",
                  transition: "width 0.4s ease",
                }}
              />
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
