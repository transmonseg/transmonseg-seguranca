"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleMap, Marker, Polyline, Circle, Polygon, InfoWindow, useJsApiLoader } from "@react-google-maps/api";
import { type MapTokens } from "./tokens";

export interface VeiculoMapa {
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
  rumo?: number | null;
}

export interface Parada {
  data: string;
  local: string;
  tempoMin: number;
  lat: number;
  lng: number;
}

export interface PontoEntrega {
  lat: number;
  lng: number;
  raio: number;
  ordem: number;
  nome: string;
  feito: boolean;
  documento: string | null;
  identificador: string | null;
  dataInicio: string | null;
  dataRealizado: string | null;
  observacoes: string | null;
  rota: string | null;
  placa?: string;
}

export interface Tiroteio {
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

interface GeoJsonGeom {
  type: string;
  coordinates: unknown;
}

export interface GeoJsonCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: GeoJsonGeom | null;
    properties: Record<string, unknown> | null;
  }>;
}

export interface Props {
  veiculosMapa: VeiculoMapa[];
  cvSelecionado: string | null;
  mostrarRastro: boolean;
  mostrarParadas: boolean;
  rastro: [number, number][];
  paradas: Parada[];
  alvos: PontoEntrega[];
  alvosGlobais?: PontoEntrega[];
  favelas: GeoJsonCollection | null;
  tiroteios: Tiroteio[];
  rouboCarga: GeoJsonCollection | null;
  seguir: boolean;
  gatilhoFrota: number;
  flyPara: { lat: number; lng: number; gatilho: number } | null;
  zoomCmd: { zoom: number; g: number } | null;
  onVeiculoClick: (vm: VeiculoMapa) => void;
  onMapaVazioClick: () => void;
  onAlvoClick?: (alvo: PontoEntrega) => void;
  mapTokens: MapTokens;
  tema: "dark" | "light";
  satelite: boolean;
  onZoomChange?: (zoom: number) => void;
  onEtaChange?: (eta: number | null) => void;
}

const CENTER_DEFAULT = { lat: -22.9, lng: -43.2 };

