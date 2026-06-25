"use client";

import { useEffect, useState } from "react";
import AcoesAlerta from "./AcoesAlerta";
import CronometroSLA from "./CronometroSLA";

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
}

interface Telemetria {
  posicvelocidade?: string;
  posicignicao?: string;
  tipevnome?: string;
  atraso?: string;
}

function formatarDuracao(min: number): string {
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

export default function PainelVeiculoAlerta({ cv, placa, alertas, onFechar }: Props) {
  const [telemetria, setTelemetria] = useState<Telemetria | null>(null);

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

  const velocidade = telemetria ? parseInt(telemetria.posicvelocidade ?? "0") || 0 : null;
  const ignicao = telemetria ? telemetria.posicignicao === "1" : null;
  const atraso = telemetria ? parseInt(telemetria.atraso ?? "0") || 0 : null;
  const temCritico = alertas.some((a) => a.nivel === "critico");
  const corNivel = temCritico ? "var(--vermelho)" : "var(--amarelo)";

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 1001,
        width: 300,
        maxHeight: "calc(100% - 24px)",
        overflowY: "auto",
        backgroundColor: "rgba(8,8,12,0.97)",
        border: `1px solid color-mix(in srgb, ${corNivel} 40%, var(--border))`,
        borderRadius: "0.875rem",
        boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
        backdropFilter: "blur(10px)",
      }}
    >
      {/* Cabecalho */}
      <div
        style={{
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: `color-mix(in srgb, ${corNivel} 8%, transparent)`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: ignicao ? "var(--verde)" : corNivel,
            }}
          />
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
          }}
          title="Fechar"
        >
          &times;
        </button>
      </div>

      {/* Telemetria */}
      <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <p
              style={{
                color: "var(--text-dim)",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 3,
              }}
            >
              velocidade
            </p>
            <p
              style={{
                fontFamily: "var(--font-geist-mono, monospace)",
                fontSize: "1.1rem",
                color: (velocidade ?? 0) > 0 ? "var(--accent)" : "var(--text-muted)",
                lineHeight: 1,
                fontWeight: 700,
              }}
            >
              {velocidade ?? "--"}
              <span style={{ fontSize: 10, fontWeight: 400, marginLeft: 3, color: "var(--text-dim)" }}>
                km/h
              </span>
            </p>
          </div>
          <div>
            <p
              style={{
                color: "var(--text-dim)",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: 3,
              }}
            >
              ignicao
            </p>
            <p
              style={{
                fontSize: "0.875rem",
                color: ignicao ? "var(--verde)" : "var(--text-dim)",
                fontWeight: 600,
              }}
            >
              {ignicao === null ? "--" : ignicao ? "ligada" : "desligada"}
            </p>
          </div>
        </div>
        {atraso !== null && atraso > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: "50%",
                backgroundColor: "var(--amarelo)",
              }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
              sem comunicacao ha {formatarDuracao(atraso)}
            </p>
          </div>
        )}
      </div>

      {/* Alertas e acoes */}
      <div style={{ padding: "0.75rem 1rem", display: "flex", flexDirection: "column", gap: 16 }}>
        {alertas.map((a) => (
          <div key={a.id}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
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
            <AcoesAlerta id={a.id} status={a.status} desde={a.desde} />
          </div>
        ))}
      </div>
    </div>
  );
}
