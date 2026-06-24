"use client";

/**
 * MapaMonitor.tsx
 * Monitor de frota ao estilo Unitrac: sidebar com grupos colapsaveis,
 * filtros de periodo e comunicacao, mapa com todos os veiculos em tempo real,
 * rastro/paradas ao selecionar, painel de telemetria flutuante.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  Marker,
  Popup,
  GeoJSON,
  LayersControl,
  LayerGroup,
  useMap,
} from "react-leaflet";
import type { Layer } from "leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* ------------------------------------------------------------------ */
/* Tipos                                                                */
/* ------------------------------------------------------------------ */

interface VeiculoOpcao {
  placa: string;
  cv: string;
}

interface Grupo {
  gvc: number;
  gvn: string;
  veiculos: VeiculoOpcao[];
}

interface VeiculoMapa {
  placa: string;
  cv: string;
  nivel: string | null;
  velocidade: number;
  ignicao: boolean;
  atraso_min: number;
  tipo: string | null;
  lat: number | null;
  lng: number | null;
  local: string | null;
  entregas_feitas: number | null;
  entregas_total: number | null;
}

interface PontRastro {
  lat: number;
  lng: number;
}

interface Parada {
  data: string;
  local: string;
  tempoMin: number;
  lat: number;
  lng: number;
}

interface Telemetria {
  posiclatitude?: string;
  posiclongitude?: string;
  posicvelocidade?: string;
  posicignicao?: string;
  tipevnome?: string;
  posicentrada1?: string;
  posicentrada2?: string;
  posicentrada3?: string;
  posicentrada4?: string;
  posicentrada5?: string;
  posicentrada6?: string;
  posicentrada7?: string;
  posicentrada8?: string;
  posicentrada9?: string;
  posicentrada10?: string;
  posicsaida1?: string;
  posicsaida2?: string;
  posicsaida3?: string;
  posicsaida4?: string;
  veicuplaca?: string;
  atraso?: string;
  datagps?: string;
  [key: string]: unknown;
}

interface Tiroteio {
  lat: number;
  lng: number;
  date: string;
  bairro: string;
  cidade: string;
  motivo: string | null;
  vitimas: number;
  acaoPolicial: boolean;
  idadeMin: number;
  recente: boolean;
}

interface Props {
  cliente: string;
  veiculos: VeiculoOpcao[];
}

/* ------------------------------------------------------------------ */
/* Constantes                                                           */
/* ------------------------------------------------------------------ */

const PERIODOS = [
  { label: "1h", horas: 1 },
  { label: "4h", horas: 4 },
  { label: "24h", horas: 24 },
  { label: "4d", horas: 96 },
] as const;

type HorasPeriodo = (typeof PERIODOS)[number]["horas"];

const FILTROS_COMM = [
  { label: "10 min", min: 10 },
  { label: "30 min", min: 30 },
  { label: "60 min", min: 60 },
] as const;

const SIDEBAR_W = 280;
const HEADER_H_CSS = "var(--header-h, 64px)";

/* ------------------------------------------------------------------ */
/* Cores de marcador                                                    */
/* ------------------------------------------------------------------ */

function corVeiculo(v: VeiculoMapa): string {
  if (v.nivel === "vermelho" || v.tipo !== null) return "#ef4444";
  if (v.nivel === "amarelo") return "#f59e0b";
  if (v.ignicao && v.velocidade > 0) return "#22c55e";
  if (v.ignicao && v.velocidade === 0) return "#9fb3ce";
  if (v.atraso_min > 60) return "#57534e";
  return "#57534e";
}

/* ------------------------------------------------------------------ */
/* Cache de icones Leaflet                                             */
/* ------------------------------------------------------------------ */

const _iconeCache: Record<string, L.DivIcon> = {};

function iconeVeiculo(cor: string, destaque: boolean): L.DivIcon {
  const chave = `${cor}-${destaque}`;
  if (_iconeCache[chave]) return _iconeCache[chave];
  const s = destaque ? 18 : 12;
  const glow = destaque ? `,0 0 8px ${cor}` : "";
  const html =
    `<div style="width:${s}px;height:${s}px;border-radius:50%;` +
    `background:${cor};border:2px solid #fff;` +
    `box-shadow:0 0 0 1px rgba(0,0,0,0.4)${glow}">` +
    `</div>`;
  const ic = L.divIcon({
    html,
    className: "",
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    popupAnchor: [0, -s / 2],
  });
  _iconeCache[chave] = ic;
  return ic;
}

function iconeCaminhao(cor: string, destaque: boolean): L.DivIcon {
  const chave = `cam-${cor}-${destaque}`;
  if (_iconeCache[chave]) return _iconeCache[chave];
  const s = destaque ? 36 : 28;
  const html =
    `<div style="width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;` +
    `background:rgba(10,10,10,0.92);border:2px solid ${cor};border-radius:50%;` +
    `box-shadow:0 0 0 1px rgba(0,0,0,0.5)${destaque ? `,0 0 10px ${cor}` : ""}">` +
    `<svg width="${destaque ? 20 : 16}" height="${destaque ? 20 : 16}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="1" y="3" width="15" height="13"/>` +
    `<polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>` +
    `<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div>`;
  const ic = L.divIcon({
    html,
    className: "marcador-caminhao",
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    popupAnchor: [0, -s / 2],
  });
  _iconeCache[chave] = ic;
  return ic;
}

