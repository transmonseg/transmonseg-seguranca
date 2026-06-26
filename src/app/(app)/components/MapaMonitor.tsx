"use client";

/**
 * MapaMonitor.tsx
 * Monitor de frota ao estilo Unitrac: sidebar com grupos colapsaveis,
 * filtros de periodo e comunicacao, mapa com todos os veiculos em tempo real,
 * rastro/paradas ao selecionar, painel de telemetria flutuante.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
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

interface PontoEntregaUI {
  lat: number;
  lng: number;
  raio: number;
  ordem: number;
  nome: string;
  feito: boolean;
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
  clientes: { id: string; nome: string; cod: string }[];
  clienteAtivoId: string;
  mostrarSidebar?: boolean;
  flyParaAlerta?: { lat: number; lng: number; gatilho: number } | null;
  onVeiculoComAlertaClicado?: (cv: string, placa: string) => void;
}

/* ------------------------------------------------------------------ */
/* Constantes                                                           */
/* ------------------------------------------------------------------ */

const PERIODOS = [
  { label: "1h",  horas: 1 },
  { label: "2h",  horas: 2 },
  { label: "6h",  horas: 6 },
  { label: "12h", horas: 12 },
  { label: "24h", horas: 24 },
  { label: "48h", horas: 48 },
] as const;

type HorasPeriodo = (typeof PERIODOS)[number]["horas"];

const FILTROS_COMM = [
  { label: "10 min", min: 10 },
  { label: "30 min", min: 30 },
  { label: "60 min", min: 60 },
] as const;

const SIDEBAR_W = 280;

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

// Icone de ponto de entrega (alvo) — circulo numerado, laranja=pendente, cinza=feito.
function iconeAlvo(numero: number, feito: boolean, proximo: boolean): L.DivIcon {
  const cor = feito ? "#6b7280" : proximo ? "#f97316" : "#fb923c";
  const size = feito ? 18 : proximo ? 24 : 20;
  const half = size / 2;
  const fontSize = feito ? 9 : proximo ? 12 : 10;
  const border = feito ? "1.5px solid rgba(255,255,255,0.4)" : "2px solid white";
  const opacity = feito ? "0.55" : "1";
  const html =
    `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${cor};` +
    `border:${border};opacity:${opacity};display:flex;align-items:center;justify-content:center;` +
    `font-family:monospace;font-size:${fontSize}px;font-weight:800;color:white;` +
    `box-shadow:0 2px 6px rgba(0,0,0,0.85);">` +
    `${numero}</div>`;
  return L.divIcon({ html, className: "", iconSize: [size, size], iconAnchor: [half, half], popupAnchor: [0, -half] });
}

