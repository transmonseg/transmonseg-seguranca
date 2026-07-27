"use client";

import { useEffect, useRef, useState, useCallback, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import AlertaSonoro from "./AlertaSonoro";
import CardAlertaCritico from "./CardAlertaCritico";
import PainelVeiculoAlerta from "./PainelVeiculoAlerta";
import { resolverVarios } from "../acoes-alertas";

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
  rotaConcluida?: boolean;
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
  if (t === "desvio" || t === "excesso" || t === "parada_fora_tapete") return 10;
  return 11;
}

// Normaliza o tipo para a chave de grupo (jammer/sinal/bloqueio viram "jammer";
// parada_fora_tapete e' internamente um tipo proprio -- pra nao compartilhar o
// slot de arbitracao/escalonamento do desvio de movimento (achado 27/07: risco
// de engolir um desvio critico real) -- mas o operador deve ve-la junto do
// desvio, entao agrupa visualmente aqui).
function chaveTipo(t: string): string {
  const x = (t ?? "").toLowerCase();
  if (x === "jammer" || x.includes("sinal") || x.includes("bloqueio")) return "jammer";
  if (x === "parada_fora_tapete") return "desvio";
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
  parada_fora_tapete: "Desvio de rota",
  excesso: "Excesso de velocidade",
};
function nomeTipo(t: string): string {
  return NOME_TIPO[t] ?? t.replace(/_/g, " ");
}

