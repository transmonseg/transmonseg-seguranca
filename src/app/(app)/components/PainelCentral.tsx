"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import AlertaSonoro from "./AlertaSonoro";
import FiltrosBar, { type Contagens } from "./FiltrosBar";
import CardAlertaCritico from "./CardAlertaCritico";
import PainelVeiculoAlerta from "./PainelVeiculoAlerta";

const MapaMonitor = dynamic(() => import("./MapaMonitor"), { ssr: false });

interface AlertaEnriquecido {
  id: string;
  veiculo_id: string;
  cv: string;
  placa: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  status: string;
  score: number | null;
  lat: number | null;
  lng: number | null;
  velocidade: number | null;
  ignicao: boolean | null;
  atraso_min: number | null;
  local: string | null;
}

interface Props {
  cliente: string;
  clientes: { id: string; nome: string; cod: string }[];
  clienteAtivoId: string;
  veiculos: { placa: string; cv: string }[];
  alertasIniciais: AlertaEnriquecido[];
}

function ordemSeveridade(tipo: string): number {
  const t = tipo?.toLowerCase() ?? "";
  if (t === "panico") return 0;
  if (t === "bau") return 1;
  if (t === "favela") return 2;
  if (t === "tiroteio") return 3;
  if (t === "ignicao_noturna") return 4;
  if (t === "saida_nao_autorizada") return 5;
  if (t === "parada_cliente") return 6;
  if (t === "parada_anomala") return 7;
  if (t === "parada_longa") return 8;
  if (t === "desvio" || t === "excesso") return 9;
  if (t === "jammer" || t.includes("sinal") || t.includes("bloqueio")) return 11;
  return 10;
}

const SIDEBAR_W = 380;

