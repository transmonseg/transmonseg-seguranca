"use client";

import { useEffect, useState } from "react";
import AcoesAlerta from "./AcoesAlerta";
import CronometroSLA from "./CronometroSLA";
import { enviarComandoVeiculo } from "@/lib/unitrac-comandos";

interface AlertaSimples {
  id: string;
  status: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  score: number | null;
}

interface Props {
  cv: string;
  placa: string;
  alertas: AlertaSimples[];
  onFechar: () => void;
  onAlertaResolvido?: (id: string) => void;
  empresa?: string;
}

interface Telemetria {
  posiclatitude?: string;
  posiclongitude?: string;
  posicvelocidade?: string;
  posicignicao?: string;
  tipevnome?: string;
  atraso?: string;
  datagps?: string;
  [key: string]: unknown;
}

interface PontoEntrega {
  lat: number;
  lng: number;
  raio: number;
  ordem: number;
  nome: string;
  feito: boolean;
}

function formatarDuracao(min: number): string {
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatarDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatarDataHora(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  // O datagps do Unitrac ja vem formatado (ex: "26/06/26 01:01:33"), que o
  // Date nao parseia. Nesse caso devolve o texto cru em vez de "Invalid Date".
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const ROTULO = "var(--text-dim)";

export default function PainelVeiculoAlerta({ cv, placa, alertas, onFechar, onAlertaResolvido, empresa }: Props) {
  const [telemetria, setTelemetria] = useState<Telemetria | null>(null);
  const [pontos, setPontos] = useState<PontoEntrega[]>([]);
  const [carregandoRota, setCarregandoRota] = useState(true);
  const [cmdSirene, setCmdSirene] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
  const [cmdBloqueio, setCmdBloqueio] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  // Telemetria ao vivo (15s)
  useEffect(() => {
    if (!cv) return;
    let ativo = true;
    const carregar = () =>
      fetch(`/api/veiculo?cv=${encodeURIComponent(cv)}`)
        .then((r) => r.json())
        .then((d) => {
          if (ativo && d?.posicao) setTelemetria(d.posicao as Telemetria);
        })
        .catch(() => {});
    carregar();
    const id = setInterval(carregar, 15000);
    return () => {
      ativo = false;
      clearInterval(id);
    };
  }, [cv]);

  // Pontos de entrega da rota do dia (1x ao abrir)
  useEffect(() => {
    if (!cv) return;
    let ativo = true;
    setCarregandoRota(true);
    fetch(`/api/alvos?cv=${encodeURIComponent(cv)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!ativo) return;
        setPontos(Array.isArray(d?.pontos) ? (d.pontos as PontoEntrega[]) : []);
      })
      .catch(() => {})
      .finally(() => ativo && setCarregandoRota(false));
    return () => {
      ativo = false;
    };
  }, [cv]);

  async function acionar(tipo: "sirene" | "bloqueio") {
    const setter = tipo === "sirene" ? setCmdSirene : setCmdBloqueio;
    setter("loading");
    const resultado = await enviarComandoVeiculo(cv, tipo);
    if (resultado.ok) {
      setter("ok");
      setTimeout(() => setter("idle"), 3000);
    } else {
      setter("fallback");
      if (resultado.portalUrl) setFallbackUrl(resultado.portalUrl);
    }
  }

  const velocidade = telemetria ? parseInt(telemetria.posicvelocidade ?? "0") || 0 : null;
  const ignicao = telemetria ? telemetria.posicignicao === "1" : null;
  const atraso = telemetria ? parseInt(telemetria.atraso ?? "0") || 0 : null;
  const evento = telemetria?.tipevnome ?? null;
  const lat = telemetria ? parseFloat(telemetria.posiclatitude ?? "") : NaN;
  const lng = telemetria ? parseFloat(telemetria.posiclongitude ?? "") : NaN;
  const posValida = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  const dataGps = formatarDataHora(telemetria?.datagps as string | undefined);

  const temCritico = alertas.some((a) => a.nivel === "critico");
  const corNivel = temCritico
    ? "var(--vermelho)"
    : alertas.length > 0
    ? "var(--amarelo)"
    : "var(--accent)";

  // Rota do dia
  const feitos = pontos.filter((p) => p.feito).length;
  const total = pontos.length;
  const pct = total > 0 ? Math.round((feitos / total) * 100) : 0;
  const pendentes = pontos
    .filter((p) => !p.feito)
    .map((p) => ({
      ...p,
      dist: posValida ? haversineM(lat, lng, p.lat, p.lng) : null,
    }))
    .sort((a, b) => a.ordem - b.ordem);

  const sensores = telemetria
    ? [
        ...Array.from({ length: 10 }, (_, i) => i + 1)
          .filter((i) => telemetria[`posicentrada${i}`] === "1")
          .map((i) => `E${i}`),
        ...Array.from({ length: 4 }, (_, i) => i + 1)
          .filter((i) => telemetria[`posicsaida${i}`] === "1")
          .map((i) => `S${i}`),
      ]
    : [];

  const blocoStyle: React.CSSProperties = {
    padding: "0.75rem 1rem",
    borderBottom: "1px solid var(--border-subtle)",
  };
  const rotuloStyle: React.CSSProperties = {
    color: ROTULO,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    marginBottom: 5,
  };

  return (
    <div
      style={{
        width: 320,
        maxHeight: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "rgba(9,9,13,0.97)",
        border: `1px solid color-mix(in srgb, ${corNivel} 40%, var(--border))`,
        borderRadius: "0.875rem",
        boxShadow: "0 10px 40px rgba(0,0,0,0.7)",
        backdropFilter: "blur(10px)",
        overflow: "hidden",
      }}
    >
      {/* Cabecalho */}
      <div
        style={{
          ...blocoStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: `color-mix(in srgb, ${corNivel} 9%, transparent)`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span
            style={{
              display: "inline-block",
              width: 9,
              height: 9,
              borderRadius: "50%",
              flexShrink: 0,
              backgroundColor: ignicao ? "var(--verde)" : corNivel,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <span
              style={{
                fontFamily: "var(--font-geist-mono, monospace)",
                color: "var(--text)",
                fontSize: "1rem",
                letterSpacing: "0.1em",
                fontWeight: 700,
              }}
            >
              {placa}
            </span>
            {evento && (
              <p
                style={{
                  fontSize: 10,
                  color: "var(--text-dim)",
                  marginTop: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 220,
                }}
              >
                {evento}
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onFechar}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-dim)",
            padding: "2px 6px",
            fontSize: 18,
            lineHeight: 1,
            flexShrink: 0,
          }}
          title="Fechar"
        >
          &times;
        </button>
      </div>

      {/* Corpo scrollavel */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {/* Telemetria */}
        <div style={{ ...blocoStyle, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <div>
            <p style={rotuloStyle}>veloc.</p>
            <p
              style={{
                fontFamily: "var(--font-geist-mono, monospace)",
                fontSize: "1.05rem",
                color: (velocidade ?? 0) > 0 ? "var(--accent)" : "var(--text-muted)",
                lineHeight: 1,
                fontWeight: 700,
              }}
            >
              {velocidade ?? "--"}
              <span style={{ fontSize: 9, fontWeight: 400, marginLeft: 2, color: ROTULO }}>km/h</span>
            </p>
          </div>
          <div>
            <p style={rotuloStyle}>ignicao</p>
            <p style={{ fontSize: "0.8rem", color: ignicao ? "var(--verde)" : "var(--text-dim)", fontWeight: 600 }}>
              {ignicao === null ? "--" : ignicao ? "ligada" : "deslig."}
            </p>
          </div>
          <div>
            <p style={rotuloStyle}>comm</p>
            <p
              style={{
                fontSize: "0.8rem",
                fontWeight: 600,
                color: atraso !== null && atraso > 60 ? "var(--amarelo)" : "var(--verde)",
              }}
            >
              {atraso === null ? "--" : atraso > 0 ? `${formatarDuracao(atraso)}` : "ao vivo"}
            </p>
          </div>
        </div>

        {/* Localizacao / empresa */}
        <div style={blocoStyle}>
          {empresa && (
            <div style={{ marginBottom: 6 }}>
              <p style={rotuloStyle}>empresa</p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{empresa}</p>
            </div>
          )}
          <p style={rotuloStyle}>localizacao</p>
          {posValida ? (
            <>
              <p style={{ fontFamily: "var(--font-geist-mono, monospace)", fontSize: 11, color: "var(--text-muted)" }}>
                {lat.toFixed(5)}, {lng.toFixed(5)}
              </p>
              <a
                href={`https://www.google.com/maps?q=${lat},${lng}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 11, color: "var(--accent)" }}
              >
                abrir no Google Maps
              </a>
            </>
          ) : (
            <p style={{ fontSize: 11, color: "var(--text-dim)" }}>sem posicao</p>
          )}
          {dataGps && (
            <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>GPS: {dataGps}</p>
          )}
        </div>

        {/* Rota do dia */}
        <div style={blocoStyle}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
            <p style={{ ...rotuloStyle, marginBottom: 0 }}>rota do dia</p>
            {total > 0 && (
              <span
                style={{
                  fontFamily: "var(--font-geist-mono, monospace)",
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--text-muted)",
                }}
              >
                {feitos}/{total}
              </span>
            )}
          </div>

          {carregandoRota ? (
            <div style={{ height: 6, borderRadius: 3, backgroundColor: "var(--card)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: "40%", backgroundColor: "var(--border)", opacity: 0.6 }} />
            </div>
          ) : total === 0 ? (
            <p style={{ fontSize: 11, color: "var(--text-dim)" }}>Sem rota de entregas hoje.</p>
          ) : (
            <>
              {/* Barra de progresso */}
              <div style={{ height: 6, borderRadius: 3, backgroundColor: "var(--card)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    backgroundColor: "var(--verde)",
                    transition: "width 0.4s cubic-bezier(0.16,1,0.3,1)",
                  }}
                />
              </div>

              {/* Proximos pontos */}
              {pendentes.length > 0 ? (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
                  <p style={{ ...rotuloStyle, marginBottom: 0 }}>proximos pontos</p>
                  {pendentes.slice(0, 6).map((p, i) => (
                    <div key={`${p.ordem}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          flexShrink: 0,
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: "var(--font-geist-mono, monospace)",
                          fontSize: 9,
                          fontWeight: 800,
                          color: i === 0 ? "#0a0a0a" : "var(--text-muted)",
                          backgroundColor: i === 0 ? "#f97316" : "var(--card)",
                          border: `1px solid ${i === 0 ? "#f97316" : "var(--border)"}`,
                        }}
                      >
                        {i + 1}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          fontSize: 11.5,
                          color: i === 0 ? "var(--text)" : "var(--text-muted)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontWeight: i === 0 ? 600 : 400,
                        }}
                        title={p.nome}
                      >
                        {p.nome || `Ponto ${p.ordem}`}
                      </span>
                      {p.dist !== null && (
                        <span
                          style={{
                            flexShrink: 0,
                            fontFamily: "var(--font-geist-mono, monospace)",
                            fontSize: 10,
                            color: i === 0 ? "#f97316" : ROTULO,
                          }}
                        >
                          {formatarDist(p.dist)}
                        </span>
                      )}
                    </div>
                  ))}
                  {pendentes.length > 6 && (
                    <p style={{ fontSize: 10, color: ROTULO }}>
                      + {pendentes.length - 6} ponto(s)
                    </p>
                  )}
                </div>
              ) : (
                <p style={{ fontSize: 11, color: "var(--verde)", marginTop: 8 }}>
                  Todas as entregas concluidas.
                </p>
              )}
            </>
          )}
        </div>

        {/* Sensores ativos */}
        {sensores.length > 0 && (
          <div style={blocoStyle}>
            <p style={rotuloStyle}>sensores ativos</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {sensores.map((s) => (
                <span
                  key={s}
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "2px 7px",
                    borderRadius: 4,
                    fontFamily: "var(--font-geist-mono, monospace)",
                    backgroundColor: s.startsWith("E") ? "rgba(34,197,94,0.12)" : "rgba(56,189,248,0.12)",
                    border: `1px solid ${s.startsWith("E") ? "rgba(34,197,94,0.25)" : "rgba(56,189,248,0.25)"}`,
                    color: s.startsWith("E") ? "var(--verde)" : "var(--accent)",
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Alertas */}
        <div style={blocoStyle}>
          <p style={rotuloStyle}>
            alertas {alertas.length > 0 && <span style={{ color: corNivel }}>({alertas.length})</span>}
          </p>
          {alertas.length === 0 ? (
            <p style={{ fontSize: 11, color: "var(--text-dim)" }}>Sem alertas ativos neste veiculo.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {alertas.map((a) => (
                <div key={a.id}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        padding: "2px 7px",
                        borderRadius: 5,
                        backgroundColor: a.nivel === "critico" ? "#ef444418" : "#f59e0b18",
                        border: `1px solid ${a.nivel === "critico" ? "#ef444444" : "#f59e0b44"}`,
                        color: a.nivel === "critico" ? "#ef4444" : "#f59e0b",
                      }}
                    >
                      {a.tipo}
                    </span>
                    {a.score != null && (
                      <span
                        style={{
                          fontFamily: "var(--font-geist-mono, monospace)",
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: 4,
                          backgroundColor: a.score >= 80 ? "#ef444418" : "#f59e0b18",
                          color: a.score >= 80 ? "#ef4444" : "#f59e0b",
                        }}
                      >
                        {a.score}
                      </span>
                    )}
                  </div>
                  {a.motivo && (
                    <p style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 6, lineHeight: 1.4 }}>
                      {a.motivo}
                    </p>
                  )}
                  <div style={{ marginBottom: 6 }}>
                    <CronometroSLA desde={a.desde} />
                  </div>
                  <AcoesAlerta id={a.id} status={a.status} desde={a.desde} onSucesso={onAlertaResolvido} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Saidas digitais: sirene e bloqueio */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "0.75rem 1rem",
          borderTop: "1px solid var(--border-subtle)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => acionar("sirene")}
          disabled={cmdSirene === "loading"}
          style={{
            flex: 1,
            padding: "0.5rem",
            borderRadius: 7,
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid var(--border)",
            backgroundColor:
              cmdSirene === "ok"
                ? "rgba(34,197,94,0.14)"
                : cmdSirene === "fallback"
                ? "rgba(245,158,11,0.14)"
                : "var(--card)",
            color:
              cmdSirene === "ok"
                ? "var(--verde)"
                : cmdSirene === "fallback"
                ? "var(--amarelo)"
                : "var(--text)",
            cursor: cmdSirene === "loading" ? "wait" : "pointer",
            transition: "transform 0.1s",
          }}
        >
          {cmdSirene === "loading"
            ? "Acionando..."
            : cmdSirene === "ok"
            ? "Sirene acionada"
            : cmdSirene === "fallback"
            ? "Ver no portal"
            : "Acionar sirene"}
        </button>

        <button
          onClick={() => acionar("bloqueio")}
          disabled={cmdBloqueio === "loading"}
          style={{
            flex: 1,
            padding: "0.5rem",
            borderRadius: 7,
            fontSize: 12,
            fontWeight: 600,
            border: `1px solid ${cmdBloqueio === "idle" ? "var(--vermelho, #ef4444)" : "var(--border)"}`,
            backgroundColor:
              cmdBloqueio === "ok"
                ? "rgba(34,197,94,0.14)"
                : cmdBloqueio === "fallback"
                ? "rgba(245,158,11,0.14)"
                : "rgba(239,68,68,0.13)",
            color:
              cmdBloqueio === "ok"
                ? "var(--verde)"
                : cmdBloqueio === "fallback"
                ? "var(--amarelo)"
                : "var(--vermelho, #ef4444)",
            cursor: cmdBloqueio === "loading" ? "wait" : "pointer",
            transition: "transform 0.1s",
          }}
        >
          {cmdBloqueio === "loading"
            ? "Bloqueando..."
            : cmdBloqueio === "ok"
            ? "Motor bloqueado"
            : cmdBloqueio === "fallback"
            ? "Ver no portal"
            : "Bloquear motor"}
        </button>
      </div>

      {/* Fallback do portal */}
      {(cmdSirene === "fallback" || cmdBloqueio === "fallback") && fallbackUrl && (
        <div style={{ padding: "0.5rem 1rem", fontSize: 11, color: "var(--text-dim)", borderTop: "1px solid var(--border-subtle)", flexShrink: 0 }}>
          Acao nao confirmada.{" "}
          <a href={fallbackUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            Abrir portal Unitrac
          </a>{" "}
          para acionar manualmente.
        </div>
      )}
    </div>
  );
}
