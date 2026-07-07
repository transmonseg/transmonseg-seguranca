"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import AlertaSonoro from "../components/AlertaSonoro";
import { resolverAlerta, marcarFalsoPositivo, resolverVarios } from "../acoes-alertas";
import { enviarComandoVeiculo } from "@/lib/unitrac-comandos";
import { createClient as createSupabaseBrowser } from "@/lib/supabase/browser";
import type { VeiculoMapa, Parada, PontoEntrega, Tiroteio, GeoJsonCollection } from "./MapaLeafletV2";
import { COR_PENDENTE, COR_ENTREGUE, COR_OUTRO } from "./MapaLeafletV2";
import { DARK_TOKENS, LIGHT_TOKENS, SAT_TILE_URL, SAT_TILE_SUBDOMAINS } from "./tokens";

const MapaLeafletV2 = dynamic(() => import("./MapaLeafletV2"), { ssr: false });

// ── Types ──────────────────────────────────────────────────────────────
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
  origemLat: number | null;
  origemLng: number | null;
  velocidade: number | null;
  ignicao: boolean | null;
  atraso_min: number | null;
  local: string | null;
}

interface ClienteInfo { id: string; nome: string; cod: string; }

interface Props {
  cliente: string;
  clientes: ClienteInfo[];
  clienteAtivoId: string;
  veiculos: { placa: string; cv: string }[];
  alertasIniciais: AlertaEnriquecido[];
}

// ── Constants ──────────────────────────────────────────────────────────
const PERIODOS = [1, 2, 6, 12, 24, 48] as const;
const ZOOM_LABELS: [string, number][] = [["RUA", 17], ["QUADRA", 15], ["BAIRRO", 13], ["CIDADE", 11]];

const NOME_TIPO: Record<string, string> = {
  panico: "Pânico", bau: "Baú aberto", favela: "Favela/risco",
  tiroteio: "Tiroteio", jammer: "Jammer/sinal", saida_nao_autorizada: "Saída n.aut.",
  parada_anomala: "Par. anômala", parada_longa: "Par. longa", parada_cliente: "Par. cliente",
  ignicao_noturna: "Ign. noturna", desvio: "Desvio de rota", excesso: "Excesso vel.",
  retorno_tardio: "Retorno tardio", aceleracao: "Acel. brusca", sem_comunicacao: "Sem comunicação",
};
function nomeT(tipo: string) { return NOME_TIPO[tipo] ?? tipo; }

// Prioridade por tipo (maior = mais urgente)
const TIPO_PRIORITY: Record<string, number> = {
  desvio: 15, panico: 12, saida_nao_autorizada: 10, jammer: 9,
  bau: 8, parada_cliente: 8, tiroteio: 7, parada_anomala: 6, ignicao_noturna: 5,
  retorno_tardio: 4, aceleracao: 3, favela: 2, parada_longa: 1,
};
function prioAlerta(a: { nivel: string; tipo: string }): number {
  return (a.nivel === "critico" ? 100 : 0) + (TIPO_PRIORITY[a.tipo] ?? 0);
}

// Tipos que disparam apito + flash de "novo" por cliente (cod_user_unitrac).
// Pedido do cliente (06/07/2026): parar de notificar tudo que vira crítico —
// cada operação só quer ser incomodada pelo que realmente importa pra ela.
// Todos os outros tipos continuam sendo detectados/salvos/visíveis na lista,
// só não tocam apito nem piscam como "novo". Cliente/tipo não mapeado aqui =
// não notifica nada (default seguro).
// PÂNICO é exceção de segurança e sempre notifica, em qualquer cliente —
// não é negociável mesmo se não estiver nessa lista.
const TIPOS_NOTIFICAM_POR_CLIENTE: Record<string, string[]> = {
  "4096": ["desvio"],          // Nutry: só desvio de rota (já mostrado na faixa do topo)
  "4586": ["parada_cliente"],  // Benassi: só parada de 1h30+ dentro do cliente
};