const DARK_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#1a1a1a" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6b7280" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a1a1a" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#2d2d2d" }] },
  { featureType: "administrative.country", elementType: "labels.text.fill", stylers: [{ color: "#9ca3af" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#d1d5db" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#2c2c2c" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8a8a8a" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#313131" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3c3c3c" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#a8a29e" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0a0f1a" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#2d3748" }] },
];

function corVeiculo(v: VeiculoMapa, tok: MapTokens): string {
  if (v.nivel === "vermelho" || (v.tipo !== null && v.tipo !== "")) return tok.red;
  if (v.nivel === "amarelo") return tok.yellow;
  if (v.ignicao && v.velocidade > 0) return tok.green;
  if (v.ignicao && v.velocidade === 0) return tok.accent;
  return tok.dim;
}

function corRoubo(n: number): string {
  if (n >= 1000) return "#ef4444";
  if (n >= 300) return "#f87171";
  if (n >= 100) return "#fb923c";
  if (n >= 30)  return "#fbbf24";
  if (n >= 10)  return "#fde047";
  if (n >= 1)   return "#fef9c3";
  return "transparent";
}

// GeoJSON geometry → array of Google Maps polygon shapes (outer ring + holes)
function geoToPaths(geom: GeoJsonGeom): google.maps.LatLngLiteral[][][] {
  if (geom.type === "Polygon") {
    const coords = geom.coordinates as number[][][];
    return [coords.map(ring => ring.map(([lng, lat]) => ({ lat, lng })))];
  }
  if (geom.type === "MultiPolygon") {
    const coords = geom.coordinates as number[][][][];
    return coords.map(poly => poly.map(ring => ring.map(([lng, lat]) => ({ lat, lng }))));
  }
  return [];
}

// Waypoint dot SVG for rastro (constant pixel size)
function dotSvg(fill: string, stroke: string): string {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    `<svg width="10" height="10" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
      <circle cx="5" cy="5" r="4" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
    </svg>`
  )}`;
}

const DOT_RASTRO = dotSvg("#00e5ff", "#000");
const DOT_START  = dotSvg("#22c55e", "#064e1a");

function formatarDuracaoParada(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatarHoraParada(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function encodeForSvg(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Cópia exata do iconeStatus do V1 (MapaMonitor.tsx) adaptada para SVG data URL
function criarIcone(vm: VeiculoMapa, selecionado: boolean, tok: MapTokens, showLabel: boolean): google.maps.Icon {
  const cor = corVeiculo(vm, tok);
  const semComm = vm.atraso_min > 60;
  const temSeta = vm.velocidade > 5 && vm.rumo != null;

  if (selecionado) {
    // V1: círculo 44×44 com fundo escuro e borda colorida
    const height = showLabel ? 60 : 44;
    let labelSvg = "";
    if (showLabel) {
      labelSvg =
        `<rect x="2" y="46" width="40" height="13" rx="4" fill="rgba(0,0,0,0.85)"/>` +
        `<text x="22" y="55.5" text-anchor="middle" font-family="'Courier New',Courier,monospace" font-size="9" font-weight="700" fill="white" letter-spacing="0.8">${encodeForSvg(vm.placa)}</text>`;
    }
    const svg = `<svg width="44" height="${height}" viewBox="0 0 44 ${height}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="22" cy="22" r="22" fill="${cor}" opacity="0.15"/>
      <circle cx="22" cy="22" r="19" fill="rgba(4,4,8,0.96)" stroke="${cor}" stroke-width="3"/>
      <g transform="translate(10,10)" fill="none" stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="1" y="3" width="15" height="13"/>
        <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
        <circle cx="5.5" cy="18.5" r="2.5"/>
        <circle cx="18.5" cy="18.5" r="2.5"/>
      </g>
      ${labelSvg}
    </svg>`;
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize: new window.google.maps.Size(44, height),
      anchor: new window.google.maps.Point(22, 22),
    };
  }

  // V1: teardrop 30×38, caminho exato, truck translate(4,4) scale(0.85) stroke-width=3, stroke branco
  const alpha = semComm ? "0.5" : "1";

  if (showLabel) {
    // Canvas 64×52: teardrop centrado em x=32, pill larga o suficiente para placa Mercosul
    let setaSvgLabel = "";
    if (temSeta && vm.rumo != null) {
      const rumoRad = (vm.rumo * Math.PI) / 180;
      const x2 = (32 + Math.sin(rumoRad) * 9).toFixed(1);
      const y2 = (15 - Math.cos(rumoRad) * 9).toFixed(1);
      setaSvgLabel =
        `<line x1="32" y1="15" x2="${x2}" y2="${y2}" stroke="white" stroke-width="2.5" stroke-linecap="round" opacity="0.95"/>` +
        `<circle cx="${x2}" cy="${y2}" r="2" fill="white" opacity="0.95"/>`;
    }
    const svgLabel = `<svg width="64" height="52" viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg" opacity="${alpha}">
      <path d="M32 2 C24 2 19 8 19 15 C19 22 25 30 32 36 C39 30 45 22 45 15 C45 8 40 2 32 2 Z" fill="${cor}" stroke="white" stroke-width="1.5"/>
      <g transform="translate(21,4) scale(0.85)" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <rect x="1" y="3" width="15" height="13"/>
        <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
        <circle cx="5.5" cy="18.5" r="2.5"/>
        <circle cx="18.5" cy="18.5" r="2.5"/>
      </g>
      ${setaSvgLabel}
      <rect x="1" y="38" width="62" height="13" rx="4" fill="rgba(0,0,0,0.82)"/>
      <text x="32" y="47.5" text-anchor="middle" font-family="'Courier New',Courier,monospace" font-size="9" font-weight="700" fill="white" letter-spacing="0.8">${encodeForSvg(vm.placa)}</text>
    </svg>`;
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svgLabel)}`,
      scaledSize: new window.google.maps.Size(64, 52),
      anchor: new window.google.maps.Point(32, 36),
    };
  }

  // V1: seta de heading — cx=15, cy=15, len=9 no viewBox 30×38
  let setaSvg = "";
  if (temSeta && vm.rumo != null) {
    const rumoRad = (vm.rumo * Math.PI) / 180;
    const x2 = (15 + Math.sin(rumoRad) * 9).toFixed(1);
    const y2 = (15 - Math.cos(rumoRad) * 9).toFixed(1);
    setaSvg =
      `<line x1="15" y1="15" x2="${x2}" y2="${y2}" stroke="white" stroke-width="2.5" stroke-linecap="round" opacity="0.95"/>` +
      `<circle cx="${x2}" cy="${y2}" r="2" fill="white" opacity="0.95"/>`;
  }

  const svg = `<svg width="30" height="38" viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg" opacity="${alpha}">
    <path d="M15 2 C7 2 2 8 2 15 C2 22 8 30 15 36 C22 30 28 22 28 15 C28 8 23 2 15 2 Z" fill="${cor}" stroke="white" stroke-width="1.5"/>
    <g transform="translate(4,4) scale(0.85)" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <rect x="1" y="3" width="15" height="13"/>
      <polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
      <circle cx="5.5" cy="18.5" r="2.5"/>
      <circle cx="18.5" cy="18.5" r="2.5"/>
    </g>
    ${setaSvg}
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new window.google.maps.Size(30, 38),
    anchor: new window.google.maps.Point(15, 36),
  };
}

// Ponto de entrega — círculo colorido simples, sem número
function criarIconeAlvo(feito: boolean, proximo: boolean): google.maps.Icon {
  let svg: string;
  let size: number;

  if (feito) {
    // Feito: círculo médio cinza-claro com checkmark interno
    size = 18;
    const half = size / 2;
    svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${half}" cy="${half}" r="7.5" fill="#9ca3af" stroke="white" stroke-width="1.5" opacity="0.85"/>
      <polyline points="5.5,9 8,11.5 12.5,6.5" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    </svg>`;
  } else if (proximo) {
    // Próximo: anel externo + ponto central laranja para destacar no mapa
    size = 28;
    const half = size / 2;
    svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${half}" cy="${half}" r="13" fill="#f97316" fill-opacity="0.18" stroke="#f97316" stroke-width="1.5"/>
      <circle cx="${half}" cy="${half}" r="7" fill="#f97316" stroke="white" stroke-width="2"/>
    </svg>`;
  } else {
    // Pendente normal: círculo laranja mais visível
    size = 18;
    const half = size / 2;
    svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${half}" cy="${half}" r="7.5" fill="#fb923c" stroke="white" stroke-width="1.5"/>
    </svg>`;
  }

  const half = size / 2;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new window.google.maps.Size(size, size),
    anchor: new window.google.maps.Point(half, half),
  };
}