export default function PainelCentral({
  cliente,
  clientes,
  clienteAtivoId,
  veiculos,
  alertasIniciais,
}: Props) {
  const searchParams = useSearchParams();

  const [alertas, setAlertas] = useState<AlertaEnriquecido[]>(alertasIniciais);
  const [flyParaAlerta, setFlyParaAlerta] = useState<{
    lat: number;
    lng: number;
    gatilho: number;
  } | null>(null);
  const vistosRef = useRef<Set<string>>(new Set(alertasIniciais.map((a) => a.id)));

  const [veiculoPanel, setVeiculoPanel] = useState<{ cv: string; placa: string } | null>(null);

  // Notificacao de critico novo
  const [toast, setToast] = useState<{ placa: string; tipo: string; id: string } | null>(null);
  const [notifLigada, setNotifLigada] = useState(false);

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      setNotifLigada(true);
    }
  }, []);

  const ativarNotificacoes = useCallback(() => {
    if (typeof Notification === "undefined") return;
    Notification.requestPermission().then((p) => setNotifLigada(p === "granted"));
  }, []);

  // Polling de alertas a cada 15s
  const atualizarAlertas = useCallback(() => {
    fetch(`/api/alertas?cliente=${encodeURIComponent(cliente)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d?.alertas)) return;
        const novos = d.alertas as AlertaEnriquecido[];
        setAlertas(novos);
        for (const a of novos) {
          if (a.nivel === "critico" && !vistosRef.current.has(a.id)) {
            if (a.lat != null && a.lng != null) {
              setFlyParaAlerta({ lat: a.lat, lng: a.lng, gatilho: Date.now() });
            }
            // Toast visual
            setToast({ placa: a.placa, tipo: a.tipo, id: a.id });
            // Notificacao do navegador
            if (
              typeof Notification !== "undefined" &&
              Notification.permission === "granted"
            ) {
              new Notification(`Crítico: ${a.placa}`, {
                body: `${a.tipo}${a.local ? " · " + a.local : ""}`,
                tag: a.id,
              });
            }
          }
          vistosRef.current.add(a.id);
        }
      })
      .catch(() => {});
  }, [cliente]);

  // Esconde o toast depois de 8s
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    const id = setInterval(atualizarAlertas, 15000);
    return () => clearInterval(id);
  }, [atualizarAlertas]);

  // Filtros da URL
  const tiposParam = searchParams.get("tipos") ?? "";
  const nivelParam = searchParams.get("nivel") ?? "";
  const soProblema = searchParams.get("problema") === "1";
  const soTurno = searchParams.get("turno") === "1";

  const tiposChips = tiposParam ? tiposParam.split(",").filter(Boolean) : [];
  const GRUPO_JAMMER = ["jammer", "sinal", "bloqueio"];
  const tiposSel = [
    ...new Set(
      tiposChips.flatMap((t) => (GRUPO_JAMMER.includes(t) ? GRUPO_JAMMER : [t]))
    ),
  ];
  const niveisAtivos = nivelParam ? nivelParam.split(",").filter(Boolean) : [];
  const cutoffTurno = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

  const alertasFiltrados = alertas.filter((a) => {
    if (soTurno && a.status !== "ativo" && a.desde < cutoffTurno) return false;
    if (tiposSel.length > 0 && !tiposSel.includes(a.tipo?.toLowerCase() ?? "")) return false;
    return true;
  });

  const mostrarCriticos = niveisAtivos.length === 0 || niveisAtivos.includes("critico");
  const mostrarAtencao = niveisAtivos.length === 0 || niveisAtivos.includes("atencao");

  const criticos = alertasFiltrados
    .filter((a) => a.nivel === "critico")
    .sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo));

  const atencao = alertasFiltrados
    .filter((a) => a.nivel === "atencao")
    .sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo));

  const idsParaApitar = [
    ...alertas.filter((a) => a.nivel === "critico").map((a) => a.id),
    ...alertas
      .filter((a) => a.nivel === "atencao" && a.tipo === "parada_cliente")
      .map((a) => a.id),
  ];

  // Contagens para FiltrosBar
  const contagensTipos: Record<string, number> = {};
  for (const a of alertas) {
    const t = a.tipo ?? "outro";
    contagensTipos[t] = (contagensTipos[t] ?? 0) + 1;
  }
  const jammerTotal =
    (contagensTipos["jammer"] ?? 0) +
    (contagensTipos["sinal"] ?? 0) +
    (contagensTipos["bloqueio"] ?? 0);
  if (jammerTotal > 0) contagensTipos["jammer"] = jammerTotal;

  const contagens: Contagens = {
    tipos: contagensTipos,
    nivel: {
      critico: alertas.filter((a) => a.nivel === "critico").length,
      atencao: alertas.filter((a) => a.nivel === "atencao").length,
    },
  };

  const alertasVeiculoPanel = veiculoPanel
    ? alertas.filter((a) => a.cv === veiculoPanel.cv)
    : [];

  const focarMapa = useCallback((lat: number, lng: number) => {
    setFlyParaAlerta({ lat, lng, gatilho: Date.now() });
  }, []);

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* ======== SIDEBAR DE ALERTAS ======== */}
      <div
        style={{
          width: SIDEBAR_W,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--bg)",
          borderRight: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        {/* Cabecalho fixo da sidebar */}
        <div
          style={{
            flexShrink: 0,
            padding: "0.875rem 1rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Seletor de cliente */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {clientes.map((c) => (
              <Link
                key={c.id}
                href={`?cliente=${c.cod}`}
                style={{
                  padding: "0.25rem 0.625rem",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  backgroundColor:
                    c.id === clienteAtivoId ? "var(--accent-dim)" : "transparent",
                  border: `1px solid ${
                    c.id === clienteAtivoId ? "var(--accent)" : "var(--border)"
                  }`,
                  color:
                    c.id === clienteAtivoId ? "var(--accent)" : "var(--text-dim)",
                  textDecoration: "none",
                }}
              >
                {c.nome}
              </Link>
            ))}
          </div>

          {/* Apito + metricas */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AlertaSonoro idsParaApitar={idsParaApitar} />
              <button
                onClick={ativarNotificacoes}
                title={notifLigada ? "Notificações ativas" : "Ativar notificações de crítico"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  cursor: "pointer",
                  border: `1px solid ${notifLigada ? "var(--verde)" : "var(--border)"}`,
                  backgroundColor: notifLigada ? "rgba(34,197,94,0.12)" : "transparent",
                  color: notifLigada ? "var(--verde)" : "var(--text-dim)",
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </button>
            </div>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ textAlign: "center" }}>
                <p
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontWeight: 700,
                    fontSize: "1.1rem",
                    color: criticos.length > 0 ? "var(--vermelho)" : "var(--text-dim)",
                    lineHeight: 1,
                  }}
                >
                  {criticos.length}
                </p>
                <p
                  style={{
                    fontSize: 9,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    marginTop: 2,
                  }}
                >
                  críticos
                </p>
              </div>
              <div style={{ textAlign: "center" }}>
                <p
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontWeight: 700,
                    fontSize: "1.1rem",
                    color: atencao.length > 0 ? "var(--amarelo)" : "var(--text-dim)",
                    lineHeight: 1,
                  }}
                >
                  {atencao.length}
                </p>
                <p
                  style={{
                    fontSize: 9,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    marginTop: 2,
                  }}
                >
                  atenção
                </p>
              </div>
            </div>
          </div>

          {/* Filtros */}
          <FiltrosBar contagens={contagens} />
        </div>

        {/* Lista scrollavel de alertas */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0.875rem 1rem" }}>
          {mostrarCriticos && (
            <section style={{ marginBottom: "1.25rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.75rem" }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: criticos.length > 0 ? "var(--vermelho)" : "var(--border)",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <h2
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    color: "var(--text-muted)",
                    margin: 0,
                  }}
                >
                  Crítico
                  <span
                    style={{
                      marginLeft: 8,
                      fontFamily: "var(--font-geist-mono, monospace)",
                      color: criticos.length > 0 ? "var(--vermelho)" : "var(--text-dim)",
                    }}
                  >
                    {criticos.length}
                  </span>
                </h2>
                <div style={{ flex: 1, height: 1, backgroundColor: "var(--border)" }} />
              </div>
              {criticos.length === 0 ? (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--text-dim)",
                    padding: "0.75rem",
                    backgroundColor: "var(--card)",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                  }}
                >
                  Nenhuma ocorrência crítica.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {criticos.map((a) => (
                    <CardAlertaCritico
                      key={a.id}
                      id={a.id}
                      status={a.status}
                      nivel={a.nivel}
                      tipo={a.tipo}
                      placa={a.placa}
                      motivo={a.motivo}
                      local={a.local}
                      desde={a.desde}
                      lat={a.lat}
                      lng={a.lng}
                      velocidade={a.velocidade}
                      ignicao={a.ignicao}
                      atraso_min={a.atraso_min}
                      score={a.score}
                      onFocarMapa={focarMapa}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {mostrarAtencao && !soProblema && (
            <section>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.75rem" }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: atencao.length > 0 ? "var(--amarelo)" : "var(--border)",
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <h2
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    color: "var(--text-muted)",
                    margin: 0,
                  }}
                >
                  Atenção
                  <span
                    style={{
                      marginLeft: 8,
                      fontFamily: "var(--font-geist-mono, monospace)",
                      color: atencao.length > 0 ? "var(--amarelo)" : "var(--text-dim)",
                    }}
                  >
                    {atencao.length}
                  </span>
                </h2>
                <div style={{ flex: 1, height: 1, backgroundColor: "var(--border)" }} />
              </div>
              {atencao.length === 0 ? (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--text-dim)",
                    padding: "0.75rem",
                    backgroundColor: "var(--card)",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                  }}
                >
                  Nada em atenção.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {atencao.map((a) => (
                    <CardAlertaCritico
                      key={a.id}
                      id={a.id}
                      status={a.status}
                      nivel={a.nivel}
                      tipo={a.tipo}
                      placa={a.placa}
                      motivo={a.motivo}
                      local={a.local}
                      desde={a.desde}
                      lat={a.lat}
                      lng={a.lng}
                      velocidade={a.velocidade}
                      ignicao={a.ignicao}
                      atraso_min={a.atraso_min}
                      score={a.score}
                      onFocarMapa={focarMapa}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {/* ======== MAPA (ocupar restante) ======== */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Toast de critico novo */}
        {toast && (
          <div
            onClick={() => setToast(null)}
            style={{
              position: "absolute",
              top: 12,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 1002,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0.625rem 1rem",
              borderRadius: 10,
              cursor: "pointer",
              backgroundColor: "rgba(20,4,4,0.96)",
              border: "1px solid var(--vermelho, #ef4444)",
              boxShadow: "0 8px 28px rgba(0,0,0,0.7)",
              backdropFilter: "blur(8px)",
              animation: "pulse-live 1.5s ease-in-out infinite",
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                backgroundColor: "var(--vermelho, #ef4444)",
                flexShrink: 0,
              }}
            />
            <div>
              <p style={{ fontSize: 12, fontWeight: 700, color: "var(--vermelho, #ef4444)", letterSpacing: "0.04em" }}>
                NOVO CRÍTICO · {toast.placa}
              </p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{toast.tipo}</p>
            </div>
          </div>
        )}

        <MapaMonitor
          cliente={cliente}
          veiculos={veiculos}
          clientes={clientes}
          clienteAtivoId={clienteAtivoId}
          mostrarSidebar={false}
          flyParaAlerta={flyParaAlerta}
          onVeiculoComAlertaClicado={(cv, placa) => setVeiculoPanel({ cv, placa })}
        />

        {/* Painel flutuante do veiculo com alerta */}
        {veiculoPanel && alertasVeiculoPanel.length > 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              zIndex: 1001,
            }}
          >
            <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, pointerEvents: "auto" }}>
              <PainelVeiculoAlerta
                cv={veiculoPanel.cv}
                placa={veiculoPanel.placa}
                alertas={alertasVeiculoPanel.map((a) => ({
                  id: a.id,
                  status: a.status,
                  nivel: a.nivel,
                  tipo: a.tipo,
                  motivo: a.motivo,
                  desde: a.desde,
                  score: a.score,
                }))}
                onFechar={() => setVeiculoPanel(null)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