// Todos os grupos comecam recolhidos; o operador abre o que quiser.
const EXPANDIR_PADRAO = new Set<string>();


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
  const limparSelecaoMapaRef = useRef<(() => void) | null>(null);
  const selecionarVeiculoMapaRef = useRef<((cv: string, placa: string) => void) | null>(null);

  const [veiculoPanel, setVeiculoPanel] = useState<{ cv: string; placa: string } | null>(null);

  // Filtro de nivel e grupos recolhidos
  const [vista, setVista] = useState<Vista>("tudo");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  // Paineis laterais independentes (ambos podem estar abertos ao mesmo tempo)
  const [mostrarAlertas, setMostrarAlertas] = useState(true);
  const [mostrarOperacao, setMostrarOperacao] = useState(false);

  // Fila de toasts de criticos novos
  interface ToastInfo { id: string; cv: string; placa: string; tipo: string; lat: number | null; lng: number | null; motivo: string | null; }
  const [toastsCriticos, setToastsCriticos] = useState<ToastInfo[]>([]);
  const [notifLigada, setNotifLigada] = useState(false);
  // Ref do veiculo atualmente selecionado no mapa (recebido via onCvChange)
  const cvSelecionadoRef = useRef<string | null>(null);
  // Trigger de zoom celestial para o mapa
  const [criticoFly, setCriticoFly] = useState<{ lat: number; lng: number; gatilho: number } | null>(null);
  // IDs novos (para badge NOVO nos cards) — removidos após 60s
  const [novosIds, setNovosIds] = useState<Set<string>>(new Set());

  // Resolver todos: confirmação inline + pending
  const [resolvendoTodos, startResolverTodos] = useTransition();
  const [confirmarResolver, setConfirmarResolver] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        const novosCriticos: AlertaEnriquecido[] = [];
        const todosNovos: AlertaEnriquecido[] = [];
        for (const a of novos) {
          if (!vistosRef.current.has(a.id)) {
            todosNovos.push(a);
            if (a.nivel === "critico") {
              novosCriticos.push(a);
              if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                new Notification(`Crítico: ${a.placa}`, {
                  body: `${nomeTipo(chaveTipo(a.tipo))}${a.local ? " · " + a.local : ""}`,
                  tag: a.id,
                });
              }
            }
          }
          vistosRef.current.add(a.id);
        }
        if (novosCriticos.length > 0) {
          // Adiciona a fila de toasts (max 5, mais recente na frente)
          setToastsCriticos(prev => {
            const entradas = novosCriticos.map(a => ({ id: a.id, cv: a.cv, placa: a.placa, tipo: a.tipo, lat: a.lat, lng: a.lng, motivo: a.motivo }));
            return [...entradas, ...prev].slice(0, 5);
          });
          // Zoom + painel automatico apenas se nenhum veiculo esta selecionado
          const primeiro = novosCriticos[0];
          if (cvSelecionadoRef.current === null) {
            if (primeiro.lat != null && primeiro.lng != null) {
              setCriticoFly({ lat: primeiro.lat, lng: primeiro.lng, gatilho: Date.now() });
            }
            selecionarVeiculoMapaRef.current?.(primeiro.cv, primeiro.placa);
            setVeiculoPanel({ cv: primeiro.cv, placa: primeiro.placa });
            setMostrarOperacao(true);
          }
        }
        if (todosNovos.length > 0) {
          const ids = todosNovos.map(a => a.id);
          setNovosIds(prev => new Set([...prev, ...ids]));
          setTimeout(() => {
            setNovosIds(prev => { const s = new Set(prev); for (const id of ids) s.delete(id); return s; });
          }, 60000);
        }
      })
      .catch(() => {});
  }, [cliente]);

  // Auto-dismiss do toast mais recente (topo da fila) apos 25s
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (toastsCriticos.length === 0) return;
    const topoId = toastsCriticos[0].id;
    const t = setTimeout(() => {
      setToastsCriticos(prev => prev.filter(x => x.id !== topoId));
    }, 25000);
    return () => clearTimeout(t);
  }, [toastsCriticos[0]?.id]);

  useEffect(() => {
    atualizarAlertas(); // busca imediata (evita esperar 15s ao trocar de cliente)
    const id = setInterval(atualizarAlertas, 15000);
    return () => clearInterval(id);
  }, [atualizarAlertas]);

  // Trocar de cliente (Nutry/Benassi) NAO remonta o componente — o Next so passa
  // novas props. Sem isto o estado ficava preso no cliente anterior. Ressincroniza
  // os alertas com a prop nova e limpa a selecao/toasts do cliente antigo.
  const primeiroRenderRef = useRef(true);
  useEffect(() => {
    if (primeiroRenderRef.current) { primeiroRenderRef.current = false; return; }
    setAlertas(alertasIniciais);
    vistosRef.current = new Set(alertasIniciais.map((a) => a.id));
    setVeiculoPanel(null);
    setToastsCriticos([]);
    setMostrarOperacao(false);
    limparSelecaoMapaRef.current?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteAtivoId]);

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

  const focarMapa = useCallback((lat: number, lng: number, cv?: string, placa?: string) => {
    setFlyParaAlerta({ lat, lng, gatilho: Date.now() });
    if (cv && placa) {
      selecionarVeiculoMapaRef.current?.(cv, placa);
      setVeiculoPanel({ cv, placa });
      setMostrarOperacao(true);
    }
  }, []);

  // Resolve todos os alertas visíveis (respeita o filtro de nível ativo).
  // Primeiro clique pede confirmação; segundo clique (em até 4s) executa.
  function executarResolverTodos() {
    const ids = visiveis.map((a) => a.id);
    if (ids.length === 0 || resolvendoTodos) return;
    if (!confirmarResolver) {
      setConfirmarResolver(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmarResolver(false), 4000);
      return;
    }
    setConfirmarResolver(false);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    const idsSet = new Set(ids);
    startResolverTodos(async () => {
      const r = await resolverVarios(ids);
      if (!r?.erro) {
        setAlertas((prev) => prev.filter((a) => !idsSet.has(a.id)));
        setToastsCriticos((prev) => prev.filter((t) => !idsSet.has(t.id)));
        setVeiculoPanel((p) => {
          if (!p) return p;
          const restam = alertas.filter((a) => a.cv === p.cv && !idsSet.has(a.id));
          return restam.length === 0 ? null : p;
        });
      }
    });
  }

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

  const painelAlertasJsx = (
    <>
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

        {/* Resolver todos (respeita o filtro de nível ativo) */}
        {visiveis.length > 0 && (
          <button
            onClick={executarResolverTodos}
            disabled={resolvendoTodos}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              padding: "0.5rem 0.625rem",
              borderRadius: 8,
              cursor: resolvendoTodos ? "default" : "pointer",
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: "0.02em",
              transition: "all 0.12s",
              border: confirmarResolver
                ? "1px solid var(--verde)"
                : "1px solid color-mix(in srgb, var(--verde) 30%, transparent)",
              backgroundColor: confirmarResolver
                ? "color-mix(in srgb, var(--verde) 22%, transparent)"
                : "color-mix(in srgb, var(--verde) 8%, transparent)",
              color: "var(--verde)",
              opacity: resolvendoTodos ? 0.6 : 1,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {resolvendoTodos
              ? "Resolvendo..."
              : confirmarResolver
              ? `Confirmar — resolver ${visiveis.length}?`
              : `Resolver ${
                  vista === "critico" ? "críticos" : vista === "atencao" ? "em atenção" : "todos"
                } (${visiveis.length})`}
          </button>
        )}
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
                          cv={a.cv}
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
                          rotaConcluida={a.rotaConcluida}
                          novo={novosIds.has(a.id)}
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
    </>
  );

  return (
    <div style={{ height: "100%", position: "relative", overflow: "hidden" }}>
      <MapaMonitor
        cliente={cliente}
        veiculos={veiculos}
        clientes={clientes}
        clienteAtivoId={clienteAtivoId}
        mostrarSidebar={mostrarOperacao}
        flyParaAlerta={flyParaAlerta}
        flyParaAlertaCritico={criticoFly}
        onCvChange={(cv) => { cvSelecionadoRef.current = cv; }}
        limparSelecaoRef={limparSelecaoMapaRef}
        selecionarVeiculoRef={selecionarVeiculoMapaRef}
        onVeiculoComAlertaClicado={(cv, placa) => { setVeiculoPanel({ cv, placa }); setMostrarAlertas(true); }}
        painelEsquerdo={veiculoPanel ? (
          <PainelVeiculoAlerta
            cv={veiculoPanel.cv}
            placa={veiculoPanel.placa}
            alertas={alertasVeiculoPanel.map((a) => ({
              id: a.id, status: a.status, nivel: a.nivel,
              tipo: a.tipo, motivo: a.motivo, desde: a.desde, score: a.score,
            }))}
            onFechar={() => { setVeiculoPanel(null); limparSelecaoMapaRef.current?.(); }}
            onAlertaResolvido={removerAlerta}
            empresa={empresaNome}
          />
        ) : painelAlertasJsx}
        mostrarPainelEsquerdo={mostrarAlertas || !!veiculoPanel}
        onTogglePainelEsquerdo={() => { if (veiculoPanel) { setVeiculoPanel(null); limparSelecaoMapaRef.current?.(); } else setMostrarAlertas((v) => !v); }}
        onToggleSidebar={() => setMostrarOperacao((v) => !v)}
        onAbrirSidebar={() => setMostrarOperacao(true)}
      />

      {/* Multi-toast de criticos — centrado no topo, abaixo do header */}
      {toastsCriticos.length > 0 && (
        <div
          style={{
            position: "fixed",
            top: 64,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1300,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignItems: "center",
            width: "100%",
            maxWidth: 460,
            pointerEvents: "none",
            padding: "0 12px",
          }}
        >
          {/* Toast principal (mais recente) */}
          <div
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "0.8rem 1rem",
              borderRadius: 12,
              backgroundColor: "rgba(16,2,2,0.97)",
              border: "1.5px solid var(--vermelho, #ef4444)",
              boxShadow: "0 0 32px rgba(239,68,68,0.25), 0 4px 20px rgba(0,0,0,0.9)",
              backdropFilter: "blur(14px)",
              pointerEvents: "auto",
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                backgroundColor: "var(--vermelho, #ef4444)",
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 10, fontWeight: 800, color: "var(--vermelho, #ef4444)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Alerta critico
              </p>
              <p style={{ fontSize: 19, fontWeight: 700, color: "#fff", fontFamily: "var(--font-geist-mono, monospace)", letterSpacing: "0.1em", marginTop: 1, lineHeight: 1 }}>
                {toastsCriticos[0].placa}
              </p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {nomeTipo(chaveTipo(toastsCriticos[0].tipo))}
                {toastsCriticos[0].motivo ? ` — ${toastsCriticos[0].motivo.slice(0, 55)}` : ""}
              </p>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
              <button
                onClick={() => {
                  const t = toastsCriticos[0];
                  if (t.lat != null && t.lng != null) setFlyParaAlerta({ lat: t.lat, lng: t.lng, gatilho: Date.now() });
                  selecionarVeiculoMapaRef.current?.(t.cv, t.placa);
                  setVeiculoPanel({ cv: t.cv, placa: t.placa });
                  setMostrarAlertas(true);
                }}
                style={{ padding: "0.3rem 0.65rem", borderRadius: 7, fontSize: 11, fontWeight: 800, background: "var(--vermelho, #ef4444)", color: "#fff", border: "none", cursor: "pointer", letterSpacing: "0.05em" }}
              >
                FOCAR
              </button>
              <button
                onClick={() => setToastsCriticos(prev => prev.slice(1))}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 2, lineHeight: 0 }}
                title="Fechar"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          {/* Contador de pendentes + dispensar todos */}
          {toastsCriticos.length > 1 && (
            <button
              onClick={() => setToastsCriticos([])}
              style={{
                padding: "0.28rem 1rem",
                borderRadius: 20,
                fontSize: 11,
                fontWeight: 700,
                color: "var(--vermelho, #ef4444)",
                backgroundColor: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                cursor: "pointer",
                letterSpacing: "0.04em",
                pointerEvents: "auto",
              }}
            >
              +{toastsCriticos.length - 1} {toastsCriticos.length - 1 === 1 ? "outro critico" : "outros criticos"} — dispensar todos
            </button>
          )}
        </div>
      )}

    </div>
  );
}