function fixIcones() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (L.Icon.Default.prototype as any)._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  });
}

/* ------------------------------------------------------------------ */
/* Roubo de carga                                                      */
/* ------------------------------------------------------------------ */

function corRoubo(n: number): string {
  if (n >= 1000) return "#ef4444";
  if (n >= 300) return "#f87171";
  if (n >= 100) return "#fb923c";
  if (n >= 30) return "#fbbf24";
  if (n >= 10) return "#fde047";
  if (n >= 1) return "#fef9c3";
  return "transparent";
}

function estiloRoubo(feature?: GeoJSON.Feature) {
  const n = Number((feature?.properties as { roubo_carga?: number })?.roubo_carga ?? 0);
  return {
    fillColor: corRoubo(n),
    fillOpacity: n > 0 ? 0.25 : 0,
    color: n > 0 ? "#b91c1c" : "transparent",
    weight: n > 0 ? 0.3 : 0,
    opacity: 0.35,
  };
}

function popupRoubo(feature: GeoJSON.Feature, layer: Layer) {
  const p = feature.properties as { nome?: string; roubo_carga?: number };
  const n = Number(p?.roubo_carga ?? 0);
  layer.bindPopup(
    `<div style="font-weight:700;font-size:13px">${p?.nome ?? "Municipio"}</div>` +
    `<div style="font-size:12px;margin-top:2px">${n} roubo(s) de carga</div>` +
    `<div style="font-size:11px;color:#666;margin-top:1px">ultimos 12 meses · ISP-RJ</div>`
  );
}

/* ------------------------------------------------------------------ */
/* Helpers de formatacao                                                */
/* ------------------------------------------------------------------ */

