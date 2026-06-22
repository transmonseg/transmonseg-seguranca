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

function IconMapPin({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconSpeed({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 12l4.35-4.35" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function IconIgnicao({ on }: { on: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke={on ? "var(--verde)" : "var(--text-dim)"}
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-label={on ? "Ignicao ligada" : "Ignicao desligada"}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function IconSemSinal() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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

function IconCheck({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
        bg: "#160c0c",
        border: "color-mix(in srgb, var(--vermelho) 22%, var(--border))",
        faixa: "var(--vermelho)",
        placa: "var(--text)",
      };
    case "amarelo":
      return {
        bg: "#15110a",
        border: "color-mix(in srgb, var(--amarelo) 18%, var(--border))",
        faixa: "var(--amarelo)",
        placa: "var(--text)",
      };
    case "concluido":
      return {
        bg: "var(--card)",
        border: "color-mix(in srgb, var(--verde) 15%, var(--border))",
        faixa: "var(--verde)",
        placa: "var(--text-muted)",
      };
    case "cinza":
      return {
        bg: "var(--card)",
        border: "var(--border)",
        faixa: "var(--border)",
        placa: "var(--text-dim)",
      };
    default: // verde
      return {
        bg: "var(--card)",
        border: "var(--border)",
        faixa: "transparent",
        placa: "var(--text)",
      };
  }
}

/* ------------------------------------------------------------------ */
/* Card de veiculo em operacao                                          */
/* ------------------------------------------------------------------ */

export default function CardVeiculoOperacao({ item }: { item: VeiculoItem }) {
  const visual = nivelVisual(item.nivel);
  const ehCinza = item.nivel === "cinza";
  const ehConcluido = item.nivel === "concluido";
  const mostraEntregas = item.entregas_total > 0;
  const pct = mostraEntregas
    ? Math.min(100, Math.round((item.entregas_feitas / item.entregas_total) * 100))
    : 0;
  const pendentes = item.entregas_total - item.entregas_feitas;

  const corMotivo =
    item.nivel === "vermelho" ? "var(--vermelho)" : "var(--amarelo)";

  return (
    <div
      className="relative rounded-xl border overflow-hidden transition-colors duration-150 cursor-default"
      style={{
        backgroundColor: visual.bg,
        borderColor: visual.border,
        opacity: ehCinza ? 0.55 : 1,
      }}
    >
      {/* Faixa lateral de nivel */}
      <div
        className="absolute top-0 bottom-0 left-0 w-0.5"
        style={{ backgroundColor: visual.faixa }}
      />

      <div className="pl-3 pr-3 pt-3 pb-3 flex flex-col gap-2">

        {/* Placa + icone de status */}
        <div className="flex items-start justify-between gap-1.5">
          <div className="min-w-0">
            <p
              className="num-mono text-sm font-bold tracking-wider leading-none truncate"
              style={{ color: visual.placa, fontFamily: "var(--font-geist-mono, monospace)", letterSpacing: "0.07em" }}
            >
              {item.placa}
            </p>
            {item.cv && (
              <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-dim)", fontSize: "10px" }}>
                {item.cv}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
            {item.panico && !ehCinza && (
              <span
                className="tag animate-pulse-alert"
                style={{
                  backgroundColor: "color-mix(in srgb, var(--vermelho) 15%, transparent)",
                  color: "var(--vermelho)",
                  border: "1px solid color-mix(in srgb, var(--vermelho) 30%, transparent)",
                  fontFamily: "var(--font-geist-mono, monospace)",
                  fontSize: "9px",
                  padding: "2px 5px",
                }}
              >
                PANICO
              </span>
            )}
            {ehCinza ? <IconSemSinal /> : <IconIgnicao on={item.ignicao} />}
          </div>
        </div>

        {/* Localizacao real */}
        {item.local && (
          <div className="flex items-start gap-1">
            <span className="flex-shrink-0 mt-0.5" style={{ color: "var(--accent)" }}>
              <IconMapPin size={10} />
            </span>
            <p
              className="text-xs leading-tight line-clamp-2"
              style={{ color: "var(--text-muted)", fontSize: "10px" }}
            >
              {item.local}
            </p>
          </div>
        )}

        {/* Motivo de alerta (amarelo/vermelho) */}
        {(item.nivel === "vermelho" || item.nivel === "amarelo") && item.motivo && (
          <p
            className="text-xs rounded px-1.5 py-1 leading-snug"
            style={{ backgroundColor: `color-mix(in srgb, ${corMotivo} 10%, transparent)`, color: corMotivo, fontSize: "10px" }}
          >
            {item.motivo}
          </p>
        )}

        {/* Status simples (verde/concluido/cinza sem motivo de alerta) */}
        {item.nivel !== "vermelho" && item.nivel !== "amarelo" && (
          <div className="flex items-center gap-1.5">
            {ehConcluido ? (
              <span style={{ color: "var(--verde)" }}>
                <IconCheck size={10} />
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
              className="text-xs"
              style={{
                color: ehCinza
                  ? "var(--text-dim)"
                  : ehConcluido
                  ? "var(--verde)"
                  : item.ignicao
                  ? "var(--verde)"
                  : "var(--text-muted)",
                fontSize: "10px",
              }}
            >
              {ehCinza
                ? `sem sinal ha ${formataAtraso(item.atraso_min)}`
                : ehConcluido
                ? "rota encerrada"
                : item.ignicao
                ? "em circulacao"
                : "parado"}
            </p>
          </div>
        )}

        {/* Barra de entregas */}
        {mostraEntregas && (
          <div className="pt-1.5 border-t" style={{ borderColor: "var(--border-subtle)" }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "9px", letterSpacing: "0.04em" }}>
                entregas
              </span>
              <span
                className="num-mono text-xs font-semibold"
                style={{ color: pct === 100 ? "var(--verde)" : "var(--text-muted)", fontFamily: "var(--font-geist-mono, monospace)", fontSize: "10px" }}
              >
                {item.entregas_feitas}/{item.entregas_total}
              </span>
            </div>
            <div className="w-full rounded-full overflow-hidden" style={{ height: "3px", backgroundColor: "var(--border)" }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${pct}%`,
                  backgroundColor: pct === 100 ? "var(--verde)" : pct > 60 ? "var(--accent)" : "var(--amarelo)",
                }}
              />
            </div>
            {pendentes > 0 && (
              <p className="text-xs mt-0.5" style={{ color: "var(--text-dim)", fontSize: "9px" }}>
                faltam {pendentes}
              </p>
            )}
          </div>
        )}

        {/* Velocidade (apenas verde e em movimento) */}
        {item.nivel === "verde" && item.velocidade > 0 && (
          <div
            className="flex items-center gap-1 pt-1 border-t"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <span style={{ color: "var(--text-dim)" }}><IconSpeed size={10} /></span>
            <span
              className="num-mono text-xs"
              style={{ color: "var(--text-muted)", fontFamily: "var(--font-geist-mono, monospace)", fontSize: "10px" }}
            >
              {item.velocidade} km/h
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
