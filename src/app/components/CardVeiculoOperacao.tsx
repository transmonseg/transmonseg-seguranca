"use client";

import type { VeiculoItem } from "../page";

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function formataAtraso(min: number): string {
  if (min < 2)    return "agora";
  if (min < 60)   return `${min}min`;
  const horas = Math.floor(min / 60);
  const resto = min % 60;
  if (horas < 24) return resto > 0 ? `${horas}h${resto}min` : `${horas}h`;
  const dias = Math.floor(horas / 24);
  return `${dias}d`;
}

function formataParadoDesde(iso: string): string {
  const data = new Date(iso);
  const agora = new Date();
  const diffMin = Math.floor((agora.getTime() - data.getTime()) / 60000);
  return formataAtraso(diffMin);
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

function IconExternal({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function IconIgnicao({ on }: { on: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke={on ? "var(--verde)" : "var(--text-dim)"}
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-label={on ? "Ignicao ligada" : "Ignicao desligada"}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function IconSemSinal({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
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

function IconSpeedometer({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 0 1 7.38 16.75" />
      <path d="M12 2a10 10 0 0 0-7.38 16.75" />
      <line x1="12" y1="12" x2="15.5" y2="8.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function IconClock({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconPackage({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconBau({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2Z" />
      <path d="M22 8H2" />
      <path d="M12 8v12" />
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
        badgeBg: "color-mix(in srgb, var(--vermelho) 12%, transparent)",
        badgeBorder: "color-mix(in srgb, var(--vermelho) 25%, transparent)",
        badgeColor: "var(--vermelho)",
        badgeLabel: "Critico",
      };
    case "amarelo":
      return {
        bg: "#13100a",
        border: "color-mix(in srgb, var(--amarelo) 25%, var(--border))",
        faixa: "var(--amarelo)",
        placa: "var(--text)",
        opacidade: 1,
        badgeBg: "color-mix(in srgb, var(--amarelo) 12%, transparent)",
        badgeBorder: "color-mix(in srgb, var(--amarelo) 25%, transparent)",
        badgeColor: "var(--amarelo)",
        badgeLabel: "Atencao",
      };
    case "concluido":
      return {
        bg: "#161b16",
        border: "color-mix(in srgb, var(--verde) 22%, #2a2a2a)",
        faixa: "var(--verde)",
        placa: "var(--text-muted)",
        opacidade: 0.85,
        badgeBg: "color-mix(in srgb, var(--verde) 10%, transparent)",
        badgeBorder: "color-mix(in srgb, var(--verde) 20%, transparent)",
        badgeColor: "var(--verde)",
        badgeLabel: "Concluido",
      };
    case "cinza":
      return {
        bg: "#141414",
        border: "#242424",
        faixa: "#2a2a2a",
        placa: "var(--text-dim)",
        opacidade: 0.5,
        badgeBg: "rgba(87,83,78,0.12)",
        badgeBorder: "rgba(87,83,78,0.2)",
        badgeColor: "var(--text-dim)",
        badgeLabel: "Sem sinal",
      };
    default: // verde
      return {
        bg: "#181818",
        border: "#2a2a2a",
        faixa: "transparent",
        placa: "var(--text)",
        opacidade: 1,
        badgeBg: "color-mix(in srgb, var(--verde) 10%, transparent)",
        badgeBorder: "color-mix(in srgb, var(--verde) 20%, transparent)",
        badgeColor: "var(--verde)",
        badgeLabel: "Em rota",
      };
  }
}

/* ------------------------------------------------------------------ */
/* Divisor interno sutil                                                */
/* ------------------------------------------------------------------ */

function Divisor() {
  return (
    <div style={{ height: "1px", backgroundColor: "var(--border-subtle)", margin: "0.875rem 0" }} />
  );
}

/* ------------------------------------------------------------------ */
/* Label de secao interna                                               */
/* ------------------------------------------------------------------ */

function BlocoLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="uppercase font-semibold tracking-widest mb-2"
      style={{ color: "var(--text-dim)", letterSpacing: "0.1em", fontSize: "9px" }}
    >
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Card principal — rico, organizado, 2 por linha no desktop           */
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
  const faltam = mostraEntregas ? item.entregas_total - item.entregas_feitas : 0;

  const temCoordenadas = item.lat != null && item.lng != null;
  const urlMapa = temCoordenadas
    ? `https://www.google.com/maps?q=${item.lat},${item.lng}`
    : null;

  const corAlerta = item.nivel === "vermelho" ? "var(--vermelho)" : "var(--amarelo)";

  // Calcular "parado ha" a partir de parado_desde
  const paradoHa =
    item.parado_desde && item.velocidade === 0 && !ehCinza
      ? formataParadoDesde(item.parado_desde)
      : null;

  // Status textual para badge/label de movimento
  function statusMovimento(): string {
    if (ehCinza) return `sem sinal ha ${formataAtraso(item.atraso_min)}`;
    if (ehConcluido) return "rota encerrada";
    if (item.velocidade > 0) return `${item.velocidade} km/h`;
    if (item.ignicao) return "parado, ignicao ligada";
    return "parado";
  }

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

      <div style={{ padding: "1.5rem 1.5rem 1.5rem 1.75rem" }}>

        {/* =========================================================
            TOPO: Placa grande + badge de nivel
            ========================================================= */}
        <div className="flex items-start justify-between gap-3 mb-1">
          <p
            className="num-mono font-bold leading-none"
            style={{
              color: visual.placa,
              fontFamily: "var(--font-geist-mono, monospace)",
              fontSize: "1.375rem",
              letterSpacing: "0.1em",
            }}
          >
            {item.placa}
          </p>

          <div className="flex items-center gap-2 flex-shrink-0">
            {item.panico && !ehCinza && (
              <span
                className="animate-pulse-alert text-xs font-bold px-2 py-0.5 rounded-md"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--vermelho) 15%, transparent)",
                  color: "var(--vermelho)",
                  border: "1px solid color-mix(in srgb, var(--vermelho) 30%, transparent)",
                  fontFamily: "var(--font-geist-mono, monospace)",
                  fontSize: "9px",
                  letterSpacing: "0.06em",
                }}
              >
                PANICO
              </span>
            )}
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: visual.badgeBg,
                border: `1px solid ${visual.badgeBorder}`,
                color: visual.badgeColor,
                fontSize: "10px",
                letterSpacing: "0.04em",
              }}
            >
              {visual.badgeLabel}
            </span>
          </div>
        </div>

        {/* Sublinhas: cv e grupo */}
        <div className="flex items-center gap-3 mb-3" style={{ minHeight: "1rem" }}>
          {item.cv && (
            <span className="text-xs truncate" style={{ color: "var(--text-dim)" }}>
              {item.cv}
            </span>
          )}
          {item.grupo && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: "rgba(159,179,206,0.08)",
                color: "var(--accent)",
                fontSize: "10px",
                border: "1px solid rgba(159,179,206,0.15)",
              }}
            >
              {item.grupo}
            </span>
          )}
        </div>

        {/* =========================================================
            STATUS DE MOVIMENTO — linha discreta
            ========================================================= */}
        <div className="flex items-center gap-2 mb-4">
          {ehCinza ? (
            <span style={{ color: "var(--text-dim)" }}><IconSemSinal size={12} /></span>
          ) : ehConcluido ? (
            <span style={{ color: "var(--verde)" }}><IconCheck size={12} /></span>
          ) : (
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{
                backgroundColor: item.velocidade > 0
                  ? "var(--verde)"
                  : item.ignicao
                  ? "var(--amarelo)"
                  : "var(--text-dim)",
              }}
            />
          )}
          <span
            className="text-xs"
            style={{
              color: ehCinza
                ? "var(--text-dim)"
                : ehConcluido
                ? "var(--verde)"
                : item.velocidade > 0
                ? "var(--accent)"
                : "var(--text-dim)",
            }}
          >
            {statusMovimento()}
          </span>
        </div>

        {/* =========================================================
            ALERTA / MOTIVO (se houver)
            ========================================================= */}
        {ehAlerta && item.motivo && (
          <>
            <div
              className="rounded-xl px-3 py-2.5 mb-4"
              style={{
                backgroundColor: `color-mix(in srgb, ${corAlerta} 8%, transparent)`,
                border: `1px solid color-mix(in srgb, ${corAlerta} 18%, transparent)`,
              }}
            >
              <p className="text-sm leading-relaxed" style={{ color: corAlerta }}>
                {item.motivo}
              </p>
            </div>
          </>
        )}

        <Divisor />

        {/* =========================================================
            BLOCO LOCALIZACAO
            ========================================================= */}
        <div className="mb-0">
          <BlocoLabel>Localizacao</BlocoLabel>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              <span className="flex-shrink-0 mt-0.5" style={{ color: "var(--text-dim)" }}>
                <IconMapPin size={12} />
              </span>
              <p
                className="text-xs leading-relaxed"
                style={{ color: "var(--text-muted)" }}
              >
                {item.local ?? "Sem endereco disponivel"}
              </p>
            </div>
            {urlMapa && (
              <a
                href={urlMapa}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 flex items-center gap-1.5 font-medium rounded-lg transition-opacity hover:opacity-80"
                style={{
                  backgroundColor: "var(--accent-dim)",
                  border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                  color: "var(--accent)",
                  textDecoration: "none",
                  fontSize: "11px",
                  padding: "0.375rem 0.625rem",
                  whiteSpace: "nowrap",
                }}
              >
                <IconMapPin size={11} />
                Ver no mapa
                <IconExternal size={10} />
              </a>
            )}
          </div>
        </div>

        <Divisor />

        {/* =========================================================
            BLOCO TELEMETRIA — grade 2 colunas
            ========================================================= */}
        <div>
          <BlocoLabel>Telemetria</BlocoLabel>
          <div className="grid grid-cols-2" style={{ gap: "0.625rem 1rem" }}>

            {/* Velocidade */}
            <div>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span style={{ color: "var(--text-dim)" }}><IconSpeedometer size={11} /></span>
                <span className="text-xs" style={{ color: "var(--text-dim)" }}>velocidade</span>
              </div>
              <p
                className="num-mono font-semibold"
                style={{
                  fontFamily: "var(--font-geist-mono, monospace)",
                  fontSize: "0.8125rem",
                  color: item.velocidade > 0 ? "var(--accent)" : "var(--text-muted)",
                }}
              >
                {item.velocidade} km/h
              </p>
            </div>

            {/* Ignicao */}
            <div>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span><IconIgnicao on={item.ignicao} /></span>
                <span className="text-xs" style={{ color: "var(--text-dim)" }}>ignicao</span>
              </div>
              <p
                className="text-sm font-semibold"
                style={{
                  fontSize: "0.8125rem",
                  color: item.ignicao ? "var(--verde)" : "var(--text-dim)",
                }}
              >
                {item.ignicao ? "ligada" : "desligada"}
              </p>
            </div>

            {/* Sem comunicacao */}
            {item.atraso_min > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span style={{ color: "var(--text-dim)" }}><IconSemSinal size={11} /></span>
                  <span className="text-xs" style={{ color: "var(--text-dim)" }}>sem comunicacao</span>
                </div>
                <p
                  className="num-mono font-semibold"
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontSize: "0.8125rem",
                    color: item.atraso_min > 30 ? "var(--amarelo)" : "var(--text-muted)",
                  }}
                >
                  {formataAtraso(item.atraso_min)}
                </p>
              </div>
            )}

            {/* Parado ha */}
            {paradoHa && (
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span style={{ color: "var(--text-dim)" }}><IconClock size={11} /></span>
                  <span className="text-xs" style={{ color: "var(--text-dim)" }}>parado ha</span>
                </div>
                <p
                  className="num-mono font-semibold"
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontSize: "0.8125rem",
                    color: "var(--text-muted)",
                  }}
                >
                  {paradoHa}
                </p>
              </div>
            )}

            {/* Bau aberto */}
            {item.bau_aberto && (
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span style={{ color: "var(--amarelo)" }}><IconBau size={11} /></span>
                  <span className="text-xs" style={{ color: "var(--text-dim)" }}>bau</span>
                </div>
                <p
                  className="text-sm font-semibold"
                  style={{ fontSize: "0.8125rem", color: "var(--amarelo)" }}
                >
                  aberto
                </p>
              </div>
            )}

          </div>
        </div>

        {/* =========================================================
            BLOCO ENTREGAS
            ========================================================= */}
        {mostraEntregas && (
          <>
            <Divisor />
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span style={{ color: "var(--text-dim)" }}><IconPackage size={11} /></span>
                  <BlocoLabel>Entregas do dia</BlocoLabel>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="num-mono font-bold"
                    style={{
                      fontFamily: "var(--font-geist-mono, monospace)",
                      fontSize: "0.875rem",
                      color: pct === 100 ? "var(--verde)" : "var(--text-muted)",
                    }}
                  >
                    {item.entregas_feitas}
                  </span>
                  <span style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>de</span>
                  <span
                    className="num-mono font-bold"
                    style={{
                      fontFamily: "var(--font-geist-mono, monospace)",
                      fontSize: "0.875rem",
                      color: "var(--text-muted)",
                    }}
                  >
                    {item.entregas_total}
                  </span>
                  {faltam > 0 && (
                    <span
                      className="text-xs"
                      style={{ color: "var(--text-dim)", fontSize: "11px" }}
                    >
                      ({faltam} {faltam === 1 ? "falta" : "faltam"})
                    </span>
                  )}
                </div>
              </div>

              {/* Barra de progresso */}
              <div
                style={{
                  height: "3px",
                  borderRadius: "3px",
                  backgroundColor: "var(--border-subtle)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    borderRadius: "3px",
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

              <p
                className="num-mono text-xs mt-1.5 text-right"
                style={{
                  fontFamily: "var(--font-geist-mono, monospace)",
                  color: pct === 100 ? "var(--verde)" : "var(--text-dim)",
                  fontSize: "10px",
                }}
              >
                {pct}%
              </p>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