function formatarDuracao(min: number): string {
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatarDataHora(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function idadeTexto(min: number): string {
  if (min < 1) return "agora";
  if (min < 60) return `ha ${min}min`;
  return `ha ${Math.floor(min / 60)}h`;
}

/* ------------------------------------------------------------------ */
/* Sub-componente: ajusta bounds do mapa ao rastro                     */
/* ------------------------------------------------------------------ */

function AjustarBoundsRastro({
  pontos,
  gatilho,
}: {
  pontos: [number, number][];
  gatilho: number;
}) {
  const map = useMap();
  const ultimoGatilho = useRef(-1);

  useEffect(() => {
    if (gatilho === ultimoGatilho.current) return;
    ultimoGatilho.current = gatilho;
    if (pontos.length === 0) return;
    try {
      const bounds = L.latLngBounds(pontos);
      map.fitBounds(bounds, { padding: [40, 40] });
    } catch {
      /* ignora bounds invalido */
    }
  }, [pontos, gatilho, map]);

  return null;
}

/* ------------------------------------------------------------------ */
/* Painel de telemetria flutuante                                      */
/* ------------------------------------------------------------------ */

function PainelTelemetria({
  placa,
  dados,
  onFechar,
}: {
  placa: string;
  dados: Telemetria | null;
  onFechar: () => void;
}) {
  const velocidade = dados ? parseInt(dados.posicvelocidade ?? "0") || 0 : null;
  const ignicao = dados ? dados.posicignicao === "1" : null;
  const evento = dados?.tipevnome ?? null;
  const atraso = dados ? parseInt(dados.atraso ?? "0") || 0 : null;

  const entradas = dados
    ? Array.from({ length: 10 }, (_, i) => i + 1).filter(
        (i) => dados[`posicentrada${i}`] === "1"
      )
    : [];
  const saidas = dados
    ? Array.from({ length: 4 }, (_, i) => i + 1).filter(
        (i) => dados[`posicsaida${i}`] === "1"
      )
    : [];

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 1000,
        width: 260,
        backgroundColor: "rgba(10,10,10,0.96)",
        border: "1px solid var(--border)",
        borderRadius: "0.875rem",
        overflow: "hidden",
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div
        style={{
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: "var(--accent-dim)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: ignicao ? "var(--verde)" : "var(--text-dim)",
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
            padding: "2px 4px",
            lineHeight: 1,
            fontSize: 18,
          }}
          title="Fechar painel"
        >
          &times;
        </button>
      </div>

      <div style={{ padding: "0.875rem 1rem", display: "flex", flexDirection: "column", gap: 10 }}>
        {dados === null ? (
          <p style={{ color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
            carregando telemetria...
          </p>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <p style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  velocidade
                </p>
                <p
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontSize: "1.25rem",
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
                <p style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  ignicao
                </p>
                <p
                  style={{
                    fontSize: "0.875rem",
                    color: ignicao ? "var(--verde)" : "var(--text-dim)",
                    fontWeight: 600,
                  }}
                >
                  {ignicao ? "ligada" : "desligada"}
                </p>
              </div>
            </div>

            {evento && (
              <div
                style={{
                  padding: "0.5rem 0.75rem",
                  backgroundColor: "var(--card-hover)",
                  borderRadius: "0.5rem",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <p style={{ color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>
                  ultimo evento
                </p>
                <p style={{ color: "var(--text-muted)", fontSize: 12 }}>{evento}</p>
              </div>
            )}

            {atraso !== null && atraso > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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

            {(entradas.length > 0 || saidas.length > 0) && (
              <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }}>
                <p style={{ color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
                  sensores ativos
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {entradas.map((i) => (
                    <span
                      key={`E${i}`}
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "2px 6px",
                        borderRadius: 4,
                        backgroundColor: "rgba(34,197,94,0.12)",
                        border: "1px solid rgba(34,197,94,0.25)",
                        color: "var(--verde)",
                      }}
                    >
                      E{i}
                    </span>
                  ))}
                  {saidas.map((i) => (
                    <span
                      key={`S${i}`}
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "2px 6px",
                        borderRadius: 4,
                        backgroundColor: "rgba(159,179,206,0.12)",
                        border: "1px solid rgba(159,179,206,0.25)",
                        color: "var(--accent)",
                      }}
                    >
                      S{i}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Item de legenda                                                      */
/* ------------------------------------------------------------------ */

function LegendaItem({ cor, label, qtd }: { cor: string; label: string; qtd: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          backgroundColor: cor,
          display: "inline-block",
          flexShrink: 0,
          border: "1px solid rgba(255,255,255,0.2)",
        }}
      />
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
        {label}
        {qtd > 0 && (
          <span style={{ marginLeft: 3, color: "var(--text-muted)", fontFamily: "var(--font-geist-mono, monospace)" }}>
            ({qtd})
          </span>
        )}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componente principal                                                 */
/* ------------------------------------------------------------------ */

export default function MapaMonitor({ veiculos, cliente }: Props) {
  useEffect(() => { fixIcones(); }, []);

  /* ---- Grupos (arvore da sidebar) ---- */
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [gruposExpandidos, setGruposExpandidos] = useState<Set<number>>(new Set());
  const [cvsSelecionados, setCvsSelecionados] = useState<Set<string>>(
    () => new Set(veiculos.map((v) => v.cv))
  );
  const cvsTodosRef = useRef<Set<string>>(new Set(veiculos.map((v) => v.cv)));

  /* ---- Posicoes de todos os veiculos ---- */
  const [veiculosMapa, setVeiculosMapa] = useState<VeiculoMapa[]>([]);

  /* ---- Busca na sidebar ---- */
  const [busca, setBusca] = useState("");

  /* ---- Veiculo selecionado ---- */
  const [cvSelecionado, setCvSelecionado] = useState<string | null>(null);
  const [placaSelecionada, setPlacaSelecionada] = useState<string | null>(null);

  /* ---- Periodo ---- */
  const [horas, setHoras] = useState<HorasPeriodo>(24);

  /* ---- Filtro de comunicacao (null = sem filtro) ---- */
  const [filtroComm, setFiltroComm] = useState<number | null>(null);

  /* ---- Dados do veiculo selecionado ---- */
  const [rastro, setRastro] = useState<PontRastro[]>([]);
  const [paradas, setParadas] = useState<Parada[]>([]);
  const [telemetria, setTelemetria] = useState<Telemetria | null>(null);
  const [carregando, setCarregando] = useState(false);

  /* ---- Toggles de camada ---- */
  const [mostrarRastro, setMostrarRastro] = useState(true);
  const [mostrarParadas, setMostrarParadas] = useState(true);
  const [painelAberto, setPainelAberto] = useState(false);

  /* ---- Gatilho de fitBounds ---- */
  const [gatilhoBounds, setGatilhoBounds] = useState(0);

  /* ---- Camadas de risco ---- */
  const [favelas, setFavelas] = useState<GeoJSON.FeatureCollection | null>(null);
  const [tiroteios, setTiroteios] = useState<Tiroteio[]>([]);
  const [rouboCarga, setRouboCarga] = useState<GeoJSON.FeatureCollection | null>(null);

  /* ------------------------------------------------------------------ */
  /* Carregar grupos ao montar                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!cliente) return;
    fetch(`/api/grupos?cliente=${encodeURIComponent(cliente)}`)
      .then((r) => r.json())
      .then((d) => {
        const lista: Grupo[] = Array.isArray(d?.grupos) ? d.grupos : [];
        setGrupos(lista);
        setGruposExpandidos(new Set());
        const todosCvs = new Set<string>();
        for (const g of lista) {
          for (const v of g.veiculos) todosCvs.add(v.cv);
        }
        if (todosCvs.size > 0) {
          cvsTodosRef.current = todosCvs;
          setCvsSelecionados(todosCvs);
        } else {
          setCvsSelecionados(new Set(cvsTodosRef.current));
        }
      })
      .catch(() => {
        setCvsSelecionados(new Set(cvsTodosRef.current));
      });
  }, [cliente]);

  /* ------------------------------------------------------------------ */
  /* Posicoes de todos os veiculos (refresh a cada 30s)                  */
  /* ------------------------------------------------------------------ */

  const carregarMapa = useCallback(() => {
    if (!cliente) return;
    fetch(`/api/mapa?cliente=${encodeURIComponent(cliente)}`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.veiculos)) {
          setVeiculosMapa(d.veiculos as VeiculoMapa[]);
        }
      })
      .catch(() => {});
  }, [cliente]);

  useEffect(() => {
    carregarMapa();
    const id = setInterval(carregarMapa, 30000);
    return () => clearInterval(id);
  }, [carregarMapa]);

  /* ------------------------------------------------------------------ */
  /* Camadas de risco                                                     */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    fetch("/api/favelas").then((r) => r.json()).then(setFavelas).catch(() => {});
  }, []);

  useEffect(() => {
    let ativo = true;
    const carregar = () =>
      fetch("/api/tiroteios")
        .then((r) => r.json())
        .then((d) => { if (ativo && Array.isArray(d?.tiroteios)) setTiroteios(d.tiroteios); })
        .catch(() => {});
    carregar();
    const id = setInterval(carregar, 90000);
    return () => { ativo = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    fetch("/api/roubo-carga")
      .then((r) => r.json())
      .then((d) => { if (d?.geojson) setRouboCarga(d.geojson); })
      .catch(() => {});
  }, []);

  /* ------------------------------------------------------------------ */
  /* Buscar rastro, paradas e telemetria ao selecionar veiculo/periodo   */
  /* ------------------------------------------------------------------ */

  const buscarDados = useCallback(async (cv: string, h: number) => {
    setCarregando(true);
    setRastro([]);
    setParadas([]);
    setTelemetria(null);
    try {
      const [resRastro, resStops, resTel] = await Promise.all([
        fetch(`/api/rastro?cv=${encodeURIComponent(cv)}&horas=${h}`),
        fetch(`/api/stops?cv=${encodeURIComponent(cv)}&horas=${h}`),
        fetch(`/api/veiculo?cv=${encodeURIComponent(cv)}`),
      ]);
      const [dRastro, dStops, dTel] = await Promise.all([
        resRastro.json(),
        resStops.json(),
        resTel.json(),
      ]);
      if (Array.isArray(dRastro?.pontos)) setRastro(dRastro.pontos);
      if (Array.isArray(dStops?.paradas)) setParadas(dStops.paradas);
      if (dTel?.posicao) setTelemetria(dTel.posicao as Telemetria);
    } catch {
      /* falha silenciosa */
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (!cvSelecionado) return;
    buscarDados(cvSelecionado, horas);
  }, [cvSelecionado, horas, buscarDados]);

  /* ------------------------------------------------------------------ */
  /* Selecionar / limpar veiculo                                          */
  /* ------------------------------------------------------------------ */

  const selecionarVeiculo = useCallback((v: VeiculoOpcao) => {
    setCvSelecionado(v.cv);
    setPlacaSelecionada(v.placa);
    setPainelAberto(true);
    setGatilhoBounds((g) => g + 1);
  }, []);

  const limparSelecao = useCallback(() => {
    setCvSelecionado(null);
    setPlacaSelecionada(null);
    setRastro([]);
    setParadas([]);
    setTelemetria(null);
    setPainelAberto(false);
  }, []);

  /* ------------------------------------------------------------------ */
  /* Checkboxes de grupos                                                 */
  /* ------------------------------------------------------------------ */

  const toggleGrupo = useCallback((gvc: number) => {
    setGruposExpandidos((prev) => {
      const novo = new Set(prev);
      if (novo.has(gvc)) novo.delete(gvc);
      else novo.add(gvc);
      return novo;
    });
  }, []);

  const toggleCvGrupo = useCallback((cvs: string[], marcar: boolean) => {
    setCvsSelecionados((prev) => {
      const novo = new Set(prev);
      for (const cv of cvs) {
        if (marcar) novo.add(cv);
        else novo.delete(cv);
      }
      return novo;
    });
  }, []);

  const toggleCv = useCallback((cv: string) => {
    setCvsSelecionados((prev) => {
      const novo = new Set(prev);
      if (novo.has(cv)) novo.delete(cv);
      else novo.add(cv);
      return novo;
    });
  }, []);

  /* ------------------------------------------------------------------ */
  /* Veiculos visiveis no mapa                                            */
  /* ------------------------------------------------------------------ */

  const veiculosVisiveis = veiculosMapa.filter((v) => {
    if (!cvsSelecionados.has(v.cv)) return false;
    if (filtroComm !== null && v.atraso_min > filtroComm) return false;
    return true;
  });

  const qtdEmMovimento = veiculosVisiveis.filter((v) => v.ignicao && v.velocidade > 0).length;
  const qtdParadoLigado = veiculosVisiveis.filter((v) => v.ignicao && v.velocidade === 0).length;
  const qtdSemComm = veiculosVisiveis.filter((v) => v.atraso_min > 60).length;
  const qtdAlerta = veiculosVisiveis.filter((v) => v.nivel === "vermelho" || v.tipo !== null).length;

  /* ------------------------------------------------------------------ */
  /* Posicao atual do veiculo selecionado                                 */
  /* ------------------------------------------------------------------ */

  const pontosRastro: [number, number][] = rastro.map((p) => [p.lat, p.lng]);

  const posAtual = telemetria
    ? {
        lat: parseFloat(telemetria.posiclatitude ?? ""),
        lng: parseFloat(telemetria.posiclongitude ?? ""),
      }
    : null;
  const posValida =
    posAtual &&
    Number.isFinite(posAtual.lat) &&
    Number.isFinite(posAtual.lng) &&
    !(posAtual.lat === 0 && posAtual.lng === 0);

  const corIgnicao = telemetria?.posicignicao === "1" ? "#22c55e" : "#9fb3ce";

  /* ------------------------------------------------------------------ */
  /* Basemap                                                              */
  /* ------------------------------------------------------------------ */

  const googleApiKey =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
      : undefined;

  /* ------------------------------------------------------------------ */
  /* Grupos filtrados pela busca                                          */
  /* ------------------------------------------------------------------ */

  const temGrupos = grupos.length > 0;

  const gruposFiltrados = busca.trim()
    ? grupos
        .map((g) => ({
          ...g,
          veiculos: g.veiculos.filter((v) =>
            v.placa.toUpperCase().includes(busca.toUpperCase())
          ),
        }))
        .filter((g) => g.veiculos.length > 0)
    : grupos;

  /* ------------------------------------------------------------------ */
  /* Render                                                               */
  /* ------------------------------------------------------------------ */

  return (
    <div
      style={{
        display: "flex",
        height: `calc(100vh - ${HEADER_H_CSS} - 5rem)`,
        minHeight: 480,
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: "1rem",
      }}
    >
      {/* ============================================================
          SIDEBAR
          ============================================================ */}
      <div
        style={{
          width: SIDEBAR_W,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--card)",
          borderRight: "1px solid var(--border)",
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {/* Cabecalho da sidebar */}
        <div
          style={{
            padding: "0.75rem 0.875rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {/* Busca */}
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar placa..."
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              backgroundColor: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--font-geist-mono, monospace)",
              letterSpacing: "0.06em",
              outline: "none",
              boxSizing: "border-box",
            }}
          />

          {/* Periodo */}
          <div>
            <p style={{ color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
              Periodo:
            </p>
            <div style={{ display: "flex", gap: 3 }}>
              {PERIODOS.map((p) => (
                <button
                  key={p.horas}
                  onClick={() => setHoras(p.horas)}
                  disabled={!cvSelecionado}
                  style={{
                    flex: 1,
                    padding: "0.25rem 0",
                    borderRadius: "0.375rem",
                    border: "none",
                    cursor: cvSelecionado ? "pointer" : "not-allowed",
                    fontSize: 11,
                    fontWeight: 600,
                    backgroundColor: horas === p.horas ? "var(--accent-dim)" : "var(--bg)",
                    color: horas === p.horas ? "var(--accent)" : "var(--text-dim)",
                    opacity: !cvSelecionado ? 0.4 : 1,
                    transition: "all 0.12s",
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Filtro comunicacao */}
          <div>
            <p style={{ color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
              Comunicacao:
            </p>
            <div style={{ display: "flex", gap: 3 }}>
              {FILTROS_COMM.map((f) => (
                <button
                  key={f.min}
                  onClick={() => setFiltroComm((prev) => (prev === f.min ? null : f.min))}
                  style={{
                    flex: 1,
                    padding: "0.25rem 0",
                    borderRadius: "0.375rem",
                    border: "none",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                    backgroundColor: filtroComm === f.min ? "rgba(245,158,11,0.15)" : "var(--bg)",
                    color: filtroComm === f.min ? "var(--amarelo)" : "var(--text-dim)",
                    transition: "all 0.12s",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Botoes de acao */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <button
              onClick={() => setMostrarRastro((v) => !v)}
              disabled={!cvSelecionado}
              style={{
                flex: 1,
                padding: "0.3rem 0",
                borderRadius: "0.375rem",
                border: `1px solid ${mostrarRastro ? "var(--accent)" : "var(--border)"}`,
                cursor: cvSelecionado ? "pointer" : "not-allowed",
                fontSize: 10,
                fontWeight: 600,
                backgroundColor: mostrarRastro ? "var(--accent-dim)" : "transparent",
                color: mostrarRastro ? "var(--accent)" : "var(--text-dim)",
                opacity: !cvSelecionado ? 0.4 : 1,
              }}
            >
              Rastro
            </button>
            <button
              onClick={() => setMostrarParadas((v) => !v)}
              disabled={!cvSelecionado}
              style={{
                flex: 1,
                padding: "0.3rem 0",
                borderRadius: "0.375rem",
                border: `1px solid ${mostrarParadas ? "#f59e0b" : "var(--border)"}`,
                cursor: cvSelecionado ? "pointer" : "not-allowed",
                fontSize: 10,
                fontWeight: 600,
                backgroundColor: mostrarParadas ? "rgba(245,158,11,0.1)" : "transparent",
                color: mostrarParadas ? "#f59e0b" : "var(--text-dim)",
                opacity: !cvSelecionado ? 0.4 : 1,
              }}
            >
              Paradas
            </button>
            {cvSelecionado && (
              <button
                onClick={() => setPainelAberto((v) => !v)}
                style={{
                  flex: 1,
                  padding: "0.3rem 0",
                  borderRadius: "0.375rem",
                  border: `1px solid ${painelAberto ? "var(--verde)" : "var(--border)"}`,
                  cursor: "pointer",
                  fontSize: 10,
                  fontWeight: 600,
                  backgroundColor: painelAberto ? "rgba(34,197,94,0.1)" : "transparent",
                  color: painelAberto ? "var(--verde)" : "var(--text-dim)",
                }}
              >
                Telemetria
              </button>
            )}
          </div>

          {/* Centralizar e Limpar */}
          <div style={{ display: "flex", gap: 4 }}>
            <button
              onClick={() => setGatilhoBounds((g) => g + 1)}
              disabled={!cvSelecionado || pontosRastro.length === 0}
              style={{
                flex: 1,
                padding: "0.3rem 0",
                borderRadius: "0.375rem",
                border: "1px solid var(--border)",
                cursor: cvSelecionado && pontosRastro.length > 0 ? "pointer" : "not-allowed",
                fontSize: 10,
                fontWeight: 600,
                backgroundColor: "var(--bg)",
                color: "var(--text-muted)",
                opacity: !cvSelecionado || pontosRastro.length === 0 ? 0.35 : 1,
              }}
            >
              Centralizar
            </button>
            <button
              onClick={limparSelecao}
              disabled={!cvSelecionado}
              style={{
                flex: 1,
                padding: "0.3rem 0",
                borderRadius: "0.375rem",
                border: "1px solid var(--border)",
                cursor: cvSelecionado ? "pointer" : "not-allowed",
                fontSize: 10,
                fontWeight: 600,
                backgroundColor: "var(--bg)",
                color: "var(--text-muted)",
                opacity: !cvSelecionado ? 0.35 : 1,
              }}
            >
              Limpar
            </button>
          </div>

          {/* Indicador de carregamento */}
          {carregando && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-dim)", fontSize: 10 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  backgroundColor: "var(--accent)",
                }}
              />
              buscando...
            </div>
          )}
        </div>

        {/* Lista de grupos */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0.5rem 0" }}>
          {temGrupos
            ? gruposFiltrados.map((grupo) => {
                const expandido = gruposExpandidos.has(grupo.gvc);
                const cvGrupo = grupo.veiculos.map((v) => v.cv);
                const qtdChecked = cvGrupo.filter((cv) => cvsSelecionados.has(cv)).length;
                const todosMarcados = qtdChecked === cvGrupo.length;
                const nenhumMarcado = qtdChecked === 0;
                const indeterminado = !todosMarcados && !nenhumMarcado;
                const qtdNoMapa = veiculosMapa.filter((v) => cvGrupo.includes(v.cv)).length;

                return (
                  <div key={grupo.gvc}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0.4rem 0.75rem",
                        cursor: "pointer",
                        userSelect: "none",
                        borderBottom: "1px solid var(--border-subtle)",
                      }}
                      onClick={() => toggleGrupo(grupo.gvc)}
                    >
                      <input
                        type="checkbox"
                        checked={todosMarcados}
                        ref={(el) => {
                          if (el) el.indeterminate = indeterminado;
                        }}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleCvGrupo(cvGrupo, e.target.checked);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ cursor: "pointer", flexShrink: 0 }}
                      />
                      <span
                        style={{
                          color: "var(--text-dim)",
                          fontSize: 10,
                          transition: "transform 0.15s",
                          display: "inline-block",
                          transform: expandido ? "rotate(90deg)" : "rotate(0deg)",
                          flexShrink: 0,
                        }}
                      >
                        {"▶"}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--text-muted)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={grupo.gvn}
                      >
                        {grupo.gvn}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: "var(--text-dim)",
                          flexShrink: 0,
                          fontFamily: "var(--font-geist-mono, monospace)",
                        }}
                      >
                        ({qtdNoMapa})
                      </span>
                    </div>

                    {expandido && (
                      <div>
                        {grupo.veiculos
                          .filter((v) =>
                            busca.trim()
                              ? v.placa.toUpperCase().includes(busca.toUpperCase())
                              : true
                          )
                          .map((v) => {
                            const selecionado = cvSelecionado === v.cv;
                            const posicao = veiculosMapa.find((vm) => vm.cv === v.cv);
                            const cor = posicao ? corVeiculo(posicao) : "#57534e";
                            const visivelMapa = cvsSelecionados.has(v.cv);

                            return (
                              <div
                                key={v.cv}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  padding: "0.3rem 0.75rem 0.3rem 1.75rem",
                                  cursor: "pointer",
                                  backgroundColor: selecionado ? "var(--accent-dim)" : "transparent",
                                  borderLeft: selecionado ? "2px solid var(--accent)" : "2px solid transparent",
                                  transition: "all 0.1s",
                                }}
                                onClick={() => selecionarVeiculo(v)}
                              >
                                <input
                                  type="checkbox"
                                  checked={visivelMapa}
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    toggleCv(v.cv);
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ cursor: "pointer", flexShrink: 0 }}
                                />
                                <span
                                  style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: "50%",
                                    backgroundColor: cor,
                                    flexShrink: 0,
                                    border: "1px solid rgba(255,255,255,0.2)",
                                    display: "inline-block",
                                  }}
                                />
                                <span
                                  style={{
                                    fontSize: 12,
                                    fontFamily: "var(--font-geist-mono, monospace)",
                                    color: selecionado ? "var(--accent)" : "var(--text-muted)",
                                    letterSpacing: "0.06em",
                                    fontWeight: selecionado ? 700 : 400,
                                  }}
                                >
                                  {v.placa}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                );
              })
            : veiculos
                .filter((v) =>
                  busca.trim()
                    ? v.placa.toUpperCase().includes(busca.toUpperCase())
                    : true
                )
                .map((v) => {
                  const selecionado = cvSelecionado === v.cv;
                  const posicao = veiculosMapa.find((vm) => vm.cv === v.cv);
                  const cor = posicao ? corVeiculo(posicao) : "#57534e";
                  const visivelMapa = cvsSelecionados.has(v.cv);
                  return (
                    <div
                      key={v.cv}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0.3rem 0.75rem",
                        cursor: "pointer",
                        backgroundColor: selecionado ? "var(--accent-dim)" : "transparent",
                        borderLeft: selecionado ? "2px solid var(--accent)" : "2px solid transparent",
                      }}
                      onClick={() => selecionarVeiculo(v)}
                    >
                      <input
                        type="checkbox"
                        checked={visivelMapa}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleCv(v.cv);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ cursor: "pointer", flexShrink: 0 }}
                      />
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
                      <span
                        style={{
                          fontSize: 12,
                          fontFamily: "var(--font-geist-mono, monospace)",
                          color: selecionado ? "var(--accent)" : "var(--text-muted)",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {v.placa}
                      </span>
                    </div>
                  );
                })}
        </div>
      </div>

      {/* ============================================================
          COLUNA DIREITA: MAPA + LEGENDA
          ============================================================ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
        {/* Mapa */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {/* Painel de telemetria flutuante */}
          {cvSelecionado && painelAberto && placaSelecionada && (
            <PainelTelemetria
              placa={placaSelecionada}
              dados={telemetria}
              onFechar={() => setPainelAberto(false)}
            />
          )}

          <MapContainer
            center={[-22.9, -43.2]}
            zoom={10}
            preferCanvas
            style={{ height: "100%", width: "100%", background: "#0a0a0a" }}
          >
            {pontosRastro.length > 0 && (
              <AjustarBoundsRastro pontos={pontosRastro} gatilho={gatilhoBounds} />
            )}

            {googleApiKey ? (
              <TileLayer
                url="https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
                attribution="&copy; Google Maps"
                maxNativeZoom={20}
                maxZoom={21}
              />
            ) : (
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution="&copy; OpenStreetMap &copy; CARTO"
              />
            )}

            <LayersControl position="topright">
              {favelas && (
                <LayersControl.Overlay checked name="Favelas">
                  <GeoJSON
                    data={favelas}
                    style={{
                      color: "#ff2d2d",
                      weight: 1,
                      fillColor: "#ff2d2d",
                      fillOpacity: 0.22,
                      opacity: 0.7,
                    }}
                  />
                </LayersControl.Overlay>
              )}

              <LayersControl.Overlay checked name="Tiroteios (24h)">
                <LayerGroup>
                  {tiroteios.map((t, i) => (
                    <CircleMarker
                      key={`tiro${i}`}
                      center={[t.lat, t.lng]}
                      radius={t.recente ? 6 : 4}
                      pathOptions={{
                        color: t.recente ? "#ffffff" : "#fde68a",
                        weight: t.recente ? 2 : 1,
                        fillColor: t.recente ? "#ff6a00" : "#d97706",
                        fillOpacity: 1,
                      }}
                    >
                      <Popup>
                        <div style={{ fontWeight: 700, fontSize: 13, color: "#c2410c" }}>
                          Tiroteio{t.acaoPolicial ? " · acao policial" : ""}
                          {t.recente && (
                            <span style={{ marginLeft: 6, color: "#dc2626", fontSize: 11 }}>
                              AGORA
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, marginTop: 2 }}>
                          {t.bairro ? `${t.bairro}, ` : ""}{t.cidade}
                        </div>
                        <div style={{ fontSize: 12, marginTop: 2 }}>
                          {idadeTexto(t.idadeMin)} · {formatarDataHora(t.date)}
                        </div>
                        {t.motivo && (
                          <div style={{ fontSize: 12, marginTop: 2 }}>motivo: {t.motivo}</div>
                        )}
                        {t.vitimas > 0 && (
                          <div style={{ fontSize: 12, marginTop: 2, color: "#dc2626" }}>
                            {t.vitimas} vitima(s)
                          </div>
                        )}
                      </Popup>
                    </CircleMarker>
                  ))}
                </LayerGroup>
              </LayersControl.Overlay>

              {rouboCarga && (
                <LayersControl.Overlay name="Roubo de carga (municipio)">
                  <GeoJSON key="roubo" data={rouboCarga} style={estiloRoubo} onEachFeature={popupRoubo} />
                </LayersControl.Overlay>
              )}
            </LayersControl>

            {/* Todos os veiculos visiveis */}
            {veiculosVisiveis.map((v) => {
              if (v.lat === null || v.lng === null) return null;
              const selecionado = cvSelecionado === v.cv;
              const cor = corVeiculo(v);
              return (
                <Marker
                  key={v.cv}
                  position={[v.lat, v.lng]}
                  icon={selecionado ? iconeCaminhao(cor, true) : iconeVeiculo(cor, false)}
                  zIndexOffset={selecionado ? 1000 : 0}
                  eventHandlers={{
                    click: () => selecionarVeiculo({ placa: v.placa, cv: v.cv }),
                  }}
                >
                  <Popup>
                    <div style={{ fontFamily: "var(--font-geist-mono, monospace)", fontWeight: 700, fontSize: 13 }}>
                      {v.placa}
                    </div>
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                      {v.velocidade > 0 ? `${v.velocidade} km/h` : "parado"} ·{" "}
                      ignicao {v.ignicao ? "ligada" : "desligada"}
                    </div>
                    {v.atraso_min > 0 && (
                      <div style={{ fontSize: 11, color: "#d97706", marginTop: 2 }}>
                        sem comm ha {formatarDuracao(v.atraso_min)}
                      </div>
                    )}
                    {v.local && (
                      <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{v.local}</div>
                    )}
                    <a
                      href={`https://www.google.com/maps?q=${v.lat},${v.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 12, color: "#1d4ed8", display: "inline-block", marginTop: 4 }}
                    >
                      abrir no Google Maps
                    </a>
                  </Popup>
                </Marker>
              );
            })}

            {/* Rastro */}
            {mostrarRastro && pontosRastro.length > 1 && (
              <Polyline
                positions={pontosRastro}
                pathOptions={{ color: "#9fb3ce", weight: 2.5, opacity: 0.85 }}
              />
            )}

            {/* Inicio do rastro */}
            {mostrarRastro && pontosRastro.length > 0 && (
              <CircleMarker
                center={pontosRastro[0]}
                radius={5}
                pathOptions={{ color: "#22c55e", weight: 2, fillColor: "#22c55e", fillOpacity: 0.9 }}
              >
                <Popup>
                  <div style={{ fontWeight: 700, fontSize: 12, color: "#22c55e" }}>
                    Inicio do rastro
                  </div>
                  <div style={{ fontSize: 11, marginTop: 2, color: "#666" }}>
                    {horas < 24 ? `${horas}h` : horas === 24 ? "ultimo dia" : "ultimos 4 dias"}
                  </div>
                </Popup>
              </CircleMarker>
            )}

            {/* Paradas */}
            {mostrarParadas &&
              paradas.map((p, i) => (
                <CircleMarker
                  key={`stop${i}`}
                  center={[p.lat, p.lng]}
                  radius={p.tempoMin >= 30 ? 9 : 6}
                  pathOptions={{
                    color: p.tempoMin >= 30 ? "#f59e0b" : "#fbbf24",
                    weight: 2,
                    fillColor: p.tempoMin >= 30 ? "#f59e0b" : "#fde68a",
                    fillOpacity: 0.85,
                  }}
                >
                  <Popup>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#d97706" }}>
                      Parada: {formatarDuracao(p.tempoMin)}
                    </div>
                    {p.data && (
                      <div style={{ fontSize: 12, marginTop: 2 }}>{formatarDataHora(p.data)}</div>
                    )}
                    {p.local && (
                      <div style={{ fontSize: 12, marginTop: 2, color: "#666" }}>{p.local}</div>
                    )}
                  </Popup>
                </CircleMarker>
              ))}

            {/* Marcador de posicao ao vivo do veiculo selecionado */}
            {posValida && posAtual && (
              <Marker
                position={[posAtual.lat, posAtual.lng]}
                icon={iconeCaminhao(corIgnicao, true)}
                zIndexOffset={2000}
              >
                <Popup>
                  <div style={{ fontFamily: "var(--font-geist-mono, monospace)", fontWeight: 700, fontSize: 14 }}>
                    {placaSelecionada}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2 }}>
                    {parseInt(telemetria?.posicvelocidade ?? "0") > 0
                      ? `${parseInt(telemetria?.posicvelocidade ?? "0")} km/h`
                      : "parado"}{" "}
                    · ignicao{" "}
                    {telemetria?.posicignicao === "1" ? "ligada" : "desligada"}
                  </div>
                  <a
                    href={`https://www.google.com/maps?q=${posAtual.lat},${posAtual.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 12, color: "#1d4ed8", display: "inline-block", marginTop: 4 }}
                  >
                    abrir no Google Maps
                  </a>
                </Popup>
              </Marker>
            )}
          </MapContainer>
        </div>

        {/* Legenda */}
        <div
          style={{
            flexShrink: 0,
            padding: "0.5rem 1rem",
            backgroundColor: "var(--card)",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: "1.5rem",
            flexWrap: "wrap",
          }}
        >
          <LegendaItem cor="#22c55e" label="Em movimento" qtd={qtdEmMovimento} />
          <LegendaItem cor="#9fb3ce" label="Parado ligado" qtd={qtdParadoLigado} />
          <LegendaItem cor="#57534e" label="Sem comm" qtd={qtdSemComm} />
          <LegendaItem cor="#ef4444" label="Alerta" qtd={qtdAlerta} />
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>
            {veiculosVisiveis.length} visivel(s) de {veiculosMapa.length}
          </span>
        </div>
      </div>
    </div>
  );
}