function tempoAtras(desde: string): string {
  const diff = Math.floor((Date.now() - new Date(desde).getTime()) / 60000);
  if (diff < 60) return `${diff}min`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h`;
  return `${Math.floor(diff / 1440)}d`;
}

function formatarDist(m: number): string {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

// ── Font helpers ───────────────────────────────────────────────────────
const FONT_SANS = "var(--font-geist), system-ui, sans-serif";
const FONT_MONO = "var(--font-geist-mono), ui-monospace, 'Cascadia Code', monospace";

// ── Static style helpers ───────────────────────────────────────────────
const BASE_BTN: React.CSSProperties = {
  background: "transparent", border: "none", borderRadius: 6,
  cursor: "pointer", color: "inherit",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: FONT_SANS,
};

function tinyBtn(color: string): React.CSSProperties {
  return {
    height: 22, padding: "0 8px", borderRadius: 5,
    border: `1px solid ${color}28`, background: `${color}10`,
    cursor: "pointer", fontSize: 10, fontWeight: 700, color,
    fontFamily: FONT_SANS,
  };
}

const Z = { badge: 100, toasts: 800, combo: 850, drawer: 1000, panico: 2000, settings: 900 } as const;

// ── Main Component ────────────────────────────────────────────────────
export default function MonitorV2({ cliente, clientes, clienteAtivoId, veiculos: veiculosBase, alertasIniciais }: Props) {
  const [alertas, setAlertas] = useState<AlertaEnriquecido[]>(alertasIniciais);
  const alertasRef = useRef<AlertaEnriquecido[]>(alertasIniciais);
  const [veiculosMapa, setVeiculosMapa] = useState<VeiculoMapa[]>([]);

  // Vehicle selection
  const [cvSelecionado, setCvSelecionado] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Ref do cv selecionado — lido dentro do poll de posições (10s) sem
  // precisar recriar o efeito a cada seleção.
  const cvSelecionadoRef = useRef<string | null>(null);
  useEffect(() => { cvSelecionadoRef.current = cvSelecionado; }, [cvSelecionado]);
  // Guard: ignore map click within 500ms of a marker click (prevents disappear bug)
  const lastMarkerClickRef = useRef(0);
  // Abort controller for vehicle data fetches (cancels stale requests on vehicle switch)
  const fetchAbortRef = useRef<AbortController | null>(null);

  // Track/stops/alvos
  const [rastro, setRastro] = useState<[number, number][]>([]);
  const [paradas, setParadas] = useState<Parada[]>([]);
  const [alvos, setAlvos] = useState<PontoEntrega[]>([]);
  const [alvosGlobais, setAlvosGlobais] = useState<PontoEntrega[]>([]);
  // Pontos de entrega de TODA a frota — exibidos quando nenhum veículo está selecionado
  const [horas, setHoras] = useState<(typeof PERIODOS)[number]>(24);
  const [mostrarRastro, setMostrarRastro] = useState(false);
  const [mostrarParadas, setMostrarParadas] = useState(false);
  const [carregando, setCarregando] = useState(false);

  // Camadas de risco (favelas, tiroteios, roubo de carga) + perímetros das bases
  const [favelas, setFavelas] = useState<GeoJsonCollection | null>(null);
  const [tiroteios, setTiroteios] = useState<Tiroteio[]>([]);
  const [rouboCarga, setRouboCarga] = useState<GeoJsonCollection | null>(null);
  const [bases, setBases] = useState<GeoJsonCollection | null>(null);

  // Sirene / bloqueio
  const [cmdSirene, setCmdSirene] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
  const [cmdBloqueio, setCmdBloqueio] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  // Alterna a cada acionamento bem-sucedido — o rele fisico do veiculo alterna
  // (bloqueia/desbloqueia) a cada pulso do mesmo comando "bloqueio".
  const [motorBloqueado, setMotorBloqueado] = useState(false);

  // Map controls
  const [seguir, setSeguir] = useState(false);
  const [flyPara, setFlyPara] = useState<{ lat: number; lng: number; gatilho: number } | null>(null);
  const [zoomCmd, setZoomCmd] = useState<{ zoom: number; g: number } | null>(null);
  const [gatilhoFrota, setGatilhoFrota] = useState(0);
  const [zoomAtual, setZoomAtual] = useState(11);
  const gatilhoRef = useRef(0);

  // UI
  const [vista, setVista] = useState<"tudo" | "critico">("tudo");
  const [filtroComm, setFiltroComm] = useState<number | null>(null);
  const [busca, setBusca] = useState("");
  const [comboAberto, setComboAberto] = useState(false);
  const [novosIdsArr, setNovosIdsArr] = useState<string[]>([]);
  const [confirmarResolver, setConfirmarResolver] = useState(false);
  const [resolvendoTodos, startResolver] = useTransition();

  // Filtro por tipo de alerta (sidebar) — multi-select
  const [filtroTipos, setFiltroTipos] = useState<Set<string>>(new Set());

  // Grupos de frota Unitrac (gvc/gvn) — ex.: "H LOG SERVIÇOS", "PALETEIRAS", "COZINHA"
  const [grupos, setGrupos] = useState<{ gvc: number; gvn: string; veiculos: { placa: string; cv: string }[] }[]>([]);
  const [gruposOcultos, setGruposOcultos] = useState<Set<number>>(new Set());
  // Chips de grupo+tipo colapsados por padrão — clientes com muitos grupos/tipos
  // (ex.: Benassi com 7 grupos + 8 tipos) enchiam a sidebar de pilulas antes
  // mesmo de chegar na lista de alertas.
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);

  // "Ver apenas selecionados" — filtro manual por placa (Configurações), independente
  // dos grupos/tipos. modoSelecionados só entra em vigor quando o usuário confirma
  // no seletor (tela dedicada); a lista de cv's marcados fica salva mesmo desligado.
  const [veiculosSelecionados, setVeiculosSelecionados] = useState<Set<string>>(new Set());
  const [modoSelecionados, setModoSelecionados] = useState(false);
  const [seletorAberto, setSeletorAberto] = useState(false);
  const [buscaSeletor, setBuscaSeletor] = useState("");

  // Theme + satellite (satélite padrão = true)
  const [tema, setTema] = useState<"dark" | "light">("dark");
  const [satelite, setSatelite] = useState(true);
  const [settingsAberto, setSettingsAberto] = useState(false);

  // Visibilidade das camadas de risco
  const [camFavelas, setCamFavelas] = useState(true);
  const [camTiroteios, setCamTiroteios] = useState(true);
  const [camRouboCarga, setCamRouboCarga] = useState(true);
  const [camTrafego, setCamTrafego] = useState(false);
  const [legendaAberta, setLegendaAberta] = useState(false);

  // Alerta ativo (último card clicado na sidebar)
  const [alertaAtivoId, setAlertaAtivoId] = useState<string | null>(null);

  // Panico overlay
  const [panicoAlerta, setPanicoAlerta] = useState<AlertaEnriquecido | null>(null);
  const panicoVistosRef = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Carrega TODAS as configurações salvas no localStorage (roda uma vez na montagem)
  useEffect(() => {
    const tema = localStorage.getItem("transmonseg-tema") as "dark" | "light" | null;
    if (tema === "light") { document.documentElement.setAttribute("data-theme", "light"); setTema("light"); }
    // Satélite: padrão true — só desativa se usuário salvou "false" explicitamente
    if (localStorage.getItem("transmonseg-sat") === "false") setSatelite(false);
    if (localStorage.getItem("transmonseg-favelas") === "false") setCamFavelas(false);
    if (localStorage.getItem("transmonseg-tiroteios") === "false") setCamTiroteios(false);
    if (localStorage.getItem("transmonseg-roubo") === "false") setCamRouboCarga(false);
    if (localStorage.getItem("transmonseg-trafego") === "true") setCamTrafego(true);
    if (localStorage.getItem("transmonseg-legenda") === "true") setLegendaAberta(true);
    const vistaS = localStorage.getItem("transmonseg-vista");
    if (vistaS === "tudo" || vistaS === "critico") setVista(vistaS);
    const tiposS = localStorage.getItem("transmonseg-filtro-tipos");
    if (tiposS) { try { setFiltroTipos(new Set(JSON.parse(tiposS))); } catch { /* ignore */ } }
    const gruposOcultosS = localStorage.getItem("transmonseg-grupos-ocultos");
    if (gruposOcultosS) { try { setGruposOcultos(new Set(JSON.parse(gruposOcultosS))); } catch { /* ignore */ } }
    const veiculosSelS = localStorage.getItem("transmonseg-veiculos-selecionados");
    if (veiculosSelS) { try { setVeiculosSelecionados(new Set(JSON.parse(veiculosSelS))); } catch { /* ignore */ } }
    // modoSelecionados NUNCA persiste entre carregamentos — deliberado (achado
    // ao vivo 06/07: filtro ficou ligado com so 5 veiculos marcados e escondeu
    // a frota inteira, incluindo alertas ativos de OUTROS veiculos, sem que
    // ninguem percebesse ate reabrir a tela dias depois). A lista de veiculos
    // marcados continua salva pra reativar rapido, mas o modo em si sempre
    // comeca desligado a cada sessao — precisa de um clique consciente.
  }, []);

  const setTemaComPersistencia = useCallback((novo: "dark" | "light") => {
    localStorage.setItem("transmonseg-tema", novo);
    document.documentElement.setAttribute("data-theme", novo === "light" ? "light" : "");
    setTema(novo);
  }, []);

  const setSateliteComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-sat", String(v));
    setSatelite(v);
  }, []);

  const setCamFavelasComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-favelas", String(v));
    setCamFavelas(v);
  }, []);

  const setCamTiroteiosComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-tiroteios", String(v));
    setCamTiroteios(v);
  }, []);

  const setCamRouboCargaComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-roubo", String(v));
    setCamRouboCarga(v);
  }, []);

  const setCamTrafegoComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-trafego", String(v));
    setCamTrafego(v);
  }, []);

  const toggleLegenda = useCallback(() => {
    setLegendaAberta(v => {
      const next = !v;
      localStorage.setItem("transmonseg-legenda", String(next));
      return next;
    });
  }, []);

  const setVistaComPersistencia = useCallback((v: "tudo" | "critico") => {
    localStorage.setItem("transmonseg-vista", v);
    setVista(v);
  }, []);

  const toggleFiltroTipo = useCallback((tipo: string) => {
    setFiltroTipos(prev => {
      const next = new Set(prev);
      if (next.has(tipo)) next.delete(tipo); else next.add(tipo);
      localStorage.setItem("transmonseg-filtro-tipos", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const toggleGrupoOculto = useCallback((gvc: number) => {
    setGruposOcultos(prev => {
      const next = new Set(prev);
      if (next.has(gvc)) next.delete(gvc); else next.add(gvc);
      localStorage.setItem("transmonseg-grupos-ocultos", JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Selecao vazia sempre desliga o filtro junto — evita o estado fantasma
  // "FILTRO: 0 VEÍC." ativo sem nenhum veiculo escolhido (ex.: usuario clicou
  // "Limpar" no seletor e fechou sem clicar "Mostrar todos").
  const salvarVeiculosSelecionados = useCallback((next: Set<string>) => {
    setVeiculosSelecionados(next);
    localStorage.setItem("transmonseg-veiculos-selecionados", JSON.stringify([...next]));
    if (next.size === 0) setModoSelecionados(false);
  }, []);

  const toggleVeiculoSelecionado = useCallback((cv: string) => {
    setVeiculosSelecionados(prev => {
      const next = new Set(prev);
      if (next.has(cv)) next.delete(cv); else next.add(cv);
      localStorage.setItem("transmonseg-veiculos-selecionados", JSON.stringify([...next]));
      if (next.size === 0) setModoSelecionados(false);
      return next;
    });
  }, []);

  // Deliberadamente NAO persiste em localStorage (ver comentario no useEffect
  // de carregamento) — o modo sempre volta a "desligado" numa nova sessao.
  const setModoSelecionadosSessao = useCallback((v: boolean) => {
    setModoSelecionados(v);
  }, []);

  const tocarPanico = useCallback(() => {
    try {
      const ctx = audioCtxRef.current ?? new AudioContext();
      audioCtxRef.current = ctx;
      ctx.resume();
      const tocar = (t0: number, freq: number, dur: number) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "sawtooth";
        o.frequency.setValueAtTime(freq, t0);
        o.frequency.linearRampToValueAtTime(freq * 0.6, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.5, t0 + 0.05);
        g.gain.linearRampToValueAtTime(0.5, t0 + dur - 0.05);
        g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
        o.start(t0); o.stop(t0 + dur);
      };
      const n = ctx.currentTime;
      for (let i = 0; i < 3; i++) tocar(n + i * 0.55, 1200, 0.45);
    } catch { /* sem audio */ }
  }, []);

  // ── Theme tokens ──────────────────────────────────────────────────────
  const T = useMemo(() => tema === "dark" ? {
    bg: "#0a0a0a",
    card: "#131313",
    cardHover: "#181818",
    border: "#242424",
    borderSubtle: "#1c1c1c",
    text: "#fafaf9",
    muted: "#a8a29e",
    dim: "#57534e",
    accent: "#9fb3ce",
    accentDim: "#1e2a38",
    red: "#ef4444",
    yellow: "#f59e0b",
    green: "#22c55e",
    drawerBg: "rgba(10,10,10,0.98)",
    sidebarBg: "#0d0d0d",
    toolbarBg: "rgba(10,10,10,0.96)",
  } : {
    bg: "#f5f2ec",
    card: "#ffffff",
    cardHover: "#f0ede7",
    border: "#ddd9d0",
    borderSubtle: "#e8e4dc",
    text: "#1a1714",
    muted: "#6b6359",
    dim: "#9c9288",
    accent: "#2b5ea7",
    accentDim: "#dce8f5",
    red: "#c0202a",
    yellow: "#a05a00",
    green: "#1a7a3a",
    drawerBg: "rgba(252,250,246,0.98)",
    sidebarBg: "#ede9e1",
    toolbarBg: "rgba(241,238,230,0.97)",
  }, [tema]);

  const baseTokens = tema === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
  const mapTokens = satelite
    ? { ...baseTokens, tileUrl: SAT_TILE_URL, tileSubdomains: SAT_TILE_SUBDOMAINS }
    : baseTokens;

  function outlineBtn(active: boolean, color: string): React.CSSProperties {
    return {
      height: 28, padding: "0 10px", borderRadius: 6, cursor: "pointer",
      background: active ? `${color}18` : "transparent",
      border: `1px solid ${active ? color + "55" : T.border}`,
      color: active ? color : T.muted,
      fontSize: 10, fontWeight: 700, letterSpacing: ".05em",
      fontFamily: FONT_SANS,
      transition: "all .12s",
    };
  }

  function drawerOpBtn(active: boolean, color = T.accent): React.CSSProperties {
    return {
      height: 32, padding: "0 12px", borderRadius: 7, cursor: "pointer",
      background: active ? `${color}18` : "transparent",
      border: `1px solid ${active ? color + "44" : T.border}`,
      color: active ? color : T.muted,
      fontSize: 11, fontWeight: 600, letterSpacing: ".02em",
      transition: "all .12s",
      fontFamily: FONT_SANS,
    };
  }

  // ── Tick do motor via Supabase Realtime ──────────────────────────────
  // O motor grava dado novo 1x/min e emite um broadcast "tick" (sem payload)
  // ao terminar o ciclo. As buscas de alertas/mapa rodam QUANDO o tick chega
  // (dado fresquinho, ~1-2s depois do motor gravar) em vez de pollar as
  // cegas a cada 10-15s. Os setInterval abaixo viram só fallback lento pra
  // quando o websocket cair. Isso corta ~6x as consultas por tela e ainda
  // atualiza MAIS rapido que o poll antigo.
  const [motorTick, setMotorTick] = useState(0);
  useEffect(() => {
    const supabase = createSupabaseBrowser();
    const canal = supabase
      .channel("motor-tick")
      .on("broadcast", { event: "tick" }, () => setMotorTick(t => t + 1))
      .subscribe();
    return () => { supabase.removeChannel(canal); };
  }, []);

  // ── Polls (tick-driven; interval = fallback se o realtime cair) ──────
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/alertas?cliente=${encodeURIComponent(cliente)}`);
        if (!res.ok) return;
        const data: { alertas?: AlertaEnriquecido[] } = await res.json();
        const novos = data.alertas ?? [];
        const tiposQueNotificam = TIPOS_NOTIFICAM_POR_CLIENTE[cliente] ?? [];
        const ehNotificavel = (a: AlertaEnriquecido) => a.tipo === "panico" || tiposQueNotificam.includes(a.tipo);
        const idsAntes = new Set(alertasRef.current
          .filter(a => ehNotificavel(a) && a.status === "ativo").map(a => a.id));
        const novosParaNotificar = novos.filter(a => ehNotificavel(a) && a.status === "ativo" && !idsAntes.has(a.id));
        if (novosParaNotificar.length > 0) {
          setNovosIdsArr(arr => [...arr, ...novosParaNotificar.map(a => a.id)]);

          const panicos = novosParaNotificar.filter(a => a.tipo === "panico" && !panicoVistosRef.current.has(a.id));
          if (panicos.length > 0) {
            panicos.forEach(a => panicoVistosRef.current.add(a.id));
            setPanicoAlerta(panicos[0]);
            tocarPanico();
          }
        }
        alertasRef.current = novos;
        setAlertas(novos);
      } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 45_000);
    return () => clearInterval(t);
  }, [cliente, motorTick]);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/mapa?cliente=${encodeURIComponent(cliente)}`);
        if (!res.ok) return;
        const data: { veiculos?: VeiculoMapa[] } = await res.json();
        const veiculos = data.veiculos ?? [];
        setVeiculosMapa(veiculos);

        // Rastro vivo: anexa a posição nova do veículo focado ao rastro já
        // carregado (se moveu mais de 10m). Sem isso o rastro azul só se
        // atualizava na seleção, ficando parado enquanto o carro andava.
        const cvFoco = cvSelecionadoRef.current;
        if (cvFoco) {
          const v = veiculos.find(x => x.cv === cvFoco);
          if (v?.lat != null && v?.lng != null) {
            const lat = v.lat, lng = v.lng;
            setRastro(r => {
              if (r.length === 0) return r; // fetch inicial ainda em voo
              const [la, lo] = r[r.length - 1];
              const dLat = (lat - la) * 111_320;
              const dLng = (lng - lo) * 111_320 * Math.cos((la * Math.PI) / 180);
              const distM = Math.sqrt(dLat * dLat + dLng * dLng);
              return distM > 10 ? [...r, [lat, lng] as [number, number]] : r;
            });
          }
        }
      } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 45_000);
    return () => clearInterval(t);
  }, [cliente, motorTick]);

  // Grupos de frota Unitrac (gvc/gvn) — fetcha uma vez por cliente
  useEffect(() => {
    if (!cliente) return;
    fetch(`/api/grupos?cliente=${encodeURIComponent(cliente)}`)
      .then(r => r.ok ? r.json() : { grupos: [] })
      .then((d: { grupos?: typeof grupos }) => setGrupos(d.grupos ?? []))
      .catch(() => setGrupos([]));
  }, [cliente]);

  // Bases do cliente (perímetros geográficos) — fetcha uma vez por montagem
  useEffect(() => {
    fetch(`/api/bases?clienteId=${encodeURIComponent(clienteAtivoId)}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: GeoJsonCollection | null) => { if (d) setBases(d); })
      .catch(() => {});
  }, [clienteAtivoId]);

  // Camadas de risco: favelas (estática), roubo-carga (diária), tiroteios (30min)
  useEffect(() => {
    fetch("/api/favelas")
      .then(r => r.ok ? r.json() : null)
      .then((d: GeoJsonCollection | null) => { if (d) setFavelas(d); })
      .catch(() => {});
    fetch("/api/roubo-carga")
      .then(r => r.ok ? r.json() : null)
      .then((d: { geojson?: GeoJsonCollection } | null) => { if (d?.geojson) setRouboCarga(d.geojson); })
      .catch(() => {});
    const buscarTiroteios = () => {
      fetch("/api/tiroteios")
        .then(r => r.ok ? r.json() : null)
        .then((d: { tiroteios?: Tiroteio[] } | null) => { if (d?.tiroteios) setTiroteios(d.tiroteios); })
        .catch(() => {});
    };
    buscarTiroteios();
    const t = setInterval(buscarTiroteios, 30 * 60_000);
    return () => clearInterval(t);
  }, []);

  // Pontos de entrega globais — busca em segundo plano, lotes de 50
  useEffect(() => {
    if (veiculosBase.length === 0) return;
    const lotes: { cv: string }[][] = [];
    for (let i = 0; i < veiculosBase.length; i += 50)
      lotes.push(veiculosBase.slice(i, i + 50));
    const buscar = async () => {
      try {
        const results = await Promise.all(
          lotes.map(lote => {
            const qs = lote.map(v => `cv=${encodeURIComponent(v.cv)}`).join("&");
            return fetch(`/api/alvos?${qs}`).then(r => r.ok ? r.json() : { pontos: [] });
          })
        );
        const todos = results.flatMap((d: { pontos?: PontoEntrega[] }) => d.pontos ?? []);
        setAlvosGlobais(todos);
      } catch {/* silencioso */}
    };
    buscar();
    const t = setInterval(buscar, 5 * 60_000);
    return () => clearInterval(t);
  }, [veiculosBase]);

  // ── Vehicle data loader ──────────────────────────────────────────────
  const carregarVeiculo = useCallback(async (cv: string, h: number, temPosicaoAoVivo: boolean) => {
    // Cancela qualquer fetch anterior em voo (rastro do veículo antigo não pode vazar)
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    const { signal } = ctrl;

    setCarregando(true);
    try {
      // Cada fetch processa assim que a SUA resposta chega — antes, um
      // Promise.all fazia o rastro (rápido) esperar pelo mais lento dos 3
      // (às vezes stops/alvos demoravam bem mais), parecendo "rastro lento".
      const rastroP = fetch(`/api/rastro?cv=${encodeURIComponent(cv)}&horas=${h}`, { signal })
        .then(r => r.ok ? r.json() : null)
        .then((rd: { pontos?: { lat: number; lng: number }[] } | null) => {
          if (signal.aborted || !rd) return;
          const tuples = (rd.pontos ?? []).map(p => [p.lat, p.lng] as [number, number]);
          setRastro(tuples);
          // Voa para o último ponto do rastro só como FALLBACK, quando ainda
          // não há posição ao vivo (ex.: veículo buscado por placa, fora de
          // posicoes_atuais). Com posição ao vivo já conhecida, focar de novo
          // no fim do rastro sobrescrevia com um ponto possivelmente mais
          // antigo (rastro vem de outro endpoint, pode estar defasado).
          if (!temPosicaoAoVivo && tuples.length > 0) {
            const [lat, lng] = tuples[tuples.length - 1];
            gatilhoRef.current += 1;
            setFlyPara({ lat, lng, gatilho: gatilhoRef.current });
          }
        })
        .catch(() => {});

      const stopsP = fetch(`/api/stops?cv=${encodeURIComponent(cv)}&horas=${h}`, { signal })
        .then(r => r.ok ? r.json() : null)
        .then((sd: { paradas?: Parada[] } | null) => { if (!signal.aborted && sd) setParadas(sd.paradas ?? []); })
        .catch(() => {});

      const alvosP = fetch(`/api/alvos?cv=${encodeURIComponent(cv)}`, { signal })
        .then(r => r.ok ? r.json() : null)
        .then((ad: { pontos?: PontoEntrega[] } | null) => { if (!signal.aborted && ad) setAlvos(ad.pontos ?? []); })
        .catch(() => {});

      await Promise.allSettled([rastroP, stopsP, alvosP]);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
    if (!signal.aborted) setCarregando(false);
  }, []);

  // ── Vehicle selection ────────────────────────────────────────────────
  const selecionarVeiculo = useCallback((cv: string, coords?: { lat: number; lng: number }) => {
    // Abortar fetch IMEDIATAMENTE — antes do próximo render+useEffect. Sem isso, uma
    // resposta que chega entre o setState e o useEffect pode chamar setRastro(A_data)
    // depois do setRastro([]) daqui, deixando o rastro do veículo antigo visível.
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;

    setCvSelecionado(cv);
    // Incrementar reloadKey força o useEffect a disparar mesmo se cvSelecionado não mudou
    // (re-seleção do mesmo veículo). Garante que carregarVeiculo é chamado exatamente UMA vez.
    setReloadKey(k => k + 1);
    setSeguir(false);
    setMostrarRastro(true);
    setMostrarParadas(true);
    setRastro([]);
    setParadas([]);
    setAlvos([]);
    setCmdSirene("idle");
    setCmdBloqueio("idle");
    setMotorBloqueado(false);
    setFallbackUrl(null);
    const vm = veiculosMapa.find(v => v.cv === cv);
    const pos = (vm?.lat && vm?.lng) ? { lat: vm.lat, lng: vm.lng } : coords;
    if (pos) {
      gatilhoRef.current += 1;
      setFlyPara({ lat: pos.lat, lng: pos.lng, gatilho: gatilhoRef.current });
    }
  }, [veiculosMapa]);

  const limparSelecao = useCallback(() => {
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    setCvSelecionado(null);
    setAlertaAtivoId(null);
    setRastro([]);
    setParadas([]);
    setAlvos([]);
    setSeguir(false);
    setMostrarRastro(false);
    setMostrarParadas(false);
    setCarregando(false);
    setCmdSirene("idle");
    setCmdBloqueio("idle");
    setMotorBloqueado(false);
    setFallbackUrl(null);
    setBusca("");
  }, []);

  const handleVeiculoClick = useCallback((vm: VeiculoMapa) => {
    lastMarkerClickRef.current = Date.now();
    selecionarVeiculo(vm.cv);
  }, [selecionarVeiculo]);

  // Click no mapa vazio: apenas fecha popups, nao deseleciona veiculo
  const stableHandleMapaVazio = useCallback(() => {}, []);

  useEffect(() => {
    if (!cvSelecionado) return;
    const vm = veiculosMapa.find(v => v.cv === cvSelecionado);
    carregarVeiculo(cvSelecionado, horas, vm?.lat != null && vm?.lng != null);
    // reloadKey garante re-disparo ao re-selecionar o mesmo veículo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvSelecionado, horas, carregarVeiculo, reloadKey]);

  // ── Sirene / Bloqueio ────────────────────────────────────────────────
  const acionar = useCallback(async (tipo: "sirene" | "bloqueio") => {
    if (!cvSelecionado) return;
    const setter = tipo === "sirene" ? setCmdSirene : setCmdBloqueio;
    setter("loading");
    const resultado = await enviarComandoVeiculo(cvSelecionado, tipo);
    if (resultado.ok) {
      setter("ok");
      if (tipo === "bloqueio") setMotorBloqueado(v => !v);
      setTimeout(() => setter("idle"), 3000);
    } else {
      setter("fallback");
      if (resultado.portalUrl) setFallbackUrl(resultado.portalUrl);
    }
  }, [cvSelecionado]);

  // ── Alert actions ────────────────────────────────────────────────────
  // Resolver/marcar falso positivo só tirava o card da sidebar — a cor do
  // veiculo no mapa vem de posicoes_atuais.nivel, escrito só pelo motor
  // (a cada 1min), então o marcador continuava vermelho até o próximo ciclo.
  // Agora, se não sobrar OUTRO alerta ativo pro mesmo veículo, atualiza a
  // cor na hora (otimista); se a condição real ainda existir, o motor
  // recria o alerta no próximo ciclo e a cor volta — corretamente.
  const handleResolver = useCallback(async (id: string) => {
    setAlertas(a => {
      const alvo = a.find(x => x.id === id);
      const restante = a.filter(x => x.id !== id);
      if (alvo && !restante.some(x => x.cv === alvo.cv)) {
        setVeiculosMapa(vs => vs.map(v => v.cv === alvo.cv ? { ...v, nivel: null, tipo: null } : v));
      }
      return restante;
    });
    await resolverAlerta(id);
  }, []);

  const handleFalso = useCallback(async (id: string) => {
    setAlertas(a => {
      const alvo = a.find(x => x.id === id);
      const restante = a.filter(x => x.id !== id);
      if (alvo && !restante.some(x => x.cv === alvo.cv)) {
        setVeiculosMapa(vs => vs.map(v => v.cv === alvo.cv ? { ...v, nivel: null, tipo: null } : v));
      }
      return restante;
    });
    await marcarFalsoPositivo(id);
  }, []);

  // ── Map controls ─────────────────────────────────────────────────────
  const cmdZoom = useCallback((z: number) => {
    gatilhoRef.current += 1;
    setZoomCmd({ zoom: z, g: gatilhoRef.current });
  }, []);

  const centralizar = useCallback(() => {
    const vm = cvSelecionado ? veiculosMapa.find(v => v.cv === cvSelecionado) : null;
    if (vm?.lat && vm?.lng) {
      gatilhoRef.current += 1;
      setFlyPara({ lat: vm.lat, lng: vm.lng, gatilho: gatilhoRef.current });
    }
  }, [cvSelecionado, veiculosMapa]);

  // ── Derived ──────────────────────────────────────────────────────────
  const cvParaGrupo = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of grupos) for (const v of g.veiculos) m.set(v.cv, g.gvc);
    return m;
  }, [grupos]);

  const vmFiltrado: VeiculoMapa[] = useMemo(() => {
    let base = filtroComm ? veiculosMapa.filter(v => v.atraso_min <= filtroComm) : veiculosMapa;
    if (modoSelecionados && veiculosSelecionados.size > 0) {
      // Veículo selecionado sempre permanece visível, mesmo fora da lista escolhida
      base = base.filter(v => veiculosSelecionados.has(v.cv) || v.cv === cvSelecionado);
    }
    if (gruposOcultos.size > 0) {
      // Veículo selecionado sempre permanece visível no mapa, mesmo se o grupo dele estiver oculto
      base = base.filter(v => {
        const g = cvParaGrupo.get(v.cv);
        return g === undefined || !gruposOcultos.has(g) || v.cv === cvSelecionado;
      });
    }
    if (filtroTipos.size > 0) {
      const cvsComTipo = new Set(alertas.filter(a => filtroTipos.has(a.tipo)).map(a => a.cv));
      // Veículo selecionado sempre permanece visível no mapa, mesmo sem o tipo filtrado
      base = base.filter(v => cvsComTipo.has(v.cv) || v.cv === cvSelecionado);
    }
    if (!cvSelecionado || base.some(v => v.cv === cvSelecionado)) return base;
    // Veículo selecionado via alerta mas fora do feed ao vivo — injeta posição do alerta
    const al = alertas.find(a => a.cv === cvSelecionado && a.lat && a.lng);
    if (!al) return base;
    const sintetico: VeiculoMapa = {
      placa: al.placa, cv: al.cv,
      nivel: "vermelho",
      velocidade: al.velocidade ?? 0, ignicao: al.ignicao ?? false,
      atraso_min: al.atraso_min ?? 999, tipo: al.tipo,
      lat: al.lat, lng: al.lng, local: al.local, rumo: null,
    };
    return [...base, sintetico];
  }, [veiculosMapa, filtroComm, filtroTipos, gruposOcultos, cvParaGrupo, cvSelecionado, alertas, modoSelecionados, veiculosSelecionados]);

  const vmAtual = cvSelecionado ? veiculosMapa.find(v => v.cv === cvSelecionado) : null;

  const placaSelecionada = cvSelecionado
    ? (veiculosBase.find(v => v.cv === cvSelecionado)?.placa
      ?? veiculosMapa.find(v => v.cv === cvSelecionado)?.placa
      ?? cvSelecionado)
    : null;

  const alertasFiltrados = alertas.filter(a => {
    if (vista === "critico" && a.nivel !== "critico") return false;
    if (filtroTipos.size > 0 && !filtroTipos.has(a.tipo)) return false;
    if (modoSelecionados && veiculosSelecionados.size > 0 && !veiculosSelecionados.has(a.cv)) return false;
    if (gruposOcultos.size > 0) {
      const g = cvParaGrupo.get(a.cv);
      if (g !== undefined && gruposOcultos.has(g)) return false;
    }
    return true;
  });

  // Ordena só por prioridade — seleção não move o card, só brilha no lugar
  const alertasOrdenados = [...alertasFiltrados].sort((a, b) => prioAlerta(b) - prioAlerta(a));

  // Resolve os alertas VISÍVEIS na aba atual (Crítico/Tudo), não só
  // os críticos — antes travava em nivel==="critico" e nao fazia nada nas
  // outras abas.
  const handleResolverTodos = useCallback(() => {
    const alvos = alertasFiltrados;
    if (alvos.length === 0) return;
    startResolver(async () => {
      const ids = new Set(alvos.map(a => a.id));
      const cvsResolvidos = new Set(alvos.map(a => a.cv));
      setAlertas(a => {
        const restante = a.filter(x => !ids.has(x.id));
        const cvsAindaComAlerta = new Set(restante.map(x => x.cv));
        setVeiculosMapa(vs => vs.map(v =>
          cvsResolvidos.has(v.cv) && !cvsAindaComAlerta.has(v.cv) ? { ...v, nivel: null, tipo: null } : v
        ));
        return restante;
      });
      await resolverVarios(alvos.map(a => a.id));
      setConfirmarResolver(false);
    });
  }, [alertasFiltrados]);

  // Desvios de rota — faixa dedicada no topo do mapa, sempre visivel independente
  // dos filtros da sidebar (vista/tipo). Ordenado do mais recente pro mais antigo.
  const desviosAtivos = alertas
    .filter(a => a.tipo === "desvio")
    .filter(a => {
      if (modoSelecionados && veiculosSelecionados.size > 0 && !veiculosSelecionados.has(a.cv)) return false;
      if (gruposOcultos.size === 0) return true;
      const g = cvParaGrupo.get(a.cv);
      return g === undefined || !gruposOcultos.has(g);
    })
    .sort((a, b) => new Date(b.desde).getTime() - new Date(a.desde).getTime());

  // Ponto de início do desvio ativo do veículo selecionado (para o marcador
  // + linha no mapa). origemLat/origemLng vêm do próprio alerta (Task 4),
  // não da posição atual do veículo.
  const desvioSelecionado = useMemo(() => {
    if (!cvSelecionado) return null;
    const a = desviosAtivos.find(
      (x) => x.cv === cvSelecionado && x.origemLat != null && x.origemLng != null
    );
    return a ? { lat: a.origemLat as number, lng: a.origemLng as number } : null;
  }, [desviosAtivos, cvSelecionado]);

  const veiculosBusca = busca.length >= 2
    ? veiculosBase.filter(v => v.placa.toLowerCase().includes(busca.toLowerCase())).slice(0, 8)
    : [];

  const nCriticos = alertas.filter(a => a.nivel === "critico").length;

  // Fallback: se o fetch individual retornou vazio mas alvosGlobais tem dados da placa, usa o global
  const alvosEfetivos = useMemo(() => {
    if (alvos.length > 0) return alvos;
    if (!cvSelecionado || !placaSelecionada) return [];
    const placa = veiculosBase.find(v => v.cv === cvSelecionado)?.placa ?? vmAtual?.placa;
    if (!placa) return [];
    return alvosGlobais.filter(a => a.placa === placa);
  }, [alvos, cvSelecionado, placaSelecionada, veiculosBase, vmAtual, alvosGlobais]);

  const alvosFeitos = alvosEfetivos.filter(p => p.feito).length;
  const alvosTotal = alvosEfetivos.length;

  // Pontos de entrega exibidos no mapa (camada de fundo, todas as placas) —
  // quando "ver apenas selecionados" está ativo, só mostra os pontos das
  // placas escolhidas. alvosGlobais (não filtrado) continua servindo o
  // progressoPorPlaca e o fallback de alvosEfetivos acima.
  const alvosGlobaisMapa = useMemo(() => {
    if (!modoSelecionados || veiculosSelecionados.size === 0) return alvosGlobais;
    // PontoEntrega não tem cv, só placa — traduz o Set de cv's selecionados pras placas correspondentes
    const placas = new Set(veiculosBase.filter(v => veiculosSelecionados.has(v.cv)).map(v => v.placa));
    return alvosGlobais.filter(a => a.placa && placas.has(a.placa));
  }, [alvosGlobais, modoSelecionados, veiculosSelecionados, veiculosBase]);

  // Progresso de entregas por placa (para exibir nos cards de alerta)
  const progressoPorPlaca = useMemo(() => {
    const m = new Map<string, { feitos: number; total: number }>();
    for (const a of alvosGlobais) {
      if (!a.placa) continue;
      const e = m.get(a.placa) ?? { feitos: 0, total: 0 };
      e.total++;
      if (a.feito) e.feitos++;
      m.set(a.placa, e);
    }
    return m;
  }, [alvosGlobais]);

  // Cor de status do veiculo selecionado
  const placaColor = vmAtual
    ? (vmAtual.ignicao && vmAtual.velocidade > 0 ? T.green : vmAtual.ignicao ? T.accent : T.muted)
    : T.text;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: T.bg, color: T.text, overflow: "hidden",
      fontFamily: FONT_SANS,
    }}>

      {/* ================================================================
          TOOLBAR — 3 colunas: [clients] [controls centrados] [ações]
      ================================================================ */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 0,
        height: 46,
        borderBottom: `1px solid ${T.border}`,
        background: T.toolbarBg,
        flexShrink: 0,
        position: "relative",
        zIndex: 50,
        paddingLeft: 8,
        paddingRight: 8,
      }}>

        {/* ── Coluna ESQUERDA: cliente switchers ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingRight: 8 }}>
          {clientes.map(c => {
            const active = c.cod === cliente;
            return (
              <Link key={c.cod} href={`/central-v2?cliente=${encodeURIComponent(c.cod)}`}
                style={{
                  padding: "4px 12px", borderRadius: 20,
                  fontSize: 11, fontWeight: 700, letterSpacing: ".06em",
                  background: active ? `${T.accent}18` : "transparent",
                  color: active ? T.accent : T.muted,
                  border: `1px solid ${active ? T.accent + "44" : "transparent"}`,
                  textDecoration: "none", whiteSpace: "nowrap",
                  transition: "all .12s",
                  fontFamily: FONT_SANS,
                }}>
                {c.nome.split(" ")[0].toUpperCase()}
              </Link>
            );
          })}
        </div>

        {/* ── Coluna CENTRAL: zoom + busca + COMM — tudo centralizado ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 5, minWidth: 0,
        }}>
          {ZOOM_LABELS.map(([label, z]) => (
            <button key={label} onClick={() => cmdZoom(z)}
              style={outlineBtn(zoomAtual === z, T.accent)}>
              {label}
            </button>
          ))}
          <button onClick={() => setGatilhoFrota(g => g + 1)}
            style={outlineBtn(false, T.accent)}>
            VEÍCULOS
          </button>

          <div style={{ width: 1, height: 20, background: T.border, margin: "0 2px", flexShrink: 0 }} />

          {/* Busca placa */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <input
              value={busca}
              onChange={e => { setBusca(e.target.value); setComboAberto(true); }}
              onFocus={() => setComboAberto(true)}
              onBlur={() => setTimeout(() => setComboAberto(false), 200)}
              placeholder="Buscar placa..."
              style={{
                background: cvSelecionado ? `${T.accent}12` : tema === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
                border: `1px solid ${cvSelecionado ? T.accent + "66" : T.border}`,
                borderRadius: 6, color: cvSelecionado ? T.accent : T.text, padding: "0 10px", height: 28,
                width: 130, fontSize: 12, fontFamily: FONT_MONO, outline: "none",
                letterSpacing: ".04em", fontWeight: cvSelecionado ? 700 : 400,
              }}
            />
            {comboAberto && veiculosBusca.length > 0 && (
              <div style={{
                position: "absolute", top: 33, left: "50%", transform: "translateX(-50%)",
                width: 210,
                background: T.card, border: `1px solid ${T.border}`, borderRadius: 8,
                zIndex: Z.combo, boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              }}>
                {veiculosBusca.map(v => {
                  const al = alertas.find(a => a.placa === v.placa);
                  return (
                    <button key={v.cv}
                      onMouseDown={() => { selecionarVeiculo(v.cv); setBusca(v.placa); setComboAberto(false); }}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        width: "100%", padding: "7px 12px", background: "transparent", border: "none",
                        borderBottom: `1px solid ${T.border}`, color: T.text,
                        fontSize: 12, fontFamily: FONT_MONO, cursor: "pointer",
                      }}>
                      <span style={{ fontWeight: 700 }}>{v.placa}</span>
                      {al && (
                        <span style={{ fontSize: 10, color: al.nivel === "critico" ? T.red : T.yellow }}>
                          {nomeT(al.tipo)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ width: 1, height: 20, background: T.border, margin: "0 2px", flexShrink: 0 }} />

          <span style={{ fontSize: 10, color: T.dim, letterSpacing: ".07em", whiteSpace: "nowrap", flexShrink: 0 }}>
            COMM
          </span>
          {[10, 30, 60].map(m => (
            <button key={m} onClick={() => setFiltroComm(filtroComm === m ? null : m)}
              style={outlineBtn(filtroComm === m, T.accent)}>
              {m}min
            </button>
          ))}
        </div>

        {/* ── Coluna DIREITA: SAT + settings + apito ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 8 }}>
          <button onClick={() => setSateliteComPersistencia(!satelite)} title={satelite ? "Mapa padrao" : "Vista satelite"}
            style={outlineBtn(satelite, T.accent)}>
            SAT
          </button>
          <button onClick={() => setCamTrafegoComPersistencia(!camTrafego)} title={camTrafego ? "Ocultar transito" : "Mostrar transito ao vivo"}
            style={outlineBtn(camTrafego, T.accent)}>
            TRÂNSITO
          </button>

          {/* Settings gear */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setSettingsAberto(v => !v)}
              title="Configuracoes"
              style={{
                ...BASE_BTN, width: 32, height: 32, borderRadius: "50%",
                color: settingsAberto ? T.accent : T.muted,
                border: `1px solid ${settingsAberto ? T.accent + "55" : T.border}`,
                background: settingsAberto ? `${T.accent}10` : "transparent",
              }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>

            {settingsAberto && (
              <div style={{
                position: "absolute", top: 38, right: 0,
                width: 196, zIndex: Z.settings,
                background: T.card, border: `1px solid ${T.border}`,
                borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                overflow: "hidden",
              }}
                onMouseLeave={() => setSettingsAberto(false)}>
                <div style={{ padding: "10px 14px 6px", fontSize: 9, color: T.dim, letterSpacing: ".1em", fontWeight: 700 }}>
                  CONFIGURACOES
                </div>
                <div style={{ padding: "4px 8px 8px" }}>
                  <div style={{ fontSize: 10, color: T.muted, padding: "2px 6px 6px", fontWeight: 600, letterSpacing: ".05em" }}>
                    TEMA
                  </div>
                  {(["dark", "light"] as const).map(t => (
                    <button key={t} onClick={() => { setTemaComPersistencia(t); setSettingsAberto(false); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        width: "100%", padding: "8px 10px", borderRadius: 7,
                        background: tema === t ? `${T.accent}12` : "transparent",
                        border: `1px solid ${tema === t ? T.accent + "44" : "transparent"}`,
                        color: tema === t ? T.accent : T.text,
                        fontSize: 12, cursor: "pointer", fontWeight: tema === t ? 700 : 400,
                        marginBottom: 2, fontFamily: FONT_SANS,
                      }}>
                      {t === "dark" ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/>
                          <line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/>
                          <line x1="21" y1="12" x2="23" y2="12"/>
                        </svg>
                      )}
                      {t === "dark" ? "Modo escuro" : "Modo claro"}
                      {tema === t && <span style={{ marginLeft: "auto", fontSize: 9, color: T.accent }}>●</span>}
                    </button>
                  ))}
                </div>

                {/* Camadas de risco */}
                <div style={{ borderTop: `1px solid ${T.border}`, padding: "6px 8px 8px" }}>
                  <div style={{ fontSize: 10, color: T.muted, padding: "4px 6px 4px", fontWeight: 600, letterSpacing: ".05em" }}>
                    CAMADAS
                  </div>
                  {([
                    { label: "Favelas", val: camFavelas, set: setCamFavelasComPersistencia, cor: "#ff2d2d" },
                    { label: "Tiroteios (24h)", val: camTiroteios, set: setCamTiroteiosComPersistencia, cor: "#f97316" },
                    { label: "Roubo de carga", val: camRouboCarga, set: setCamRouboCargaComPersistencia, cor: "#fbbf24" },
                  ] as { label: string; val: boolean; set: (v: boolean) => void; cor: string }[]).map(({ label, val, set, cor }) => (
                    <button key={label} onClick={() => set(!val)}
                      style={{
                        display: "flex", alignItems: "center", gap: 9,
                        width: "100%", padding: "7px 10px", borderRadius: 7,
                        background: val ? `${cor}12` : "transparent",
                        border: `1px solid ${val ? cor + "33" : "transparent"}`,
                        color: val ? T.text : T.dim,
                        fontSize: 12, cursor: "pointer",
                        marginBottom: 2, fontFamily: FONT_SANS,
                        transition: "all .1s",
                      }}>
                      <div style={{
                        width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                        background: val ? cor : "transparent",
                        border: `1.5px solid ${val ? cor : T.dim}`,
                        transition: "all .1s",
                      }} />
                      {label}
                    </button>
                  ))}
                </div>

                {/* Ver apenas veículos selecionados — abre tela dedicada de escolha */}
                <div style={{ borderTop: `1px solid ${T.border}`, padding: "6px 8px 8px" }}>
                  <div style={{ fontSize: 10, color: T.muted, padding: "4px 6px 4px", fontWeight: 600, letterSpacing: ".05em" }}>
                    VEÍCULOS
                  </div>
                  <button onClick={() => { setSeletorAberto(true); setSettingsAberto(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 9,
                      width: "100%", padding: "7px 10px", borderRadius: 7,
                      background: modoSelecionados ? `${T.accent}12` : "transparent",
                      border: `1px solid ${modoSelecionados ? T.accent + "44" : "transparent"}`,
                      color: modoSelecionados ? T.accent : T.text,
                      fontSize: 12, cursor: "pointer", fontFamily: FONT_SANS,
                      fontWeight: modoSelecionados ? 700 : 400,
                    }}>
                    <div style={{
                      width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                      background: modoSelecionados ? T.accent : "transparent",
                      border: `1.5px solid ${modoSelecionados ? T.accent : T.dim}`,
                    }} />
                    Ver apenas selecionados
                    {modoSelecionados && veiculosSelecionados.size > 0 && (
                      <span style={{ marginLeft: "auto", fontSize: 9, fontFamily: FONT_MONO, color: T.accent }}>
                        {veiculosSelecionados.size}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          <AlertaSonoro idsParaApitar={novosIdsArr} />
        </div>
      </div>

      {/* ================================================================
          MAIN BODY
      ================================================================ */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ============================================================
            LEFT SIDEBAR
        ============================================================ */}
        <div style={{
          width: "clamp(220px, 18vw, 280px)",
          flexShrink: 0, display: "flex", flexDirection: "column",
          borderRight: `1px solid ${T.border}`,
          background: T.sidebarBg,
          overflow: "hidden",
        }}>
          {/* Count strip */}
          <div style={{
            display: "flex", alignItems: "center", gap: 0,
            borderBottom: `1px solid ${T.border}`, flexShrink: 0,
          }}>
            <div style={{ flex: 1, padding: "9px 12px", borderRight: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: nCriticos > 0 ? T.red : T.muted, lineHeight: 1, fontFamily: FONT_MONO }}>
                {nCriticos}
              </div>
              <div style={{ fontSize: 9, color: T.dim, letterSpacing: ".08em", marginTop: 2 }}>CRÍTICO</div>
            </div>
            <div style={{ flex: 1, padding: "9px 12px" }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: T.muted, lineHeight: 1, fontFamily: FONT_MONO }}>
                {veiculosMapa.length}
              </div>
              <div style={{ fontSize: 9, color: T.dim, letterSpacing: ".08em", marginTop: 2 }}>VEÍC.</div>
            </div>
          </div>

          {/* Filtro ativo de "ver apenas selecionados" — sempre visível pra não confundir o operador.
              Guarda size>0 pra nunca mostrar "FILTRO: 0 VEÍC." (estado fantasma). */}
          {modoSelecionados && veiculosSelecionados.size > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
              borderBottom: `1px solid ${T.border}`, flexShrink: 0,
              background: `${T.accent}0c`,
            }}>
              <span style={{ fontSize: 10, color: T.accent, fontWeight: 700, letterSpacing: ".05em" }}>
                FILTRO: {veiculosSelecionados.size} VEÍC.
              </span>
              <button onClick={() => setSeletorAberto(true)} style={{ ...tinyBtn(T.accent), marginLeft: "auto" }}>Editar</button>
              <button onClick={() => setModoSelecionadosSessao(false)} style={tinyBtn(T.dim)}>Mostrar todos</button>
            </div>
          )}

          {/* Filter tabs */}
          <div style={{ display: "flex", padding: "5px 6px", gap: 3, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            {(["tudo", "critico"] as const).map(v => {
              const color = v === "tudo" ? T.accent : T.red;
              return (
                <button key={v} onClick={() => setVistaComPersistencia(v)} style={{
                  flex: 1, height: 27, borderRadius: 6, border: "none", cursor: "pointer",
                  background: vista === v ? `${color}18` : "transparent",
                  color: vista === v ? color : T.muted,
                  fontSize: 10, fontWeight: 700, letterSpacing: ".06em",
                  fontFamily: FONT_SANS, transition: "all .12s",
                }}>
                  {v === "tudo" ? "TUDO" : "CRÍTICO"}
                </button>
              );
            })}
          </div>

          {/* Filtros de grupo de frota + tipo — colapsados por padrão, um único
              cabeçalho compacto em vez de duas faixas de pílulas sempre abertas */}
          {(() => {
            const tiposDisponiveis = [...new Set(alertas.filter(a => {
              if (vista === "critico" && a.nivel !== "critico") return false;
              return true;
            }).map(a => a.tipo))].sort((a, b) => (TIPO_PRIORITY[b] ?? 0) - (TIPO_PRIORITY[a] ?? 0));
            const temGrupos = grupos.length > 1;
            const temTipos = tiposDisponiveis.length > 0;
            if (!temGrupos && !temTipos) return null;
            const filtrosAtivos = gruposOcultos.size + filtroTipos.size;
            return (
              <div style={{ borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
                <button onClick={() => setFiltrosAbertos(v => !v)} style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%",
                  padding: "6px 8px", background: "transparent", border: "none",
                  cursor: "pointer", fontFamily: FONT_SANS,
                }}>
                  <span style={{ fontSize: 10, color: T.muted, fontWeight: 700, letterSpacing: ".06em" }}>
                    FILTROS
                  </span>
                  {filtrosAtivos > 0 && (
                    <span style={{
                      fontSize: 9, fontFamily: FONT_MONO, color: T.accent,
                      background: `${T.accent}18`, borderRadius: 4, padding: "1px 5px",
                    }}>
                      {filtrosAtivos}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: 9, color: T.dim }}>
                    {filtrosAbertos ? "▾" : "▸"}
                  </span>
                </button>

                {filtrosAbertos && (
                  <div style={{ paddingBottom: 4 }}>
                    {/* Chips de grupo de frota (gvc/gvn) — clique oculta/mostra o grupo */}
                    {temGrupos && (
                      <div style={{ display: "flex", gap: 3, padding: "2px 6px 5px", flexWrap: "wrap" }}>
                        {grupos.map(g => {
                          const oculto = gruposOcultos.has(g.gvc);
                          return (
                            <button key={g.gvc} onClick={() => toggleGrupoOculto(g.gvc)} title={oculto ? "Grupo oculto — clique pra mostrar" : "Clique pra ocultar este grupo"} style={{
                              height: 22, padding: "0 7px", borderRadius: 5,
                              border: `1px solid ${oculto ? T.border : T.accent}`,
                              background: oculto ? "transparent" : `${T.accent}18`,
                              color: oculto ? T.dim : T.accent,
                              fontSize: 10, fontWeight: oculto ? 500 : 700,
                              cursor: "pointer", fontFamily: FONT_SANS, whiteSpace: "nowrap",
                              display: "flex", alignItems: "center", gap: 4,
                              textDecoration: oculto ? "line-through" : "none",
                            }}>
                              <span>{g.gvn.trim()}</span>
                              <span style={{ fontFamily: FONT_MONO, fontSize: 9 }}>{g.veiculos.length}</span>
                            </button>
                          );
                        })}
                        {gruposOcultos.size > 0 && (
                          <button onClick={() => { setGruposOcultos(new Set()); localStorage.removeItem("transmonseg-grupos-ocultos"); }} style={{
                            height: 22, padding: "0 8px", borderRadius: 5,
                            border: `1px solid ${T.border}`, background: "transparent",
                            color: T.dim, fontSize: 11, cursor: "pointer",
                          }}>✕</button>
                        )}
                      </div>
                    )}

                    {/* Chips de tipo — multi-select, filtra sidebar + mapa */}
                    {temTipos && (
                      <div style={{ display: "flex", gap: 3, padding: "2px 6px 5px", flexWrap: "wrap" }}>
                        {tiposDisponiveis.map(tipo => {
                          const ativo = filtroTipos.has(tipo);
                          const count = alertas.filter(a => a.tipo === tipo).length;
                          return (
                            <button key={tipo} onClick={() => toggleFiltroTipo(tipo)} style={{
                              height: 22, padding: "0 7px", borderRadius: 5,
                              border: `1px solid ${ativo ? T.accent : T.border}`,
                              background: ativo ? `${T.accent}22` : "transparent",
                              color: ativo ? T.accent : T.muted,
                              fontSize: 10, fontWeight: ativo ? 700 : 500,
                              cursor: "pointer", fontFamily: FONT_SANS, whiteSpace: "nowrap",
                              display: "flex", alignItems: "center", gap: 4,
                            }}>
                              <span>{NOME_TIPO[tipo] ?? tipo}</span>
                              <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: ativo ? T.accent : T.dim }}>{count}</span>
                            </button>
                          );
                        })}
                        {filtroTipos.size > 0 && (
                          <button onClick={() => { setFiltroTipos(new Set()); localStorage.removeItem("transmonseg-filtro-tipos"); }} style={{
                            height: 22, padding: "0 8px", borderRadius: 5,
                            border: `1px solid ${T.border}`, background: "transparent",
                            color: T.dim, fontSize: 11, cursor: "pointer",
                          }}>✕</button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Resolver todos — os VISÍVEIS na aba atual (Crítico/Tudo) */}
          {alertasFiltrados.length > 0 && (
            <div style={{ padding: "5px 8px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
              {confirmarResolver ? (
                <div style={{ display: "flex", gap: 5 }}>
                  <button onClick={handleResolverTodos} disabled={resolvendoTodos} style={{
                    flex: 1, height: 26, borderRadius: 6,
                    background: `${T.red}18`, border: `1px solid ${T.red}44`, color: T.red,
                    fontSize: 10, cursor: "pointer", fontWeight: 700, fontFamily: FONT_SANS,
                  }}>
                    {resolvendoTodos ? "..." : "CONFIRMAR"}
                  </button>
                  <button onClick={() => setConfirmarResolver(false)} style={{
                    flex: 1, height: 26, borderRadius: 6,
                    background: "transparent", border: `1px solid ${T.border}`,
                    color: T.muted, fontSize: 10, cursor: "pointer", fontFamily: FONT_SANS,
                  }}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmarResolver(true)} style={{
                  width: "100%", height: 26, borderRadius: 6,
                  background: "transparent", border: `1px solid ${T.border}`,
                  color: T.muted, fontSize: 10, cursor: "pointer", fontFamily: FONT_SANS,
                }}>
                  {vista === "critico" ? `Resolver críticos (${alertasFiltrados.length})`
                    : `Resolver todos (${alertasFiltrados.length})`}
                </button>
              )}
            </div>
          )}

          {/* Alert list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px 8px" }}>
            {alertasFiltrados.length === 0 && (
              <div style={{ padding: "28px 16px", textAlign: "center", color: T.dim, fontSize: 12 }}>
                <div style={{ marginBottom: 6, opacity: 0.6 }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ display: "inline-block" }}>
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                Nenhum alerta ativo
              </div>
            )}
            {alertasOrdenados.map(a => {
              const cor = a.nivel === "critico" ? T.red : T.yellow;
              const ativo = alertaAtivoId === a.id;
              const doCarro = cvSelecionado === a.cv;
              return (
                <div key={a.id}
                  onClick={() => {
                    setAlertaAtivoId(a.id);
                    selecionarVeiculo(a.cv, a.lat && a.lng ? { lat: a.lat, lng: a.lng } : undefined);
                  }}
                  className="v2-alert-card"
                  style={{
                    marginBottom: 4, borderRadius: 8,
                    borderTop: `1px solid ${ativo ? cor + "99" : doCarro ? cor + "55" : cor + "22"}`,
                    borderRight: `1px solid ${ativo ? cor + "99" : doCarro ? cor + "55" : cor + "22"}`,
                    borderBottom: `1px solid ${ativo ? cor + "99" : doCarro ? cor + "55" : cor + "22"}`,
                    borderLeft: `3px solid ${cor}`,
                    background: ativo
                      ? (tema === "dark" ? `${cor}22` : `${cor}14`)
                      : doCarro
                        ? (tema === "dark" ? `${cor}12` : `${cor}08`)
                        : (tema === "dark" ? `${cor}07` : `${cor}05`),
                    cursor: "pointer",
                    boxShadow: ativo ? `0 0 0 1px ${cor}44` : "none",
                  }}>
                  <div style={{ padding: "8px 10px 7px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontFamily: FONT_MONO, fontWeight: 900, fontSize: 13, letterSpacing: ".04em" }}>
                        {a.placa}
                      </span>
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                        background: `${cor}18`, color: cor, letterSpacing: ".04em",
                      }}>
                        {nomeT(a.tipo)}
                      </span>
                      <span suppressHydrationWarning style={{ fontSize: 10, color: T.dim, marginLeft: "auto", fontFamily: FONT_MONO }}>
                        {tempoAtras(a.desde)}
                      </span>
                    </div>
                    {a.motivo && (
                      <p style={{
                        margin: "0 0 2px", fontSize: 11, color: T.muted, lineHeight: 1.35,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {a.motivo}
                      </p>
                    )}
                    {a.local && (
                      <p style={{
                        margin: "0 0 6px", fontSize: 10, color: T.dim, lineHeight: 1.3,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {a.local}
                      </p>
                    )}
                    {(() => {
                      const prog = progressoPorPlaca.get(a.placa);
                      if (!prog || prog.total === 0) return null;
                      return (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                          <span style={{ fontSize: 9, color: T.dim, fontFamily: FONT_MONO, flexShrink: 0 }}>
                            {prog.feitos}/{prog.total} entr.
                          </span>
                          <div style={{ flex: 1, height: 2, background: `${T.border}`, borderRadius: 1, overflow: "hidden" }}>
                            <div style={{
                              height: "100%",
                              width: `${prog.total > 0 ? Math.round((prog.feitos / prog.total) * 100) : 0}%`,
                              background: prog.feitos === prog.total ? T.green : T.accent,
                              borderRadius: 1, transition: "width .3s",
                            }} />
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onMouseDown={e => { e.stopPropagation(); selecionarVeiculo(a.cv, a.lat && a.lng ? { lat: a.lat, lng: a.lng } : undefined); }}
                        className="v2-btn-tiny" style={tinyBtn(T.accent)}>
                        Focar
                      </button>
                      <button onMouseDown={e => { e.stopPropagation(); handleResolver(a.id); }}
                        className="v2-btn-tiny" style={tinyBtn(T.green)}>
                        Resolver
                      </button>
                      <button onMouseDown={e => { e.stopPropagation(); handleFalso(a.id); }}
                        className="v2-btn-tiny" style={tinyBtn(T.muted)}>
                        Falso
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ============================================================
            MAP AREA
        ============================================================ */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden", minWidth: 0 }}>

          <MapaLeafletV2
            veiculosMapa={vmFiltrado}
            cvSelecionado={cvSelecionado}
            mostrarRastro={mostrarRastro}
            mostrarParadas={mostrarParadas}
            rastro={rastro}
            paradas={paradas}
            alvos={alvosEfetivos}
            alvosGlobais={alvosGlobaisMapa}
            bases={bases}
            favelas={camFavelas ? favelas : null}
            tiroteios={camTiroteios ? tiroteios : []}
            rouboCarga={camRouboCarga ? rouboCarga : null}
            desvioInicio={desvioSelecionado}
            seguir={seguir}
            gatilhoFrota={gatilhoFrota}
            flyPara={flyPara}
            zoomCmd={zoomCmd}
            onVeiculoClick={handleVeiculoClick}
            onMapaVazioClick={stableHandleMapaVazio}
            mapTokens={mapTokens}
            tema={tema}
            satelite={satelite}
            trafego={camTrafego}
            onZoomChange={setZoomAtual}
          />

          {/* Faixa de desvios de rota — topo central, clicavel, sempre visivel */}
          {desviosAtivos.length > 0 && (
            <div style={{
              position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)",
              zIndex: Z.toasts, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6,
              maxWidth: "calc(100% - 24px)", maxHeight: 150, overflowY: "auto", padding: 2,
            }}>
              {desviosAtivos.map(a => {
                const cor = a.nivel === "critico" ? T.red : T.yellow;
                const ativo = alertaAtivoId === a.id;
                return (
                  <button key={a.id}
                    onClick={() => {
                      setAlertaAtivoId(a.id);
                      selecionarVeiculo(a.cv, a.lat && a.lng ? { lat: a.lat, lng: a.lng } : undefined);
                    }}
                    style={{
                      ...BASE_BTN, flexShrink: 0, gap: 8,
                      padding: "7px 13px", borderRadius: 8,
                      background: ativo
                        ? (tema === "dark" ? `${cor}22` : `${cor}14`)
                        : (tema === "dark" ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.92)"),
                      backdropFilter: "blur(6px)",
                      border: `1px solid ${cor}55`, borderLeft: `3px solid ${cor}`,
                      boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
                    }}
                    title={`Desvio de rota — ${a.placa} — clique pra focar`}
                  >
                    <span className="animate-pulse-live" style={{ width: 7, height: 7, borderRadius: "50%", background: cor, flexShrink: 0 }} />
                    <span style={{ fontFamily: FONT_MONO, fontWeight: 900, fontSize: 13, color: T.text, letterSpacing: ".04em" }}>
                      {a.placa}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: cor, letterSpacing: ".03em" }}>
                      DESVIO DE ROTA
                    </span>
                    <span suppressHydrationWarning style={{ fontSize: 10, color: T.dim, fontFamily: FONT_MONO }}>
                      {tempoAtras(a.desde)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Vehicle count badge */}
          <div style={{
            position: "absolute",
            bottom: cvSelecionado ? 224 : 12,
            left: 12, zIndex: Z.badge,
            transition: "bottom .25s cubic-bezier(.4,0,.2,1)",
            background: tema === "dark" ? "rgba(0,0,0,0.68)" : "rgba(255,255,255,0.88)",
            backdropFilter: "blur(6px)",
            border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "5px 11px", fontSize: 11, color: T.muted, pointerEvents: "none",
            fontFamily: FONT_MONO, letterSpacing: ".03em",
          }}>
            <span style={{ fontWeight: 700 }}>{vmFiltrado.length}</span>
            <span style={{ color: T.dim }}> veículos</span>
            {filtroComm != null && <span style={{ color: T.accent }}> &lt;{filtroComm}min</span>}
          </div>

          {/* Legenda dos símbolos do mapa — recolhida por padrão */}
          <div style={{
            position: "absolute",
            bottom: cvSelecionado ? 224 : 12,
            right: 12, zIndex: Z.badge,
            transition: "bottom .25s cubic-bezier(.4,0,.2,1)",
            display: "flex", flexDirection: "column-reverse", alignItems: "flex-end", gap: 6,
          }}>
            <button onClick={toggleLegenda} style={{
              ...BASE_BTN,
              background: tema === "dark" ? "rgba(0,0,0,0.68)" : "rgba(255,255,255,0.88)",
              backdropFilter: "blur(6px)",
              border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "5px 11px", fontSize: 11, color: T.muted,
              letterSpacing: ".03em", gap: 5,
            }}>
              <span style={{ fontSize: 12 }}>{legendaAberta ? "▾" : "▴"}</span>
              Legenda
            </button>

            {legendaAberta && (
              <div style={{
                background: tema === "dark" ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.94)",
                backdropFilter: "blur(6px)",
                border: `1px solid ${T.border}`, borderRadius: 10,
                padding: "10px 13px", minWidth: 190,
                fontFamily: FONT_SANS,
              }}>
                <div style={{ fontSize: 9, color: T.dim, letterSpacing: ".08em", fontWeight: 700, marginBottom: 6 }}>
                  VEÍCULO
                </div>
                {[
                  { cor: T.red, label: "Alerta crítico" },
                  { cor: T.green, label: "Em movimento" },
                  { cor: mapTokens.parado, label: "Parado, motor ligado" },
                  { cor: T.dim, label: "Motor desligado" },
                ].map(({ cor, label }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", background: cor, flexShrink: 0, border: "1px solid rgba(255,255,255,0.25)" }} />
                    <span style={{ fontSize: 11, color: T.text }}>{label}</span>
                  </div>
                ))}

                <div style={{ fontSize: 9, color: T.dim, letterSpacing: ".08em", fontWeight: 700, margin: "8px 0 6px", borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                  PONTO DE ENTREGA
                </div>
                {[
                  { cor: COR_PENDENTE, label: "Pendente" },
                  { cor: COR_ENTREGUE, label: "Entregue" },
                  { cor: COR_OUTRO, label: "Esteve no local" },
                ].map(({ cor, label }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", background: cor, flexShrink: 0, border: "1px solid rgba(255,255,255,0.25)" }} />
                    <span style={{ fontSize: 11, color: T.text }}>{label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>


          {/* ================================================================
              BOTTOM DRAWER
          ================================================================ */}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0, zIndex: Z.drawer,
            transform: cvSelecionado ? "translateY(0)" : "translateY(108%)",
            transition: "transform .22s cubic-bezier(.4,0,.2,1)",
            background: T.drawerBg, backdropFilter: "blur(16px)",
            borderTop: `2px solid ${T.accent}22`,
            boxShadow: tema === "dark" ? "0 -10px 40px rgba(0,0,0,0.65)" : "0 -8px 32px rgba(0,0,0,0.10)",
          }}>

            {/* Header */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10, padding: "9px 16px 8px",
              borderBottom: `1px solid ${T.border}`,
            }}>
              {/* Placa + status */}
              <span style={{
                fontFamily: FONT_MONO, fontWeight: 900,
                fontSize: "clamp(15px, 1.4vw, 20px)",
                letterSpacing: ".07em", color: placaColor,
              }}>
                {placaSelecionada ?? "—"}
              </span>

              {vmAtual && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                  background: vmAtual.ignicao ? `${T.green}15` : `${T.border}66`,
                  border: `1px solid ${vmAtual.ignicao ? T.green + "44" : T.border}`,
                  color: vmAtual.ignicao ? T.green : T.muted,
                  letterSpacing: ".05em",
                }}>
                  {vmAtual.ignicao ? "IGN ON" : "IGN OFF"}
                </span>
              )}

              {carregando && (
                <span style={{ fontSize: 10, color: T.accent, letterSpacing: ".04em" }}>
                  carregando...
                </span>
              )}

              <div style={{ flex: 1 }} />

              {/* Period selector */}
              <div style={{ display: "flex", gap: 1 }}>
                {PERIODOS.map(h => (
                  <button key={h} onClick={() => setHoras(h)} style={{
                    height: 24, padding: "0 7px", borderRadius: 5, border: "none", cursor: "pointer",
                    background: horas === h ? `${T.accent}20` : "transparent",
                    color: horas === h ? T.accent : T.dim,
                    fontSize: 10, fontWeight: 700, fontFamily: FONT_MONO,
                    transition: "all .1s",
                  }}>
                    {h}h
                  </button>
                ))}
              </div>

              <button onClick={limparSelecao}
                style={{
                  ...BASE_BTN, width: 28, height: 28, borderRadius: "50%",
                  fontSize: 16, color: T.dim, border: `1px solid ${T.border}`,
                }}>
                &times;
              </button>
            </div>

            {/* Metrics row */}
            <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}>
              {[
                {
                  label: "VELOCIDADE",
                  value: vmAtual ? `${vmAtual.velocidade} km/h` : "—",
                  color: vmAtual && vmAtual.velocidade > 80 ? T.yellow : undefined,
                },
                {
                  label: "IGNIÇÃO",
                  value: vmAtual ? (vmAtual.ignicao ? "Ligada" : "Desligada") : "—",
                  color: vmAtual ? (vmAtual.ignicao ? T.green : T.muted) : undefined,
                },
                {
                  label: "COMUNICAÇÃO",
                  value: vmAtual ? (vmAtual.atraso_min > 0 ? `${Math.round(vmAtual.atraso_min)}min` : "ao vivo") : "—",
                  color: vmAtual && vmAtual.atraso_min > 30 ? T.yellow : undefined,
                },
                { label: "LOCAL", value: vmAtual?.local || "—", wide: true },
              ].map((item, i, arr) => (
                <div key={i} style={{
                  flex: item.wide ? 2 : 1, padding: "8px 14px",
                  borderRight: i < arr.length - 1 ? `1px solid ${T.border}` : "none",
                  minWidth: 0,
                }}>
                  <div style={{ fontSize: 9, color: T.dim, letterSpacing: ".08em", marginBottom: 3 }}>
                    {item.label}
                  </div>
                  <div style={{
                    fontSize: "clamp(12px, 1.1vw, 14px)", fontWeight: 700,
                    fontFamily: FONT_MONO, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    color: item.color ?? T.text,
                  }}>
                    {item.value}
                  </div>
                </div>
              ))}

              {/* Rota do dia */}
              {cvSelecionado && (
                <div style={{ flex: 2, padding: "8px 14px", minWidth: 0, borderLeft: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 9, color: T.dim, letterSpacing: ".08em", marginBottom: 4 }}>
                    ROTA DO DIA
                  </div>
                  {carregando && alvosTotal === 0 ? (
                    <div style={{ fontSize: 11, color: T.dim }}>...</div>
                  ) : alvosTotal === 0 ? (
                    <div style={{ fontSize: 11, color: T.dim }}>Sem rota hoje</div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: FONT_MONO, color: T.text, flexShrink: 0 }}>
                        {alvosFeitos}/{alvosTotal}
                      </span>
                      <div style={{ flex: 1, height: 3, background: `${T.border}88`, borderRadius: 2, overflow: "hidden" }}>
                        <div style={{
                          height: "100%",
                          width: `${alvosTotal > 0 ? Math.round((alvosFeitos / alvosTotal) * 100) : 0}%`,
                          background: T.green, borderRadius: 2, transition: "width .4s",
                        }} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Ops + sirene/bloqueio */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", flexWrap: "wrap" }}>
              <button onClick={() => setMostrarRastro(v => !v)} style={drawerOpBtn(mostrarRastro)}>
                Rastro{mostrarRastro ? " ✓" : ""}
              </button>
              <button onClick={() => setMostrarParadas(v => !v)} style={drawerOpBtn(mostrarParadas)}>
                Paradas{mostrarParadas ? " ✓" : ""}
              </button>
              <button onClick={() => setSeguir(v => !v)} style={drawerOpBtn(seguir, T.green)}>
                Seguir{seguir ? " ✓" : ""}
              </button>
              <button onClick={centralizar} style={drawerOpBtn(false)}>
                Centralizar
              </button>
              {cvSelecionado && vmAtual?.lat && vmAtual?.lng && (
                <a
                  href={`https://www.google.com/maps?q=${vmAtual.lat},${vmAtual.lng}`}
                  target="_blank" rel="noreferrer"
                  style={{ ...drawerOpBtn(false), display: "inline-flex", alignItems: "center", textDecoration: "none", gap: 4 }}>
                  Maps
                </a>
              )}
              {cvSelecionado && (
                <button onClick={() => {
                  const vm = veiculosMapa.find(v => v.cv === cvSelecionado);
                  carregarVeiculo(cvSelecionado, horas, vm?.lat != null && vm?.lng != null);
                }} disabled={carregando}
                  style={drawerOpBtn(false)}>
                  Atualizar
                </button>
              )}

              <div style={{ flex: 1 }} />

              {/* Sirene */}
              <button
                onClick={() => acionar("sirene")}
                disabled={cmdSirene === "loading"}
                style={{
                  height: 34, padding: "0 16px", borderRadius: 8,
                  cursor: cmdSirene === "loading" ? "wait" : "pointer",
                  border: `1px solid ${
                    cmdSirene === "ok" ? T.green + "44" :
                    cmdSirene === "fallback" ? T.yellow + "44" : T.accent + "44"
                  }`,
                  background: cmdSirene === "ok" ? `${T.green}14` :
                    cmdSirene === "fallback" ? `${T.yellow}14` : `${T.accent}0e`,
                  color: cmdSirene === "ok" ? T.green :
                    cmdSirene === "fallback" ? T.yellow : T.accent,
                  fontSize: 12, fontWeight: 700, fontFamily: FONT_SANS,
                  transition: "all .15s",
                }}>
                {cmdSirene === "loading" ? "Acionando..." :
                  cmdSirene === "ok" ? "Sirene acionada" :
                  cmdSirene === "fallback" ? "Ver portal" : "Sirene"}
              </button>

              {/* Bloquear/desbloquear motor — alterna a cada acionamento */}
              <button
                onClick={() => acionar("bloqueio")}
                disabled={cmdBloqueio === "loading"}
                style={{
                  height: 34, padding: "0 16px", borderRadius: 8,
                  cursor: cmdBloqueio === "loading" ? "wait" : "pointer",
                  border: `1px solid ${
                    cmdBloqueio === "ok" ? T.green + "44" :
                    cmdBloqueio === "fallback" ? T.yellow + "44" :
                    motorBloqueado ? T.green + "44" : T.red + "44"
                  }`,
                  background: cmdBloqueio === "ok" ? `${T.green}14` :
                    cmdBloqueio === "fallback" ? `${T.yellow}14` :
                    motorBloqueado ? `${T.green}10` : `${T.red}10`,
                  color: cmdBloqueio === "ok" ? T.green :
                    cmdBloqueio === "fallback" ? T.yellow :
                    motorBloqueado ? T.green : T.red,
                  fontSize: 12, fontWeight: 700, fontFamily: FONT_SANS,
                  transition: "all .15s",
                }}>
                {cmdBloqueio === "loading" ? (motorBloqueado ? "Desbloqueando..." : "Bloqueando...") :
                  cmdBloqueio === "ok" ? (motorBloqueado ? "Motor bloqueado" : "Motor desbloqueado") :
                  cmdBloqueio === "fallback" ? "Ver portal" :
                  motorBloqueado ? "Desbloquear motor" : "Bloquear motor"}
              </button>
            </div>

            {/* Fallback portal link */}
            {(cmdSirene === "fallback" || cmdBloqueio === "fallback") && fallbackUrl && (
              <div style={{ padding: "2px 16px 9px", fontSize: 11, color: T.muted }}>
                Acao nao confirmada automaticamente.{" "}
                <a href={fallbackUrl} target="_blank" rel="noreferrer" style={{ color: T.accent }}>
                  Abrir portal Unitrac
                </a>
              </div>
            )}

          </div>

        </div>{/* MAP AREA end */}
      </div>{/* MAIN BODY end */}

      {/* ================================================================
          PANICO OVERLAY
      ================================================================ */}
      {panicoAlerta && (
        <div style={{
          position: "fixed", inset: 0, zIndex: Z.panico,
          background: "rgba(100,0,0,0.15)", backdropFilter: "blur(3px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: "fadeInPanico .18s ease-out",
        }}
          onClick={e => { if (e.target === e.currentTarget) setPanicoAlerta(null); }}>
          <div style={{
            background: "#0e0000", border: "2px solid #ef4444",
            borderRadius: 16, padding: "40px 56px 36px",
            textAlign: "center", maxWidth: 480, width: "90%",
            boxShadow: "0 0 0 1px #ef444416, 0 0 80px #ef444440",
            animation: "scalePanico .2s cubic-bezier(.34,1.56,.64,1)",
            fontFamily: FONT_SANS,
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: "#ef444418", border: "2px solid #ef4444",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 20px",
              animation: "pulsarPanico 1.2s ease-in-out infinite",
            }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/>
                <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>

            <div style={{ fontSize: 11, letterSpacing: ".2em", color: "#ef4444", fontWeight: 700, marginBottom: 12 }}>
              BOTÃO DE PÂNICO ACIONADO
            </div>

            <div style={{
              fontFamily: FONT_MONO, fontSize: 42, fontWeight: 900,
              color: "#ffffff", letterSpacing: ".1em", marginBottom: 16,
            }}>
              {panicoAlerta.placa}
            </div>

            {panicoAlerta.local && (
              <div style={{ fontSize: 13, color: "#a8a29e", marginBottom: 8, lineHeight: 1.4 }}>
                {panicoAlerta.local}
              </div>
            )}
            {panicoAlerta.motivo && (
              <div style={{ fontSize: 12, color: "#78716c", marginBottom: 8 }}>
                {panicoAlerta.motivo}
              </div>
            )}
            {panicoAlerta.velocidade != null && (
              <div style={{ fontSize: 12, color: "#78716c", marginBottom: 20, fontFamily: FONT_MONO }}>
                {panicoAlerta.velocidade} km/h &nbsp;·&nbsp; <span suppressHydrationWarning>{tempoAtras(panicoAlerta.desde)}</span> atras
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              {panicoAlerta.lat && panicoAlerta.lng && (
                <button
                  onClick={() => {
                    selecionarVeiculo(panicoAlerta!.cv, { lat: panicoAlerta!.lat!, lng: panicoAlerta!.lng! });
                    setPanicoAlerta(null);
                  }}
                  style={{
                    height: 40, padding: "0 20px", borderRadius: 8,
                    background: "#ef444414", border: "1px solid #ef444450",
                    color: "#ef4444", fontSize: 13, fontWeight: 700, cursor: "pointer",
                    fontFamily: FONT_SANS,
                  }}>
                  Ir para o veiculo
                </button>
              )}
              <button
                onClick={() => setPanicoAlerta(null)}
                style={{
                  height: 40, padding: "0 20px", borderRadius: 8,
                  background: "#ffffff10", border: "1px solid #ffffff20",
                  color: "#a8a29e", fontSize: 13, cursor: "pointer",
                  fontFamily: FONT_SANS,
                }}>
                Reconhecer
              </button>
              <button
                onClick={tocarPanico}
                title="Repetir som"
                style={{
                  height: 40, width: 40, borderRadius: 8,
                  background: "transparent", border: "1px solid #ffffff14",
                  color: "#78716c", fontSize: 16, cursor: "pointer",
                }}>
                ♪
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================
          SELETOR DE VEÍCULOS — "ver apenas selecionados" (Configurações)
      ================================================================ */}
      {seletorAberto && (
        <div style={{
          position: "fixed", inset: 0, zIndex: Z.panico,
          background: "rgba(0,0,0,0.55)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={e => { if (e.target === e.currentTarget) setSeletorAberto(false); }}>
          <div style={{
            width: "min(420px, 92vw)", maxHeight: "80vh",
            background: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
            boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
            display: "flex", flexDirection: "column", overflow: "hidden",
            fontFamily: FONT_SANS,
          }}>
            <div style={{
              padding: "14px 16px 10px", borderBottom: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
                Ver apenas veículos selecionados
              </span>
              <button onClick={() => setSeletorAberto(false)}
                style={{ background: "none", border: "none", color: T.dim, fontSize: 18, cursor: "pointer", lineHeight: 1 }}>
                ×
              </button>
            </div>

            <div style={{ padding: "10px 16px 6px" }}>
              <input
                autoFocus
                value={buscaSeletor}
                onChange={e => setBuscaSeletor(e.target.value)}
                placeholder="Digite a placa..."
                style={{
                  width: "100%", height: 32, borderRadius: 7, border: `1px solid ${T.border}`,
                  background: tema === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
                  color: T.text, padding: "0 10px", fontSize: 13,
                  fontFamily: FONT_MONO, outline: "none", boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ padding: "6px 16px 6px", display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={() => salvarVeiculosSelecionados(new Set(veiculosBase.map(v => v.cv)))}
                style={tinyBtn(T.accent)}>
                Marcar todos
              </button>
              <button onClick={() => salvarVeiculosSelecionados(new Set())} style={tinyBtn(T.dim)}>
                Limpar
              </button>
              <span style={{ marginLeft: "auto", fontSize: 10, color: T.dim, fontFamily: FONT_MONO }}>
                {veiculosSelecionados.size} selecionado{veiculosSelecionados.size === 1 ? "" : "s"}
              </span>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 10px", minHeight: 120 }}>
              {veiculosBase
                .filter(v => v.placa.toLowerCase().includes(buscaSeletor.toLowerCase()))
                .map(v => {
                  const marcado = veiculosSelecionados.has(v.cv);
                  return (
                    <button key={v.cv} onClick={() => toggleVeiculoSelecionado(v.cv)}
                      style={{
                        display: "flex", alignItems: "center", gap: 9, width: "100%",
                        padding: "7px 8px", borderRadius: 7, marginBottom: 2,
                        background: marcado ? `${T.accent}12` : "transparent",
                        border: "1px solid transparent", cursor: "pointer",
                        color: T.text, fontSize: 12, fontFamily: FONT_MONO, textAlign: "left",
                      }}>
                      <div style={{
                        width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                        background: marcado ? T.accent : "transparent",
                        border: `1.5px solid ${marcado ? T.accent : T.dim}`,
                      }} />
                      {v.placa}
                    </button>
                  );
                })}
              {veiculosBase.length === 0 && (
                <div style={{ padding: "16px 8px", fontSize: 12, color: T.dim, textAlign: "center" }}>
                  Nenhum veículo carregado.
                </div>
              )}
            </div>

            <div style={{ padding: "10px 16px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 8 }}>
              <button onClick={() => { setModoSelecionadosSessao(false); setSeletorAberto(false); }}
                style={{
                  flex: 1, height: 32, borderRadius: 7, border: `1px solid ${T.border}`,
                  background: "transparent", color: T.dim, fontSize: 12, cursor: "pointer", fontFamily: FONT_SANS,
                }}>
                Mostrar todos
              </button>
              <button onClick={() => { setModoSelecionadosSessao(true); setSeletorAberto(false); }}
                disabled={veiculosSelecionados.size === 0}
                style={{
                  flex: 1, height: 32, borderRadius: 7, border: "none",
                  background: veiculosSelecionados.size === 0 ? T.border : T.accent,
                  color: veiculosSelecionados.size === 0 ? T.dim : "#fff",
                  fontSize: 12, fontWeight: 700,
                  cursor: veiculosSelecionados.size === 0 ? "default" : "pointer",
                  fontFamily: FONT_SANS,
                }}>
                Gerar mapa ({veiculosSelecionados.size})
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideInToast {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes fadeInPanico {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes scalePanico {
          from { transform: scale(.88); opacity: 0; }
          to   { transform: scale(1); opacity: 1; }
        }
        @keyframes pulsarPanico {
          0%, 100% { box-shadow: 0 0 0 0 #ef444438; }
          50%       { box-shadow: 0 0 0 12px #ef444406; }
        }
        .v2-btn:hover { opacity: 0.72; }
        .v2-btn-tiny:hover { filter: brightness(1.18); }
        .v2-drawer-btn:hover { filter: brightness(1.12); }
        .v2-alert-card:hover { filter: brightness(1.05); }
      `}</style>
    </div>
  );
}