export default function MapaLeafletV2({
  veiculosMapa, cvSelecionado, mostrarRastro, mostrarParadas,
  rastro, paradas, alvos, alvosGlobais, favelas, tiroteios, rouboCarga,
  seguir, gatilhoFrota, flyPara, zoomCmd,
  onVeiculoClick, onMapaVazioClick, onAlvoClick,
  mapTokens, tema, satelite, onZoomChange, onEtaChange,
}: Props) {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
    id: "transmonseg-google-maps",
  });

  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [paradaSelecionada, setParadaSelecionada] = useState<Parada | null>(null);
  const [alvoSelecionado, setAlvoSelecionado] = useState<PontoEntrega | null>(null);
  const [zoomLocal, setZoomLocal] = useState(11);
  const showLabel = zoomLocal >= 14;
  const [etaMinutos, setEtaMinutos] = useState<number | null>(null);
  const prevFlyG   = useRef(-1);
  const prevZoomG  = useRef(0);
  const prevFrotaG = useRef(-1);
  const lastPanKey = useRef("");
  const rastroLinesRef = useRef<google.maps.Polyline[]>([]);
  const routeLinesRef  = useRef<google.maps.Polyline[]>([]);
  const alvosGlobaisMarkersRef = useRef<google.maps.Marker[]>([]);

  // Controla o rastro de forma imperativa para garantir limpeza quando cvSelecionado vai a null.
  // @react-google-maps/api tem bug no React 18: Polyline declarativo não chama setMap(null) ao desmontar.
  useEffect(() => {
    rastroLinesRef.current.forEach(p => p.setMap(null));
    rastroLinesRef.current = [];
    if (!map || !cvSelecionado || !mostrarRastro || rastro.length <= 1) return;
    const path = rastro.map(([lat, lng]) => ({ lat, lng }));
    // Seta de direção a cada ~80px ao longo do rastro
    const arrowIcon: google.maps.Symbol = {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 2.5,
      fillColor: "#00e5ff",
      fillOpacity: 1,
      strokeColor: "#000",
      strokeWeight: 0.8,
      strokeOpacity: 0.7,
    };
    const outer = new google.maps.Polyline({ map, path, strokeColor: "#000000", strokeWeight: 7, strokeOpacity: 0.7, geodesic: true, zIndex: 4 });
    const inner = new google.maps.Polyline({
      map, path, strokeColor: "#00e5ff", strokeWeight: 3.5, strokeOpacity: 1, geodesic: true, zIndex: 5,
      icons: [{ icon: arrowIcon, offset: "20px", repeat: "80px" }],
    });
    rastroLinesRef.current = [outer, inner];
    return () => {
      outer.setMap(null);
      inner.setMap(null);
      rastroLinesRef.current = [];
    };
  }, [map, cvSelecionado, mostrarRastro, rastro]);

  const onLoad = useCallback((m: google.maps.Map) => {
    setMap(m);
    // Injeta CSS para sobrescrever o fundo branco nativo do InfoWindow do Google Maps
    if (!document.getElementById("tmsg-iw-dark")) {
      const s = document.createElement("style");
      s.id = "tmsg-iw-dark";
      s.textContent = [
        ".gm-style .gm-style-iw-c{background:#111!important;border:1px solid #2a2a2a!important;border-radius:8px!important;padding:0!important;box-shadow:0 2px 14px rgba(0,0,0,.85)!important}",
        ".gm-style .gm-style-iw-d{overflow:hidden!important}",
        ".gm-style .gm-style-iw-tc::after{background:#111!important}",
        ".gm-style .gm-ui-hover-effect{display:none!important}",
        ".gm-style .gm-style-iw-chr{display:none!important}",
      ].join("");
      document.head.appendChild(s);
    }
  }, []);
  const onUnmount = useCallback(() => setMap(null), []);

  useEffect(() => {
    if (!map || !flyPara || flyPara.gatilho === prevFlyG.current) return;
    prevFlyG.current = flyPara.gatilho;
    map.panTo({ lat: flyPara.lat, lng: flyPara.lng });
    map.setZoom(16);
    const t = setTimeout(() => { if (map) map.panBy(0, 90); }, 320);
    return () => clearTimeout(t);
  }, [map, flyPara]);

  useEffect(() => {
    if (!map || !zoomCmd || zoomCmd.g === prevZoomG.current) return;
    prevZoomG.current = zoomCmd.g;
    map.setZoom(zoomCmd.zoom);
  }, [map, zoomCmd]);

  useEffect(() => {
    if (!map || gatilhoFrota === prevFrotaG.current) return;
    prevFrotaG.current = gatilhoFrota;
    const pts = veiculosMapa.filter(v => v.lat != null && v.lng != null);
    if (pts.length === 0) return;
    const bounds = new window.google.maps.LatLngBounds();
    pts.forEach(v => bounds.extend({ lat: v.lat!, lng: v.lng! }));
    map.fitBounds(bounds, 48);
  }, [map, gatilhoFrota, veiculosMapa]);

  const vmSelecionado = cvSelecionado ? veiculosMapa.find(v => v.cv === cvSelecionado) : null;
  useEffect(() => {
    if (!map || !seguir || !vmSelecionado?.lat || !vmSelecionado?.lng) return;
    const k = `${vmSelecionado.lat.toFixed(5)},${vmSelecionado.lng.toFixed(5)}`;
    if (k === lastPanKey.current) return;
    lastPanKey.current = k;
    map.panTo({ lat: vmSelecionado.lat, lng: vmSelecionado.lng });
  }, [map, seguir, vmSelecionado]);

  const veiculosComPos = veiculosMapa.filter(v => v.lat != null && v.lng != null);

  // Precompute alvo data
  const primeiroPendente = alvos.findIndex(a => !a.feito);
  const alvosPendentes = alvos.filter(a => !a.feito && (a.lat !== 0 || a.lng !== 0)).sort((a, b) => a.ordem - b.ordem);

  // Linha pontilhada apenas veículo → próxima entrega (primeiro pendente com coordenada)
  const routeWaypoints: google.maps.LatLngLiteral[] | null = (() => {
    if (!vmSelecionado?.lat || !vmSelecionado?.lng) return null;
    const next = alvosPendentes[0];
    if (!next || (next.lat === 0 && next.lng === 0)) return null;
    return [
      { lat: vmSelecionado.lat, lng: vmSelecionado.lng },
      { lat: next.lat, lng: next.lng },
    ];
  })();

  // Linha pontilhada de rota com ETA via Directions API — imperativa pelo mesmo bug do Polyline declarativo no React 18.
  useEffect(() => {
    routeLinesRef.current.forEach(p => p.setMap(null));
    routeLinesRef.current = [];
    if (!map || !routeWaypoints || routeWaypoints.length < 2) {
      setEtaMinutos(null);
      onEtaChange?.(null);
      return;
    }

    // Desenha linha reta imediatamente (feedback visual instantâneo)
    const drawLines = (path: google.maps.LatLngLiteral[]) => {
      routeLinesRef.current.forEach(p => p.setMap(null));
      routeLinesRef.current = [];
      const dashIcon: google.maps.Symbol = { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 4 };
      const outer = new google.maps.Polyline({
        map, path, strokeColor: "#000000", strokeWeight: 4, strokeOpacity: 0, geodesic: true, zIndex: 10,
        icons: [{ icon: { ...dashIcon, strokeColor: "#000000", strokeOpacity: 0.55 }, offset: "0", repeat: "14px" }],
      });
      const inner = new google.maps.Polyline({
        map, path, strokeColor: "#f97316", strokeWeight: 2, strokeOpacity: 0, geodesic: true, zIndex: 11,
        icons: [{ icon: { ...dashIcon, strokeColor: "#f97316", strokeOpacity: 0.9 }, offset: "0", repeat: "14px" }],
      });
      routeLinesRef.current = [outer, inner];
    };

    drawLines(routeWaypoints);

    // ETA por haversine ÷ 25 km/h (velocidade média urbana) — sem API externa
    const o = routeWaypoints[0];
    const d = routeWaypoints[1];
    const R = 6_371_000;
    const toR = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toR(d.lat - o.lat);
    const dLng = toR(d.lng - o.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(o.lat)) * Math.cos(toR(d.lat)) * Math.sin(dLng / 2) ** 2;
    const distM = 2 * R * Math.asin(Math.sqrt(a));
    const eta = Math.ceil(distM / (25_000 / 3600) / 60);
    setEtaMinutos(eta);
    onEtaChange?.(eta);

    return () => {
      routeLinesRef.current.forEach(p => p.setMap(null));
      routeLinesRef.current = [];
    };
  }, [map, routeWaypoints]); // eslint-disable-line react-hooks/exhaustive-deps

  // Marcadores globais de entregas — imperativos para não travar React com 300+ markers
  useEffect(() => {
    alvosGlobaisMarkersRef.current.forEach(m => m.setMap(null));
    alvosGlobaisMarkersRef.current = [];
    const lista = alvosGlobais ?? [];
    if (!map || cvSelecionado || lista.length === 0) return;
    const markers = lista
      .filter(a => !(a.lat === 0 && a.lng === 0))
      .map(alvo => {
        const feito = alvo.feito;
        const size = feito ? 16 : 16;
        const half = size / 2;
        const svg = feito
          ? `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${half}" cy="${half}" r="6.5" fill="#9ca3af" stroke="white" stroke-width="1.5" opacity="0.85"/><polyline points="4.5,8 7,10.5 11.5,5.5" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/></svg>`
          : `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${half}" cy="${half}" r="6.5" fill="#fb923c" stroke="white" stroke-width="1.5"/></svg>`;
        const m = new google.maps.Marker({
          position: { lat: alvo.lat, lng: alvo.lng },
          map,
          icon: {
            url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
            scaledSize: new google.maps.Size(size, size),
            anchor: new google.maps.Point(half, half),
          },
          title: alvo.nome || (feito ? "Entregue" : "Pendente"),
          zIndex: feito ? 10 : 13,
          clickable: true,
        });
        m.addListener("click", () => {
          setAlvoSelecionado(alvo);
          setParadaSelecionada(null);
        });
        return m;
      });
    alvosGlobaisMarkersRef.current = markers;
    return () => {
      markers.forEach(m => m.setMap(null));
      alvosGlobaisMarkersRef.current = [];
    };
  }, [map, cvSelecionado, alvosGlobais]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rastro waypoint dots every 15 positions (capped for performance)
  const rastroWaypoints = mostrarRastro
    ? rastro.filter((_, i) => i % 15 === 0 && i > 0).slice(0, 60)
    : [];

  if (!isLoaded) {
    return (
      <div style={{
        width: "100%", height: "100%",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: mapTokens.bg,
      }}>
        <span style={{ color: mapTokens.muted, fontSize: 13 }}>Carregando mapa...</span>
      </div>
    );
  }

  const dotIcon = {
    url: DOT_RASTRO,
    scaledSize: new window.google.maps.Size(10, 10),
    anchor: new window.google.maps.Point(5, 5),
  };
  const startIcon = {
    url: DOT_START,
    scaledSize: new window.google.maps.Size(10, 10),
    anchor: new window.google.maps.Point(5, 5),
  };

  // Dashed line icon sequence for route
  const dashSeq = [{
    icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 4 } as google.maps.Symbol,
    offset: "0",
    repeat: "14px",
  }];

  return (
    <GoogleMap
      mapContainerStyle={{ width: "100%", height: "100%" }}
      center={CENTER_DEFAULT}
      zoom={11}
      onLoad={onLoad}
      onUnmount={onUnmount}
      onClick={() => { setParadaSelecionada(null); setAlvoSelecionado(null); onMapaVazioClick(); }}
      onZoomChanged={() => { if (map) { const z = map.getZoom() ?? 11; setZoomLocal(z); onZoomChange?.(z); } }}
      options={{
        mapTypeId: satelite ? "hybrid" : "roadmap",
        disableDefaultUI: true,
        clickableIcons: false,
        gestureHandling: "greedy",
        styles: (!satelite && tema === "dark") ? DARK_STYLES : [],
      }}
    >
      {/* ── Roubo de carga (coroplético por município) ── */}
      {rouboCarga?.features.flatMap((f, fi) => {
        if (!f.geometry) return [];
        const n = Number(f.properties?.roubo_carga ?? 0);
        if (n === 0) return [];
        const cor = corRoubo(n);
        return geoToPaths(f.geometry).map((paths, pi) => (
          <Polygon
            key={`rc-${fi}-${pi}`}
            paths={paths}
            options={{
              fillColor: cor,
              fillOpacity: 0.22,
              strokeColor: "#b91c1c",
              strokeWeight: 0.4,
              strokeOpacity: 0.4,
              clickable: false,
              zIndex: 1,
            }}
          />
        ));
      })}

      {/* ── Favelas (perímetro de risco) ── */}
      {favelas?.features.flatMap((f, fi) => {
        if (!f.geometry) return [];
        return geoToPaths(f.geometry).map((paths, pi) => (
          <Polygon
            key={`fav-${fi}-${pi}`}
            paths={paths}
            options={{
              fillColor: "#ff2d2d",
              fillOpacity: 0.18,
              strokeColor: "#ff2d2d",
              strokeWeight: 1,
              strokeOpacity: 0.65,
              clickable: false,
              zIndex: 2,
            }}
          />
        ));
      })}

      {/* ── Tiroteios (Fogo Cruzado, 24h) ── */}
      {tiroteios.map((t, i) => (
        <Circle
          key={`tiro-${i}`}
          center={{ lat: t.lat, lng: t.lng }}
          radius={t.recente ? 55 : 35}
          options={{
            fillColor:    t.recente ? "#ff6a00" : "#d97706",
            fillOpacity:  1,
            strokeColor:  t.recente ? "#ffffff" : "#fde68a",
            strokeWeight: t.recente ? 2 : 1,
            strokeOpacity: 1,
            clickable: false,
            zIndex: 3,
          }}
        />
      ))}

      {/* rastro gerenciado imperativamente via useEffect + rastroLinesRef */}

      {/* ── Waypoints do rastro (dot a cada 15 posições) ── */}
      {cvSelecionado && rastroWaypoints.map(([lat, lng], i) => (
        <Marker
          key={`wp-${i}`}
          position={{ lat, lng }}
          icon={dotIcon}
          clickable={false}
          zIndex={6}
        />
      ))}

      {/* ── Início do rastro ── */}
      {cvSelecionado && mostrarRastro && rastro.length > 0 && (
        <Marker
          position={{ lat: rastro[0][0], lng: rastro[0][1] }}
          icon={startIcon}
          title="Início do rastro"
          clickable={false}
          zIndex={7}
        />
      )}

      {/* ── Paradas (SVG dot pixel-size, igual ao CircleMarker do V1) ── */}
      {cvSelecionado && mostrarParadas && paradas.map(p => {
        const grande = p.tempoMin >= 30;
        const cor    = grande ? "#f59e0b" : "#fbbf24";
        const fill   = grande ? "#f59e0b" : "#fde68a";
        const size   = grande ? 18 : 12;
        const r      = size / 2;
        const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
          <circle cx="${r}" cy="${r}" r="${r - 1}" fill="${fill}" stroke="${cor}" stroke-width="2" opacity="0.85"/>
        </svg>`;
        return (
          <Marker
            key={`${p.lat.toFixed(5)},${p.lng.toFixed(5)},${p.data}`}
            position={{ lat: p.lat, lng: p.lng }}
            icon={{
              url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
              scaledSize: new window.google.maps.Size(size, size),
              anchor: new window.google.maps.Point(r, r),
            }}
            title={`Parada: ${formatarDuracaoParada(p.tempoMin)}`}
            clickable={true}
            zIndex={8}
            onClick={() => setParadaSelecionada(p)}
          />
        );
      })}

      {/* linha pontilhada gerenciada imperativamente via useEffect + routeLinesRef */}

      {/* ── Pontos de entrega (só quando há veículo selecionado) ── */}
      {cvSelecionado && alvos.map((alvo, i) => {
        if (alvo.lat === 0 && alvo.lng === 0) return null;
        const proximo = i === primeiroPendente;
        return (
          <Marker
            key={`alvo-${i}`}
            position={{ lat: alvo.lat, lng: alvo.lng }}
            icon={criarIconeAlvo(alvo.feito, proximo)}
            title={alvo.nome || (alvo.feito ? "Entregue" : "Pendente")}
            zIndex={proximo ? 15 : 12}
            clickable={true}
            onClick={() => { setAlvoSelecionado(alvo); setParadaSelecionada(null); }}
          />
        );
      })}

      {/* ── Popup de informação da parada selecionada ── */}
      {cvSelecionado && paradaSelecionada && (
        <InfoWindow
          position={{ lat: paradaSelecionada.lat, lng: paradaSelecionada.lng }}
          onCloseClick={() => setParadaSelecionada(null)}
          options={{ pixelOffset: new window.google.maps.Size(0, -14), disableAutoPan: true }}
        >
          <div style={{
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            background: "#111", color: "#e5e5e5",
            padding: "10px 14px 10px 12px", minWidth: 160, maxWidth: 230, lineHeight: 1.5,
            borderRadius: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#f59e0b" }}>
                {formatarDuracaoParada(paradaSelecionada.tempoMin)}
              </span>
              <button
                onClick={() => setParadaSelecionada(null)}
                style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: "0 0 0 8px", lineHeight: 1 }}
              >×</button>
            </div>
            {paradaSelecionada.data && (
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: paradaSelecionada.local ? 4 : 0 }}>
                {formatarHoraParada(paradaSelecionada.data)}
              </div>
            )}
            {paradaSelecionada.local && (
              <div style={{ fontSize: 11, color: "#d1d5db", lineHeight: 1.4 }}>
                {paradaSelecionada.local}
              </div>
            )}
          </div>
        </InfoWindow>
      )}

      {/* ── Popup do ponto de entrega clicado ── */}
      {alvoSelecionado && (
        <InfoWindow
          position={{ lat: alvoSelecionado.lat, lng: alvoSelecionado.lng }}
          onCloseClick={() => setAlvoSelecionado(null)}
          options={{ pixelOffset: new window.google.maps.Size(0, -14), disableAutoPan: true }}
        >
          <div style={{
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            background: "#111", color: "#e5e5e5",
            padding: "10px 14px 10px 12px", minWidth: 180, maxWidth: 260, lineHeight: 1.5,
            borderRadius: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: alvoSelecionado.feito ? "#22c55e" : "#f97316" }}>
                {alvoSelecionado.feito ? "Entregue" : `Pendente #${alvoSelecionado.ordem + 1}`}
              </span>
              <button onClick={() => setAlvoSelecionado(null)}
                style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, padding: "0 0 0 8px", lineHeight: 1 }}>×</button>
            </div>
            {alvoSelecionado.placa && (
              <div style={{ fontSize: 10, color: "#9ca3af", letterSpacing: ".07em", marginBottom: 4 }}>
                {alvoSelecionado.placa}
              </div>
            )}
            {alvoSelecionado.nome && (
              <div style={{ fontSize: 12, color: "#f3f4f6", fontWeight: 600, marginBottom: 4 }}>
                {alvoSelecionado.nome}
              </div>
            )}
            {alvoSelecionado.rota && (
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>
                Rota: {alvoSelecionado.rota}
              </div>
            )}
            {alvoSelecionado.documento && (
              <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 2 }}>
                Doc: {alvoSelecionado.documento}
              </div>
            )}
            {alvoSelecionado.dataRealizado && (
              <div style={{ fontSize: 10, color: "#22c55e", marginTop: 4 }}>
                Feito: {formatarHoraParada(alvoSelecionado.dataRealizado)}
              </div>
            )}
            {alvoSelecionado.dataInicio && !alvoSelecionado.feito && (
              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4 }}>
                Previsto: {formatarHoraParada(alvoSelecionado.dataInicio)}
              </div>
            )}
            {alvoSelecionado.observacoes && (
              <div style={{ fontSize: 10, color: "#d1d5db", marginTop: 4, fontStyle: "italic" }}>
                {alvoSelecionado.observacoes}
              </div>
            )}
          </div>
        </InfoWindow>
      )}

      {/* ── Ring de alerta crítico ao redor de veículos em nível vermelho ── */}
      {veiculosComPos
        .filter(vm => (vm.nivel === "vermelho" || (vm.tipo !== null && vm.tipo !== "")) && vm.cv !== cvSelecionado)
        .map(vm => (
          <Circle
            key={`ring-${vm.cv}`}
            center={{ lat: vm.lat!, lng: vm.lng! }}
            radius={28}
            options={{
              fillColor: "#ef4444",
              fillOpacity: 0.12,
              strokeColor: "#ef4444",
              strokeWeight: 1.5,
              strokeOpacity: 0.55,
              clickable: false,
              zIndex: 49,
            }}
          />
        ))
      }

      {/* ── Veículos ── */}
      {veiculosComPos.map(vm => {
        const selecionado = vm.cv === cvSelecionado;
        const dimmed = cvSelecionado !== null && !selecionado;
        return (
          <Marker
            key={vm.cv}
            position={{ lat: vm.lat!, lng: vm.lng! }}
            icon={criarIcone(vm, selecionado, mapTokens, showLabel)}
            opacity={dimmed ? 0.3 : 1}
            zIndex={selecionado ? 999 : vm.nivel === "vermelho" ? 100 : 50}
            title={`${vm.placa} · ${vm.velocidade}km/h${vm.tipo ? ` · ${vm.tipo}` : ""}`}
            onClick={() => onVeiculoClick(vm)}
          />
        );
      })}
    </GoogleMap>
  );
}
