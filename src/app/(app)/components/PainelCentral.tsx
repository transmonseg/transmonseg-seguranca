"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import AlertaSonoro from "./AlertaSonoro";
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

type Vista = "tudo" | "critico" | "atencao";

function ordemSeveridade(tipo: string): number {
  const t = tipo?.toLowerCase() ?? "";
  if (t === "panico") return 0;
  if (t === "bau") return 1;
  if (t === "favela") return 2;
  if (t === "tiroteio") return 3;
  if (t === "jammer" || t.includes("sinal") || t.includes("bloqueio")) return 4;
  if (t === "saida_nao_autorizada") return 5;
  if (t === "ignicao_noturna") return 6;
  if (t === "parada_cliente") return 7;
  if (t === "parada_anomala") return 8;
  if (t === "parada_longa") return 9;
  if (t === "desvio" || t === "excesso") return 10;
  return 11;
}

// Normaliza o tipo para a chave de grupo (jammer/sinal/bloqueio viram "jammer").
function chaveTipo(t: string): string {
  const x = (t ?? "").toLowerCase();
  if (x === "jammer" || x.includes("sinal") || x.includes("bloqueio")) return "jammer";
  return x;
}

const NOME_TIPO: Record<string, string> = {
  panico: "Pânico",
  bau: "Baú aberto",
  favela: "Favela / risco",
  tiroteio: "Tiroteio",
  jammer: "Jammer / sinal",
  saida_nao_autorizada: "Saída não autorizada",
  ignicao_noturna: "Ignição noturna",
  parada_cliente: "Parada no cliente",
  parada_anomala: "Parada anômala",
  parada_longa: "Parada longa",
  desvio: "Desvio de rota",
  excesso: "Excesso de velocidade",
};
function nomeTipo(t: string): string {
  return NOME_TIPO[t] ?? t.replace(/_/g, " ");
}

// Tipos graves que ja abrem expandidos; os demais comecam recolhidos.
const EXPANDIR_PADRAO = new Set([
  "panico",
  "bau",
  "favela",
  "tiroteio",
  "jammer",
  "saida_nao_autorizada",
]);

const SIDEBAR_W = 380;

