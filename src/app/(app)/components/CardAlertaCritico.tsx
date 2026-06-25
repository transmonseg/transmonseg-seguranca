"use client";

import AcoesAlerta from "./AcoesAlerta";

function IconMapPin({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
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

function IconAlertCircle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconExternal({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function IconPause({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function IconDesvio({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V12" />
      <path d="M12 12C12 8 12 6 6 4" />
      <path d="M12 12c0-3 1-5 6-7" />
      <polyline points="16 3 18 5 16 7" />
    </svg>
  );
}

function IconLoja({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function IconTiroteio({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="1" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="1" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="23" y2="12" />
    </svg>
  );
}

function IconJammer({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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

export function IconTipoAlerta({ tipo, size = 16 }: { tipo: string; size?: number }) {
  const t = tipo?.toLowerCase() ?? "";
  if (t.includes("tiroteio")) return <IconTiroteio size={size} />;
  if (t.includes("jammer") || t.includes("sinal") || t.includes("bloqueio"))
    return <IconJammer size={size} />;
  if (t.includes("favela") || t.includes("area") || t.includes("risco"))
    return <IconMapPin size={size} />;
  if (t.includes("cliente") || t.includes("loja")) return <IconLoja size={size} />;
  if (t.includes("parada") || t.includes("parado") || t.includes("longa"))
    return <IconPause size={size} />;
  if (t.includes("desvio") || t.includes("rota") || t.includes("fora"))
    return <IconDesvio size={size} />;
  return <IconAlertCircle size={size} />;
}

function formatarTempoRelativo(iso: string): string {
  const data = new Date(iso);
  const agora = new Date();
  const diffMin = Math.floor((agora.getTime() - data.getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export interface CardAlertaProps {
  id: string;
  status: string;
  nivel: "critico" | "atencao";
  tipo: string;
  placa: string;
  motivo: string | null;
  local: string | null;
  desde: string;
  lat?: number | null;
  lng?: number | null;
  velocidade?: number | null;
  ignicao?: boolean | null;
  atraso_min?: number | null;
  score?: number | null;
  onFocarMapa?: (lat: number, lng: number) => void;
}

export default function CardAlertaCritico({
  id, status, nivel, tipo, placa, motivo, local, desde,
  lat, lng, velocidade, ignicao, atraso_min, score, onFocarMapa,
}: CardAlertaProps) {
  const corNivel = nivel === "critico" ? "var(--vermelho)" : "var(--amarelo)";
  const bgNivel = nivel === "critico" ? "#160c0c" : "#16120a";
  const temCoordenadas = lat != null && lng != null;
  const urlMapa = temCoordenadas ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  return (
    <div
      className="relative rounded-xl border overflow-hidden"
      style={{
        backgroundColor: bgNivel,
        borderColor: `color-mix(in srgb, ${corNivel} 30%, var(--border))`,
      }}
    >
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ width: "3px", backgroundColor: corNivel, opacity: 0.8 }}
      />

      <div style={{ padding: "1rem 1rem 1rem 1.25rem" }}>
        {/* Cabecalho */}
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest px-2 py-1 rounded-md"
              style={{
                backgroundColor: `color-mix(in srgb, ${corNivel} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${corNivel} 25%, transparent)`,
                color: corNivel,
                letterSpacing: "0.09em",
                fontSize: "10px",
              }}
            >
              <span style={{ color: corNivel, opacity: 0.9 }}>
                <IconTipoAlerta tipo={tipo} size={10} />
              </span>
              {tipo}
            </span>
            {score != null && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 5,
                  backgroundColor:
                    score >= 80 ? "#ef444418" : score >= 50 ? "#f9731618" : "#f59e0b18",
                  border: `1px solid ${score >= 80 ? "#ef444444" : score >= 50 ? "#f9731644" : "#f59e0b44"}`,
                  color:
                    score >= 80 ? "#ef4444" : score >= 50 ? "#f97316" : "#f59e0b",
                  fontFamily: "var(--font-geist-mono, monospace)",
                }}
              >
                {score}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0" style={{ color: "var(--text-dim)" }}>
            <IconClock size={11} />
            <span className="num-mono text-xs" style={{ fontFamily: "var(--font-geist-mono, monospace)" }}>
              {formatarTempoRelativo(desde)}
            </span>
          </div>
        </div>

        {/* Placa + badge nivel */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <p
            className="num-mono font-bold leading-none"
            style={{
              color: "var(--text)",
              fontFamily: "var(--font-geist-mono, monospace)",
              fontSize: "1.2rem",
              letterSpacing: "0.12em",
            }}
          >
            {placa}
          </p>
          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
            style={{
              backgroundColor: `color-mix(in srgb, ${corNivel} 10%, transparent)`,
              color: corNivel,
              border: `1px solid color-mix(in srgb, ${corNivel} 20%, transparent)`,
              fontSize: "9px",
              letterSpacing: "0.06em",
            }}
          >
            {nivel === "critico" ? "CRÍTICO" : "ATENÇÃO"}
          </span>
        </div>

        {/* Motivo */}
        {motivo && (
          <div
            className="rounded-lg px-2.5 py-2 mb-2.5"
            style={{
              backgroundColor: `color-mix(in srgb, ${corNivel} 7%, transparent)`,
              border: `1px solid color-mix(in srgb, ${corNivel} 16%, transparent)`,
            }}
          >
            <p className="text-xs leading-relaxed" style={{ color: corNivel, opacity: 0.9 }}>
              {motivo}
            </p>
          </div>
        )}

        <div style={{ height: "1px", backgroundColor: "var(--border-subtle)", marginBottom: "0.625rem" }} />

        {/* Localizacao */}
        <div className="mb-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-1.5 min-w-0">
              <span className="flex-shrink-0 mt-0.5" style={{ color: "var(--text-dim)" }}>
                <IconMapPin size={11} />
              </span>
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                {local ?? "Sem endereço disponível"}
              </p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {temCoordenadas && onFocarMapa && (
                <button
                  type="button"
                  onClick={() => onFocarMapa(lat!, lng!)}
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                  style={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    color: "var(--text-muted)",
                    fontSize: "10px",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                  title="Centralizar no mapa"
                >
                  <IconMapPin size={10} />
                  Focar
                </button>
              )}
              {urlMapa && (
                <a
                  href={urlMapa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                  style={{
                    backgroundColor: "var(--accent-dim)",
                    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                    color: "var(--accent)",
                    textDecoration: "none",
                    fontSize: "10px",
                    whiteSpace: "nowrap",
                  }}
                >
                  <IconMapPin size={10} />
                  Ver
                  <IconExternal size={9} />
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Telemetria */}
        {(velocidade != null || ignicao != null || (atraso_min != null && atraso_min > 0)) && (
          <>
            <div style={{ height: "1px", backgroundColor: "var(--border-subtle)", marginBottom: "0.625rem" }} />
            <div className="grid grid-cols-2" style={{ gap: "0.375rem" }}>
              {velocidade != null && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>
                    velocidade
                  </span>
                  <p
                    className="num-mono text-xs font-semibold mt-0.5"
                    style={{
                      fontFamily: "var(--font-geist-mono, monospace)",
                      color: velocidade > 0 ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {velocidade} km/h
                  </p>
                </div>
              )}
              {ignicao != null && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>
                    ignicao
                  </span>
                  <p
                    className="text-xs font-semibold mt-0.5"
                    style={{ color: ignicao ? "var(--verde)" : "var(--text-dim)" }}
                  >
                    {ignicao ? "ligada" : "desligada"}
                  </p>
                </div>
              )}
              {atraso_min != null && atraso_min > 0 && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>
                    sem comunicacao
                  </span>
                  <p
                    className="num-mono text-xs font-semibold mt-0.5"
                    style={{ fontFamily: "var(--font-geist-mono, monospace)", color: "var(--text-muted)" }}
                  >
                    {atraso_min < 60
                      ? `${atraso_min}min`
                      : `${Math.floor(atraso_min / 60)}h${atraso_min % 60 > 0 ? `${atraso_min % 60}min` : ""}`}
                  </p>
                </div>
              )}
            </div>
          </>
        )}

        {/* Acoes do operador */}
        <AcoesAlerta id={id} status={status} desde={desde} />
      </div>
    </div>
  );
}