function iconeStatus(v: VeiculoMapa, selecionado: boolean): L.DivIcon {
  const cor = corVeiculo(v);
  const semComm = v.atraso_min > 60;
  const chave = `truck-${cor}-${selecionado ? 1 : 0}-${semComm ? 1 : 0}`;
  if (_iconeCache[chave]) return _iconeCache[chave];

  let html: string;

  if (selecionado) {
    // Circulo de destaque com caminhao SVG e glow colorido
    const s = 44;
    html =
      `<div style="width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;` +
      `background:rgba(4,4,8,0.96);border:3px solid ${cor};border-radius:50%;` +
      `box-shadow:0 0 0 3px rgba(0,0,0,0.8),0 0 20px ${cor}99,0 4px 14px rgba(0,0,0,0.95)">` +
      `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `<rect x="1" y="3" width="15" height="13"/>` +
      `<polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>` +
      `<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>` +
      `</svg></div>`;
    const ic = L.divIcon({ html, className: "", iconSize: [s, s], iconAnchor: [s / 2, s / 2], popupAnchor: [0, -s / 2] });
    _iconeCache[chave] = ic;
    return ic;
  }

  // Todos os demais: pin GPS (teardrop) com caminhao dentro.
  // Cor muda por status; opacidade reduzida para sem comunicacao.
  const alpha = semComm ? "0.5" : "1";
  html =
    `<div style="width:30px;height:38px;opacity:${alpha}">` +
    `<svg width="30" height="38" viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg">` +
    // Pin colorido com borda branca fina
    `<path d="M15 2 C7 2 2 8 2 15 C2 22 8 30 15 36 C22 30 28 22 28 15 C28 8 23 2 15 2 Z" fill="${cor}" stroke="white" stroke-width="1.5"/>` +
    // Caminhao (Lucide truck, escalonado para caber no circulo do pin)
    `<g transform="translate(4,4) scale(0.85)" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="1" y="3" width="15" height="13"/>` +
    `<polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>` +
    `<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>` +
    `</g>` +
    `</svg></div>`;

  const ic = L.divIcon({ html, className: "", iconSize: [30, 38], iconAnchor: [15, 36], popupAnchor: [0, -36] });
  _iconeCache[chave] = ic;
  return ic;
}

function iconeStatusSelecionado(cor: string): L.DivIcon {
  const chave = `sel-${cor}`;
  if (_iconeCache[chave]) return _iconeCache[chave];
  const s = 38;
  const html =
    `<div style="width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;` +
    `background:rgba(8,8,12,0.95);border:2.5px solid ${cor};border-radius:50%;` +
    `box-shadow:0 0 0 3px rgba(8,8,12,0.6),0 0 14px ${cor}66">` +
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"` +
    ` stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="1" y="3" width="15" height="13"/>` +
    `<polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>` +
    `<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>` +
    `</svg></div>`;
  const ic = L.divIcon({ html, className: "", iconSize: [s, s], iconAnchor: [s / 2, s / 2], popupAnchor: [0, -s / 2] });
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

function AutoFlyAlerta({
  flyPara,
}: {
  flyPara: { lat: number; lng: number; gatilho: number } | null;
}) {
  const map = useMap();
  const ultimoGatilho = useRef(-1);

  useEffect(() => {
    if (!flyPara || flyPara.gatilho === ultimoGatilho.current) return;
    ultimoGatilho.current = flyPara.gatilho;
    map.flyTo([flyPara.lat, flyPara.lng], 16, { animate: true, duration: 1.2 });
  }, [flyPara, map]);

  return null;
}

// Enquadra toda a frota no mapa: uma vez no primeiro load e novamente
// sempre que `gatilho` muda (botao "Centralizar frota").
function AjustarBoundsFrota({
  pontos,
  gatilho,
}: {
  pontos: [number, number][];
  gatilho: number;
}) {
  const map = useMap();
  const jaAjustouLoad = useRef(false);
  const ultimoGatilho = useRef(0);

  useEffect(() => {
    const mudouGatilho = gatilho !== ultimoGatilho.current;
    if (jaAjustouLoad.current && !mudouGatilho) return;
    if (pontos.length === 0) return;
    ultimoGatilho.current = gatilho;
    jaAjustouLoad.current = true;
    try {
      map.fitBounds(L.latLngBounds(pontos), { padding: [50, 50], maxZoom: 14 });
    } catch {
      /* bounds invalido */
    }
  }, [pontos, gatilho, map]);

  return null;
}

/* ------------------------------------------------------------------ */
/* Componente principal                                                 */
/* ------------------------------------------------------------------ */

export default function MapaMonitor({
  veiculos,
  cliente,
  clientes,
  clienteAtivoId,
  mostrarSidebar = true,
  flyParaAlerta = null,
  onVeiculoComAlertaClicado,
}: Props) {
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

  /* ---- Bases (perimetros GeoJSON) ---- */
  const [basesGeo, setBasesGeo] = useState<GeoJSON.FeatureCollection | null>(null);

  /* ---- Calor de incidentes (30 dias) ---- */
  const [alertasGeo, setAlertasGeo] = useState<{ lat: number; lng: number }[]>([]);

  /* ---- Busca na sidebar ---- */
  const [busca, setBusca] = useState("");

  /* ---- Veiculo selecionado ---- */
  const [cvSelecionado, setCvSelecionado] = useState<string | null>(null);
  const [placaSelecionada, setPlacaSelecionada] = useState<string | null>(null);

  /* ---- Periodo ---- */
  const [horas, setHoras] = useState<HorasPeriodo>(24);
  const [dropdownPeriodoAberto, setDropdownPeriodoAberto] = useState(false);

  /* ---- Filtro de comunicacao (null = sem filtro) ---- */
  const [filtroComm, setFiltroComm] = useState<number | null>(null);

  /* ---- Dados do veiculo selecionado ---- */
  const [rastro, setRastro] = useState<PontRastro[]>([]);
  const [paradas, setParadas] = useState<Parada[]>([]);
  const [telemetria, setTelemetria] = useState<Telemetria | null>(null);
  const [alvos, setAlvos] = useState<PontoEntregaUI[]>([]);
  const [carregando, setCarregando] = useState(false);

  /* ---- Toggles de camada ---- */
  const [mostrarRastro, setMostrarRastro] = useState(true);
  const [mostrarParadas, setMostrarParadas] = useState(true);
  const [painelAberto, setPainelAberto] = useState(false);

  /* ---- Gatilho de fitBounds ---- */
  const [gatilhoBounds, setGatilhoBounds] = useState(0);

  /* ---- Gatilho de enquadrar frota inteira ---- */
  const [gatilhoFrota, setGatilhoFrota] = useState(0);

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
  /* Posicoes de todos os veiculos (refresh a cada 10s)                  */
  /* ------------------------------------------------------------------ */

  const carregarMapa = useCallback(() => {
    if (!cliente) return;
    fetch(`/api/mapa?cliente=${encodeURIComponent(cliente)}`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.veiculos)) {
          setVeiculosMapa(d.veiculos as VeiculoMapa[]);
        }
        if (d?.bases?.type === "FeatureCollection") {
          setBasesGeo(d.bases as GeoJSON.FeatureCollection);
        }
      })
      .catch(() => {});
  }, [cliente]);

  useEffect(() => {
    carregarMapa();
    const id = setInterval(carregarMapa, 10000);
    return () => clearInterval(id);
  }, [carregarMapa]);

  // Heatmap carregado uma vez ao montar (dado de 30 dias muda lentamente).
  // Separado do poll de 10s para nao executar query pesada em cada ciclo.
  useEffect(() => {
    if (!cliente) return;
    fetch(`/api/mapa?cliente=${encodeURIComponent(cliente)}&heat=1`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.alertas_geo)) {
          setAlertasGeo(d.alertas_geo as { lat: number; lng: number }[]);
        }
      })
      .catch(() => {});
  }, [cliente]);

  /* ------------------------------------------------------------------ */
  /* Auto-refresh de telemetria quando veiculo selecionado (15s)         */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!cvSelecionado) return;
    const id = setInterval(() => {
      fetch(`/api/veiculo?cv=${encodeURIComponent(cvSelecionado)}`)
        .then((r) => r.json())
        .then((d) => { if (d?.posicao) setTelemetria(d.posicao as Telemetria); })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [cvSelecionado]);

  /* ------------------------------------------------------------------ */
  /* Auto-refresh de rastro quando veiculo selecionado (2min)            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!cvSelecionado) return;
    const id = setInterval(() => {
      fetch(`/api/rastro?cv=${encodeURIComponent(cvSelecionado)}&horas=${horas}`)
        .then((r) => r.json())
        .then((d) => { if (Array.isArray(d?.pontos)) setRastro(d.pontos); })
        .catch(() => {});
    }, 120000);
    return () => clearInterval(id);
  }, [cvSelecionado, horas]);

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
    setAlvos([]);
    try {
      const [resRastro, resStops, resTel, resAlvos] = await Promise.all([
        fetch(`/api/rastro?cv=${encodeURIComponent(cv)}&horas=${h}`),
        fetch(`/api/stops?cv=${encodeURIComponent(cv)}&horas=${h}`),
        fetch(`/api/veiculo?cv=${encodeURIComponent(cv)}`),
        fetch(`/api/alvos?cv=${encodeURIComponent(cv)}`),
      ]);
      const [dRastro, dStops, dTel, dAlvos] = await Promise.all([
        resRastro.json(),
        resStops.json(),
        resTel.json(),
        resAlvos.json(),
      ]);
      if (Array.isArray(dRastro?.pontos)) setRastro(dRastro.pontos);
      if (Array.isArray(dStops?.paradas)) setParadas(dStops.paradas);
      if (dTel?.posicao) setTelemetria(dTel.posicao as Telemetria);
      if (Array.isArray(dAlvos?.pontos)) setAlvos(dAlvos.pontos as PontoEntregaUI[]);
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

  const onClickVeiculoMapa = useCallback(
    (vm: VeiculoMapa) => {
      setCvSelecionado(vm.cv);
      setPlacaSelecionada(vm.placa);
      setPainelAberto(true);
      setGatilhoBounds((g) => g + 1);
      if (onVeiculoComAlertaClicado) onVeiculoComAlertaClicado(vm.cv, vm.placa);
    },
    [onVeiculoComAlertaClicado]
  );

  const limparSelecao = useCallback(() => {
    setCvSelecionado(null);
    setPlacaSelecionada(null);
    setRastro([]);
    setParadas([]);
    setTelemetria(null);
    setAlvos([]);
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

  const pontosFrota: [number, number][] = veiculosVisiveis
    .filter((v) => v.lat !== null && v.lng !== null)
    .map((v) => [v.lat as number, v.lng as number]);

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
        height: "100%",
        minHeight: 480,
        overflow: "hidden",
      }}
    >
      {/* ============================================================
          SIDEBAR (oculta quando mostrarSidebar=false)
          ============================================================ */}
      {mostrarSidebar && <div
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
        {/* Seletor de cliente */}
        <div style={{ padding: "0.5rem 0.875rem", borderBottom: "1px solid var(--border)", display: "flex", gap: 4, flexWrap: "wrap" }}>
          {clientes.map((c) => (
            <Link
              key={c.id}
              href={`/monitoramento?cliente=${c.cod}`}
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
          <div style={{ position: "relative" }}>
            <p style={{ color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
              Período:
            </p>
            <button
              disabled={!cvSelecionado}
              onClick={() => setDropdownPeriodoAberto((v) => !v)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.3rem 0.6rem",
                borderRadius: "0.375rem",
                border: "1px solid var(--border)",
                cursor: cvSelecionado ? "pointer" : "not-allowed",
                fontSize: 12,
                fontWeight: 600,
                backgroundColor: "var(--bg)",
                color: "var(--accent)",
                opacity: !cvSelecionado ? 0.4 : 1,
              }}
            >
              <span>{PERIODOS.find((p) => p.horas === horas)?.label ?? `${horas}h`}</span>
              <svg width={10} height={10} viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0, transform: dropdownPeriodoAberto ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {dropdownPeriodoAberto && (
              <>
                {/* Backdrop para fechar ao clicar fora */}
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 49 }}
                  onClick={() => setDropdownPeriodoAberto(false)}
                />
                <div style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 50,
                  backgroundColor: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: "0.5rem",
                  overflow: "hidden",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                }}>
                  {PERIODOS.map((p) => (
                    <button
                      key={p.horas}
                      onClick={() => { setHoras(p.horas); setDropdownPeriodoAberto(false); }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "0.4rem 0.75rem",
                        border: "none",
                        borderBottom: "1px solid var(--border)",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: horas === p.horas ? 700 : 500,
                        backgroundColor: horas === p.horas ? "var(--accent-dim)" : "transparent",
                        color: horas === p.horas ? "var(--accent)" : "var(--text)",
                        transition: "background 0.1s",
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </>
            )}
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
      </div>}

      {/* ============================================================
          COLUNA DIREITA: MAPA + LEGENDA
          ============================================================ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
        {/* Mapa */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {/* Controles flutuantes (modo unificado, sem sidebar do mapa) */}
          {!mostrarSidebar && (
            <div
              style={{
                position: "absolute",
                top: 10,
                left: 10,
                zIndex: 1000,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                background: "rgba(6,8,16,0.9)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                padding: 8,
                backdropFilter: "blur(6px)",
              }}
            >
              <button
                onClick={() => setGatilhoFrota((g) => g + 1)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0.35rem 0.6rem",
                  borderRadius: 7,
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  backgroundColor: "var(--accent-dim)",
                  color: "var(--accent)",
                }}
                title="Enquadrar todos os veiculos"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                Ver toda a frota
              </button>

              <div>
                <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
                  Sem comunicacao
                </p>
                <div style={{ display: "flex", gap: 3 }}>
                  {FILTROS_COMM.map((f) => (
                    <button
                      key={f.min}
                      onClick={() => setFiltroComm((prev) => (prev === f.min ? null : f.min))}
                      style={{
                        flex: 1,
                        padding: "0.25rem 0.4rem",
                        borderRadius: 6,
                        border: "none",
                        cursor: "pointer",
                        fontSize: 10,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        backgroundColor: filtroComm === f.min ? "rgba(245,158,11,0.2)" : "rgba(255,255,255,0.06)",
                        color: filtroComm === f.min ? "var(--amarelo)" : "rgba(255,255,255,0.7)",
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <p style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-geist-mono, monospace)" }}>
                {veiculosVisiveis.length} de {veiculosMapa.length} no mapa
              </p>
            </div>
          )}

          {/* Legenda de status */}
          <div style={{
            position: "absolute", bottom: 28, left: 10, zIndex: 1000,
            background: "rgba(6,8,16,0.88)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8, padding: "8px 12px", backdropFilter: "blur(6px)",
            display: "flex", flexDirection: "column", gap: 5, pointerEvents: "none",
          }}>
            {[
              { cor: "#ef4444", label: "Alerta" },
              { cor: "#22c55e", label: "Em movimento" },
              { cor: "#9fb3ce", label: "Parado / ligado" },
              { cor: "#57534e", label: "Sem comunicacao" },
            ].map(({ cor, label }) => {
              const svg =
                `<svg width="16" height="20" viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg">` +
                `<path d="M15 2 C7 2 2 8 2 15 C2 22 8 30 15 36 C22 30 28 22 28 15 C28 8 23 2 15 2 Z" fill="${cor}" stroke="white" stroke-width="1.5"/>` +
                `<g transform="translate(4,4) scale(0.85)" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
                `<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>` +
                `<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>` +
                `</g></svg>`;
              return (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span dangerouslySetInnerHTML={{ __html: svg }} style={{ display: "flex", alignItems: "center", flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", fontWeight: 600, letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{label}</span>
                </div>
              );
            })}
          </div>

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
            {!cvSelecionado && (
              <AjustarBoundsFrota pontos={pontosFrota} gatilho={gatilhoFrota} />
            )}
            {flyParaAlerta && <AutoFlyAlerta flyPara={flyParaAlerta} />}

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

              <LayersControl.Overlay name="Calor de incidentes (30d)">
                <LayerGroup>
                  {alertasGeo.map((pt, i) => (
                    <CircleMarker
                      key={`heat${i}`}
                      center={[pt.lat, pt.lng]}
                      radius={18}
                      pathOptions={{
                        color: "transparent",
                        fillColor: "#ef4444",
                        fillOpacity: 0.07,
                      }}
                    />
                  ))}
                </LayerGroup>
              </LayersControl.Overlay>
            </LayersControl>

            {/* Perimetro das bases (sempre visivel) */}
            {basesGeo && (
              <GeoJSON
                key={`bases-${cliente}`}
                data={basesGeo}
                style={{
                  color: "#38bdf8",
                  weight: 2,
                  fillColor: "#38bdf8",
                  fillOpacity: 0.08,
                  opacity: 0.85,
                  dashArray: "6 4",
                }}
                onEachFeature={(feature, layer) => {
                  const nome = (feature.properties as { nome?: string })?.nome ?? "Base";
                  layer.bindPopup(nome);
                }}
              />
            )}

            {/* Todos os veiculos visiveis, individuais (estilo Unitrac) */}
            {veiculosVisiveis.map((vm) => {
              if (vm.lat === null || vm.lng === null) return null;
              const selecionado = cvSelecionado === vm.cv;
              return (
                <Marker
                  key={vm.cv}
                  position={[vm.lat, vm.lng]}
                  icon={iconeStatus(vm, selecionado)}
                  zIndexOffset={selecionado ? 1000 : 0}
                  eventHandlers={{ click: () => onClickVeiculoMapa(vm) }}
                />
              );
            })}

            {/* Rastro: contorno preto + linha ciano viva */}
            {mostrarRastro && pontosRastro.length > 1 && (
              <>
                {/* Contorno preto para legibilidade em qualquer tile */}
                <Polyline
                  positions={pontosRastro}
                  pathOptions={{ color: "#000", weight: 7, opacity: 0.7, lineCap: "round", lineJoin: "round" }}
                />
                {/* Linha ciano principal */}
                <Polyline
                  positions={pontosRastro}
                  pathOptions={{ color: "#00e5ff", weight: 3.5, opacity: 1, lineCap: "round", lineJoin: "round" }}
                />
                {/* Pontos de passagem a cada 10 posicoes */}
                {pontosRastro.filter((_, i) => i % 10 === 0 && i > 0).map((p, i) => (
                  <CircleMarker
                    key={`dir${i}`}
                    center={p}
                    radius={5}
                    pathOptions={{ color: "#000", weight: 2, fillColor: "#00e5ff", fillOpacity: 1 }}
                  />
                ))}
              </>
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
                    {horas < 24 ? `últimas ${horas}h` : horas === 24 ? "último dia" : `últimas ${horas}h`}
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

            {/* Pontos de entrega (alvos) do veiculo selecionado */}
            {(() => {
              if (alvos.length === 0) return null;
              const pendentes = alvos.filter((p) => !p.feito).sort((a, b) => a.ordem - b.ordem);
              const proximoOrdem = pendentes[0]?.ordem ?? -1;
              const waypoints: [number, number][] = [
                ...(posValida && posAtual ? [[posAtual.lat, posAtual.lng] as [number, number]] : []),
                ...pendentes.map((p) => [p.lat, p.lng] as [number, number]),
              ];
              return (
                <>
                  {/* Linha dashed: posicao atual -> proximos pontos em ordem */}
                  {waypoints.length >= 2 && (
                    <>
                      <Polyline
                        positions={waypoints}
                        pathOptions={{ color: "#000", weight: 4, opacity: 0.6, dashArray: "10 8", lineCap: "round" }}
                      />
                      <Polyline
                        positions={waypoints}
                        pathOptions={{ color: "#f97316", weight: 2, opacity: 0.9, dashArray: "10 8", lineCap: "round" }}
                      />
                    </>
                  )}
                  {/* Marcadores numerados */}
                  {alvos.sort((a, b) => a.ordem - b.ordem).map((p, i) => (
                    <Marker
                      key={`alvo-${p.ordem}-${i}`}
                      position={[p.lat, p.lng]}
                      icon={iconeAlvo(i + 1, p.feito, p.ordem === proximoOrdem)}
                    >
                      <Popup>
                        <div style={{ fontWeight: 700, fontSize: 13, color: p.feito ? "#6b7280" : "#f97316" }}>
                          {p.feito ? "Entregue" : "Pendente"} — #{i + 1}
                        </div>
                        {p.nome && (
                          <div style={{ fontSize: 12, marginTop: 2 }}>{p.nome}</div>
                        )}
                      </Popup>
                    </Marker>
                  ))}
                </>
              );
            })()}

            {/* Marcador de posicao ao vivo do veiculo selecionado */}
            {posValida && posAtual && (
              <Marker
                position={[posAtual.lat, posAtual.lng]}
                icon={iconeStatusSelecionado(corIgnicao)}
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