export default function PainelCentral({
  cliente,
  clientes,
  clienteAtivoId,
  veiculos,
  alertasIniciais,
}: Props) {
  const [alertas, setAlertas] = useState<AlertaEnriquecido[]>(alertasIniciais);
  const [flyParaAlerta, setFlyParaAlerta] = useState<{ lat: number; lng: number; gatilho: number } | null>(null);
  const vistosRef = useRef<Set<string>>(new Set(alertasIniciais.map((a) => a.id)));

  const [veiculoPanel, setVeiculoPanel] = useState<{ cv: string; placa: string } | null>(null);

  // Filtro de nivel e grupos recolhidos
  const [vista, setVista] = useState<Vista>("tudo");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  // Modo da barra esquerda: operacao (Unitrac) ou alertas (inteligencia)
  const [modoBarra, setModoBarra] = useState<"operacao" | "alertas">("alertas");

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

  // Remove alerta do estado sem esperar o próximo poll (optimistic)
  const removerAlerta = useCallback((id: string) => {
    setAlertas((prev) => prev.filter((a) => a.id !== id));
    setVeiculoPanel((p) => {
      // Fechar painel se o alerta era o único daquele veículo
      if (!p) return p;
      const restam = alertas.filter((a) => a.cv === p.cv && a.id !== id);
      return restam.length === 0 ? null : p;
    });
  }, [alertas]);

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
            // Auto-abrir painel do veículo no novo crítico
            setVeiculoPanel({ cv: a.cv, placa: a.placa });
            setToast({ placa: a.placa, tipo: a.tipo, id: a.id });
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification(`Crítico: ${a.placa}`, {
                body: `${nomeTipo(chaveTipo(a.tipo))}${a.local ? " · " + a.local : ""}`,
                tag: a.id,
              });
            }
          }
          vistosRef.current.add(a.id);
        }
      })
      .catch(() => {});
  }, [cliente]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 15000);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    const id = setInterval(atualizarAlertas, 15000);
    return () => clearInterval(id);
  }, [atualizarAlertas]);

  const nCriticos = alertas.filter((a) => a.nivel === "critico").length;
  const nAtencao = alertas.filter((a) => a.nivel === "atencao").length;

  const idsParaApitar = [
    ...alertas.filter((a) => a.nivel === "critico").map((a) => a.id),
    ...alertas.filter((a) => a.nivel === "atencao" && a.tipo === "parada_cliente").map((a) => a.id),
  ];

  // Lista visivel conforme o filtro de nivel
  const visiveis = alertas.filter((a) =>
    vista === "critico" ? a.nivel === "critico" : vista === "atencao" ? a.nivel === "atencao" : true
  );

  // Agrupa por tipo
  const mapaGrupos = new Map<string, AlertaEnriquecido[]>();
  for (const a of visiveis) {
    const k = chaveTipo(a.tipo);
    const lista = mapaGrupos.get(k) ?? [];
    lista.push(a);
    mapaGrupos.set(k, lista);
  }
  const grupos = [...mapaGrupos.entries()]
    .map(([tipo, lista]) => ({
      tipo,
      lista: lista.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.desde < a.desde ? -1 : 1)),
      temCritico: lista.some((a) => a.nivel === "critico"),
    }))
    .sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo));

  function estaExpandido(tipo: string): boolean {
    return toggled[tipo] ?? EXPANDIR_PADRAO.has(tipo);
  }
  function alternarGrupo(tipo: string) {
    setToggled((t) => ({ ...t, [tipo]: !estaExpandido(tipo) }));
  }

  const alertasVeiculoPanel = veiculoPanel ? alertas.filter((a) => a.cv === veiculoPanel.cv) : [];

  const focarMapa = useCallback((lat: number, lng: number) => {
    setFlyParaAlerta({ lat, lng, gatilho: Date.now() });
  }, []);

  const empresaNome = clientes.find((c) => c.id === clienteAtivoId)?.nome;

  // Botao do segmented de nivel
  const segBtn = (alvo: Vista, rotulo: string, n: number, cor: string) => {
    const ativo = vista === alvo;
    return (
      <button
        onClick={() => setVista(alvo)}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "0.4rem 0.5rem",
          borderRadius: 7,
          cursor: "pointer",
          border: "1px solid transparent",
          backgroundColor: ativo ? "color-mix(in srgb, " + cor + " 16%, transparent)" : "transparent",
          color: ativo ? cor : "var(--text-dim)",
          fontSize: 11,
          fontWeight: 700,
          transition: "background 0.12s",
        }}
      >
        {rotulo}
        <span
          style={{
            fontFamily: "var(--font-geist-mono, monospace)",
            fontSize: 11,
            fontWeight: 700,
            color: ativo ? cor : "var(--text-dim)",
          }}
        >
          {n}
        </span>
      </button>
    );
  };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ======== SIDEBAR DE ALERTAS (modo alertas) ======== */}
      {modoBarra === "alertas" && (
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
        {/* Cabecalho fixo */}
        <div
          style={{
            flexShrink: 0,
            padding: "0.75rem 0.875rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          {/* Cliente + apito + notif */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
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
                    backgroundColor: c.id === clienteAtivoId ? "var(--accent-dim)" : "transparent",
                    border: `1px solid ${c.id === clienteAtivoId ? "var(--accent)" : "var(--border)"}`,
                    color: c.id === clienteAtivoId ? "var(--accent)" : "var(--text-dim)",
                    textDecoration: "none",
                  }}
                >
                  {c.nome}
                </Link>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
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
          </div>

          {/* Segmented de nivel: Tudo | Criticos | Atencao */}
          <div
            style={{
              display: "flex",
              gap: 3,
              padding: 3,
              borderRadius: 9,
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
            }}
          >
            {segBtn("tudo", "Tudo", nCriticos + nAtencao, "var(--accent)")}
            {segBtn("critico", "Críticos", nCriticos, "var(--vermelho)")}
            {segBtn("atencao", "Atenção", nAtencao, "var(--amarelo)")}
          </div>
        </div>

        {/* Lista scrollavel agrupada por tipo */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0.625rem 0.75rem" }}>
          {grupos.length === 0 ? (
            <p
              style={{
                fontSize: 12,
                color: "var(--text-dim)",
                padding: "0.875rem",
                backgroundColor: "var(--card)",
                borderRadius: 8,
                border: "1px solid var(--border)",
                textAlign: "center",
              }}
            >
              {vista === "critico"
                ? "Nenhuma ocorrência crítica."
                : vista === "atencao"
                ? "Nada em atenção."
                : "Tudo tranquilo. Sem alertas."}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {grupos.map((g) => {
                const aberto = estaExpandido(g.tipo);
                const cor = g.temCritico ? "var(--vermelho)" : "var(--amarelo)";
                return (
                  <section key={g.tipo}>
                    {/* Cabecalho do grupo (clicavel) */}
                    <button
                      onClick={() => alternarGrupo(g.tipo)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "0.5rem 0.625rem",
                        borderRadius: 8,
                        cursor: "pointer",
                        border: "1px solid var(--border)",
                        backgroundColor: "var(--card)",
                        color: "var(--text)",
                        textAlign: "left",
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          backgroundColor: cor,
                          flexShrink: 0,
                          display: "inline-block",
                        }}
                      />
                      <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, color: "var(--text)" }}>
                        {nomeTipo(g.tipo)}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-geist-mono, monospace)",
                          fontSize: 12,
                          fontWeight: 700,
                          color: cor,
                          minWidth: 18,
                          textAlign: "right",
                        }}
                      >
                        {g.lista.length}
                      </span>
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--text-dim)"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ flexShrink: 0, transform: aberto ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>

                    {/* Cards do grupo */}
                    {aberto && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                        {g.lista.map((a) => (
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
                            onAlertaResolvido={removerAlerta}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
      )}

      {/* ======== MAPA ======== */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Toggle Operação | Alertas */}
        <div
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            display: "flex",
            gap: 3,
            padding: 3,
            borderRadius: 10,
            backgroundColor: "rgba(9,9,13,0.92)",
            border: "1px solid var(--border)",
            backdropFilter: "blur(6px)",
          }}
        >
          {(["operacao", "alertas"] as const).map((m) => {
            const ativo = modoBarra === m;
            return (
              <button
                key={m}
                onClick={() => setModoBarra(m)}
                style={{
                  padding: "0.35rem 0.9rem",
                  borderRadius: 8,
                  border: "1px solid transparent",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                  backgroundColor: ativo ? "var(--accent-dim)" : "transparent",
                  color: ativo ? "var(--accent)" : "var(--text-dim)",
                }}
              >
                {m === "operacao" ? "Operação" : "Alertas"}
              </button>
            );
          })}
        </div>

        {/* Toast de critico novo — bottom-right, grande, 15s */}
        {toast && (
          <div
            style={{
              position: "absolute",
              bottom: 24,
              right: 24,
              zIndex: 1002,
              display: "flex",
              alignItems: "flex-start",
              gap: 14,
              padding: "1rem 1.25rem",
              borderRadius: 14,
              backgroundColor: "rgba(20,4,4,0.97)",
              border: "1.5px solid var(--vermelho, #ef4444)",
              boxShadow: "0 12px 40px rgba(239,68,68,0.25), 0 4px 16px rgba(0,0,0,0.8)",
              backdropFilter: "blur(10px)",
              maxWidth: 320,
              animation: "pulse-live 1.5s ease-in-out 3",
            }}
          >
            <span style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "var(--vermelho, #ef4444)", flexShrink: 0, marginTop: 3 }} />
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 13, fontWeight: 800, color: "var(--vermelho, #ef4444)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
                Novo crítico
              </p>
              <p style={{ fontSize: 18, fontWeight: 700, color: "#fff", fontFamily: "var(--font-geist-mono, monospace)", letterSpacing: "0.1em", marginTop: 2 }}>
                {toast.placa}
              </p>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>{nomeTipo(chaveTipo(toast.tipo))}</p>
            </div>
            <button
              onClick={() => setToast(null)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, flexShrink: 0 }}
              title="Fechar"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        <MapaMonitor
          cliente={cliente}
          veiculos={veiculos}
          clientes={clientes}
          clienteAtivoId={clienteAtivoId}
          mostrarSidebar={modoBarra === "operacao"}
          flyParaAlerta={flyParaAlerta}
          onVeiculoComAlertaClicado={(cv, placa) => setVeiculoPanel({ cv, placa })}
        />

        {/* Painel flutuante do veiculo (qualquer veiculo clicado) */}
        {veiculoPanel && (
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1001 }}>
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
                empresa={empresaNome}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
