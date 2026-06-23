"use client";

/**
 * MapaMonitor.tsx
 * Tela de rastreio historico por placa, ao estilo Unitrac.
 * Funcionalidades: selecao de placa, rastro em polyline, paradas com popup,
 * telemetria ao vivo, camadas de risco, toggle de periodo (1 dia / 4 dias).
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
/* Constantes de periodo                                                */
/* ------------------------------------------------------------------ */

const PERIODOS = [
  { label: "1 dia", horas: 24 },
  { label: "4 dias", horas: 96 },
] as const;

/* ------------------------------------------------------------------ */
/* Icone de caminhao (igual ao MapaFrota, adaptado)                    */
/* ------------------------------------------------------------------ */

const _iconeCache: Record<string, L.DivIcon> = {};

function iconeCaminhao(cor: string, destaque: boolean): L.DivIcon {
  const chave = `${cor}-${destaque}`;
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

/* ------------------------------------------------------------------ */
/* Fix do icone padrao do Leaflet (necessario com bundlers)            */
/* ------------------------------------------------------------------ */

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
/* Escalas de cor do roubo de carga (copiado do MapaFrota)            */
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
/* Sub-componente: ajusta o bounds do mapa ao rastro                   */
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
      /* ignora se bounds invalido */
    }
  }, [pontos, gatilho, map]);

  return null;
}

/* ------------------------------------------------------------------ */
/* Painel de telemetria (lateral flutuante)                            */
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

  // Entradas e saidas ligadas
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
      {/* Cabecalho */}
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
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: ignicao ? "var(--verde)" : "var(--text-dim)" }}
          />
          <span
            className="num-mono font-bold"
            style={{
              fontFamily: "var(--font-geist-mono, monospace)",
              color: "var(--text)",
              fontSize: "1rem",
              letterSpacing: "0.1em",
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

      {/* Corpo */}
      <div style={{ padding: "0.875rem 1rem", display: "flex", flexDirection: "column", gap: 10 }}>
        {dados === null ? (
          <p style={{ color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
            carregando telemetria...
          </p>
        ) : (
          <>
            {/* Velocidade e ignicao */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <p style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  velocidade
                </p>
                <p
                  className="num-mono font-bold"
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontSize: "1.25rem",
                    color: (velocidade ?? 0) > 0 ? "var(--accent)" : "var(--text-muted)",
                    lineHeight: 1,
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
                  className="font-semibold"
                  style={{
                    fontSize: "0.875rem",
                    color: ignicao ? "var(--verde)" : "var(--text-dim)",
                  }}
                >
                  {ignicao ? "ligada" : "desligada"}
                </p>
              </div>
            </div>

            {/* Ultimo evento */}
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

            {/* Atraso de comunicacao */}
            {atraso !== null && atraso > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: "var(--amarelo)" }}
                />
                <p style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  sem comunicacao ha {formatarDuracao(atraso)}
                </p>
              </div>
            )}

            {/* Sensores ativos */}
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
/* Componente principal: MapaMonitor                                    */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function MapaMonitor({ veiculos, cliente: _cliente }: Props) {
  // Fix dos icones padrao do Leaflet (feito uma vez)
  useEffect(() => { fixIcones(); }, []);

  // Estado de selecao de placa
  const [busca, setBusca] = useState("");
  const [cvSelecionado, setCvSelecionado] = useState<string | null>(null);
  const [placaSelecionada, setPlacaSelecionada] = useState<string | null>(null);
  const [listAberta, setListAberta] = useState(false);

  // Periodo: 24h ou 96h
  const [horas, setHoras] = useState<24 | 96>(24);

  // Dados buscados
  const [rastro, setRastro] = useState<PontRastro[]>([]);
  const [paradas, setParadas] = useState<Parada[]>([]);
  const [telemetria, setTelemetria] = useState<Telemetria | null>(null);
  const [carregando, setCarregando] = useState(false);

  // Toggles de camada
  const [mostrarRastro, setMostrarRastro] = useState(true);
  const [mostrarParadas, setMostrarParadas] = useState(true);
  const [painelAberto, setPainelAberto] = useState(false);

  // Gatilho de fitBounds (muda quando queremos centralizar)
  const [gatilhoBounds, setGatilhoBounds] = useState(0);

  // Camadas de risco
  const [favelas, setFavelas] = useState<GeoJSON.FeatureCollection | null>(null);
  const [tiroteios, setTiroteios] = useState<Tiroteio[]>([]);
  const [rouboCarga, setRouboCarga] = useState<GeoJSON.FeatureCollection | null>(null);

  // Posicao atual do veiculo selecionado (para o marcador no mapa)
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

  // Veiculos filtrados pelo campo de busca
  const veiculosFiltrados = veiculos.filter((v) =>
    v.placa.toUpperCase().includes(busca.toUpperCase())
  );

  /* ------------------------------------------------------------------ */
  /* Camadas de risco: carregam uma vez                                  */
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
  /* Fetch de rastro, paradas e telemetria ao selecionar placa/periodo  */
  /* ------------------------------------------------------------------ */

  const buscarDados = useCallback(async (cv: string, h: number) => {
    setCarregando(true);
    setRastro([]);
    setParadas([]);
    setTelemetria(null);

    try {
      const [resRastro, resStops, resTelemetria] = await Promise.all([
        fetch(`/api/rastro?cv=${encodeURIComponent(cv)}&horas=${h}`),
        fetch(`/api/stops?cv=${encodeURIComponent(cv)}&horas=${h}`),
        fetch(`/api/veiculo?cv=${encodeURIComponent(cv)}`),
      ]);

      const [dRastro, dStops, dTelemetria] = await Promise.all([
        resRastro.json(),
        resStops.json(),
        resTelemetria.json(),
      ]);

      if (Array.isArray(dRastro?.pontos)) setRastro(dRastro.pontos);
      if (Array.isArray(dStops?.paradas)) setParadas(dStops.paradas);
      if (dTelemetria?.posicao) setTelemetria(dTelemetria.posicao as Telemetria);
    } catch {
      /* falha silenciosa: o mapa fica vazio */
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (!cvSelecionado) return;
    buscarDados(cvSelecionado, horas);
  }, [cvSelecionado, horas, buscarDados]);

  /* ------------------------------------------------------------------ */
  /* Selecionar placa                                                     */
  /* ------------------------------------------------------------------ */

  const selecionarVeiculo = (v: VeiculoOpcao) => {
    setCvSelecionado(v.cv);
    setPlacaSelecionada(v.placa);
    setBusca(v.placa);
    setListAberta(false);
    setPainelAberto(true);
    // Centraliza no rastro apos busca completar
    setGatilhoBounds((g) => g + 1);
  };

  const limparSelecao = () => {
    setCvSelecionado(null);
    setPlacaSelecionada(null);
    setBusca("");
    setRastro([]);
    setParadas([]);
    setTelemetria(null);
    setPainelAberto(false);
  };

  /* ------------------------------------------------------------------ */
  /* Pontos do rastro para o Polyline / fitBounds                        */
  /* ------------------------------------------------------------------ */

  const pontosRastro: [number, number][] = rastro.map((p) => [p.lat, p.lng]);

  /* ------------------------------------------------------------------ */
  /* Basemap: Google opcional (so se a chave existir)                    */
  /* ------------------------------------------------------------------ */

  const googleApiKey =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
      : undefined;

  /* ------------------------------------------------------------------ */
  /* Centralizar no rastro ou na posicao atual                           */
  /* ------------------------------------------------------------------ */

  const centralizarNoRastro = () => {
    setGatilhoBounds((g) => g + 1);
  };

  /* ------------------------------------------------------------------ */
  /* Render                                                               */
  /* ------------------------------------------------------------------ */

  const corIgnicao = telemetria?.posicignicao === "1" ? "#22c55e" : "#9fb3ce";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

      {/* ============================================================
          BARRA DE CONTROLES
          ============================================================ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
          padding: "0.875rem 1rem",
          backgroundColor: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: "0.875rem",
        }}
      >
        {/* Campo de busca / selecao de placa */}
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: 180, maxWidth: 300 }}>
          <div style={{ position: "relative" }}>
            <input
              type="text"
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                setListAberta(true);
              }}
              onFocus={() => setListAberta(true)}
              onBlur={() => setTimeout(() => setListAberta(false), 200)}
              placeholder="Buscar placa..."
              style={{
                width: "100%",
                padding: "0.5rem 2.5rem 0.5rem 0.75rem",
                backgroundColor: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "0.625rem",
                color: "var(--text)",
                fontSize: 13,
                fontFamily: "var(--font-geist-mono, monospace)",
                letterSpacing: "0.06em",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {/* Botao limpar */}
            {busca && (
              <button
                onClick={limparSelecao}
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-dim)",
                  fontSize: 16,
                  lineHeight: 1,
                  padding: 2,
                }}
                title="Limpar selecao"
              >
                &times;
              </button>
            )}
          </div>

          {/* Lista de autocomplete */}
          {listAberta && veiculosFiltrados.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.625rem",
                overflow: "hidden",
                zIndex: 2000,
                maxHeight: 200,
                overflowY: "auto",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              }}
            >
              {veiculosFiltrados.map((v) => (
                <button
                  key={v.cv}
                  onMouseDown={() => selecionarVeiculo(v)}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "0.5rem 0.75rem",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "var(--text)",
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontSize: 13,
                    letterSpacing: "0.06em",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  {v.placa}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Divisor */}
        <div style={{ width: 1, height: 28, backgroundColor: "var(--border)", flexShrink: 0 }} />

        {/* Toggle de periodo */}
        <div
          style={{
            display: "flex",
            gap: 2,
            backgroundColor: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "0.625rem",
            padding: 2,
          }}
        >
          {PERIODOS.map((p) => (
            <button
              key={p.horas}
              onClick={() => setHoras(p.horas as 24 | 96)}
              disabled={!cvSelecionado}
              style={{
                padding: "0.375rem 0.75rem",
                borderRadius: "0.5rem",
                border: "none",
                cursor: cvSelecionado ? "pointer" : "not-allowed",
                fontSize: 12,
                fontWeight: 600,
                transition: "all 0.15s",
                backgroundColor: horas === p.horas ? "var(--accent-dim)" : "transparent",
                color: horas === p.horas ? "var(--accent)" : "var(--text-dim)",
                opacity: !cvSelecionado ? 0.4 : 1,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Divisor */}
        <div style={{ width: 1, height: 28, backgroundColor: "var(--border)", flexShrink: 0 }} />

        {/* Toggles: rastro e paradas */}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setMostrarRastro((v) => !v)}
            disabled={!cvSelecionado}
            style={{
              padding: "0.375rem 0.75rem",
              borderRadius: "0.5rem",
              border: `1px solid ${mostrarRastro ? "var(--accent)" : "var(--border)"}`,
              cursor: cvSelecionado ? "pointer" : "not-allowed",
              fontSize: 11,
              fontWeight: 600,
              backgroundColor: mostrarRastro ? "var(--accent-dim)" : "transparent",
              color: mostrarRastro ? "var(--accent)" : "var(--text-dim)",
              opacity: !cvSelecionado ? 0.4 : 1,
              transition: "all 0.15s",
            }}
          >
            Rastro
          </button>
          <button
            onClick={() => setMostrarParadas((v) => !v)}
            disabled={!cvSelecionado}
            style={{
              padding: "0.375rem 0.75rem",
              borderRadius: "0.5rem",
              border: `1px solid ${mostrarParadas ? "#f59e0b" : "var(--border)"}`,
              cursor: cvSelecionado ? "pointer" : "not-allowed",
              fontSize: 11,
              fontWeight: 600,
              backgroundColor: mostrarParadas ? "rgba(245,158,11,0.1)" : "transparent",
              color: mostrarParadas ? "#f59e0b" : "var(--text-dim)",
              opacity: !cvSelecionado ? 0.4 : 1,
              transition: "all 0.15s",
            }}
          >
            Paradas
          </button>
          {cvSelecionado && (
            <button
              onClick={() => setPainelAberto((v) => !v)}
              style={{
                padding: "0.375rem 0.75rem",
                borderRadius: "0.5rem",
                border: `1px solid ${painelAberto ? "var(--verde)" : "var(--border)"}`,
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                backgroundColor: painelAberto ? "rgba(34,197,94,0.1)" : "transparent",
                color: painelAberto ? "var(--verde)" : "var(--text-dim)",
                transition: "all 0.15s",
              }}
            >
              Telemetria
            </button>
          )}
        </div>

        {/* Botao centralizar */}
        <button
          onClick={centralizarNoRastro}
          disabled={!cvSelecionado || pontosRastro.length === 0}
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0.5rem 1rem",
            borderRadius: "0.625rem",
            border: "1px solid var(--border)",
            cursor: cvSelecionado && pontosRastro.length > 0 ? "pointer" : "not-allowed",
            fontSize: 12,
            fontWeight: 600,
            backgroundColor: "var(--bg)",
            color: "var(--text-muted)",
            opacity: !cvSelecionado || pontosRastro.length === 0 ? 0.35 : 1,
            transition: "all 0.15s",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="2" x2="12" y2="6" />
            <line x1="12" y1="18" x2="12" y2="22" />
            <line x1="2" y1="12" x2="6" y2="12" />
            <line x1="18" y1="12" x2="22" y2="12" />
          </svg>
          Centralizar
        </button>

        {/* Indicador de carregando */}
        {carregando && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: 11 }}>
            <span
              className="animate-pulse-live inline-block w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: "var(--accent)" }}
            />
            buscando...
          </div>
        )}
      </div>

      {/* ============================================================
          MAPA
          ============================================================ */}
      <div
        style={{
          position: "relative",
          height: "76vh",
          borderRadius: "1rem",
          overflow: "hidden",
          border: "1px solid var(--border)",
        }}
      >
        {/* Estado vazio: nenhuma placa selecionada */}
        {!cvSelecionado && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 900,
              pointerEvents: "none",
              textAlign: "center",
            }}
          >
            <div
              style={{
                backgroundColor: "rgba(10,10,10,0.85)",
                border: "1px solid var(--border)",
                borderRadius: "1rem",
                padding: "1.5rem 2rem",
                backdropFilter: "blur(8px)",
              }}
            >
              <p style={{ color: "var(--text-dim)", fontSize: 13, marginBottom: 6 }}>
                Selecione uma placa para ver o rastro
              </p>
              <p style={{ color: "var(--text-dim)", fontSize: 11, opacity: 0.6 }}>
                {veiculos.length} veiculos disponiveis
              </p>
            </div>
          </div>
        )}

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
          {/* Ajuste automatico de bounds ao rastro */}
          {pontosRastro.length > 0 && (
            <AjustarBoundsRastro pontos={pontosRastro} gatilho={gatilhoBounds} />
          )}

          {/* Basemap CartoDB dark (padrao) */}
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution="&copy; OpenStreetMap &copy; CARTO"
          />

          {/* Camadas de risco e basemap opcional Google */}
          <LayersControl position="topright">

            {/* Camada Google opcional: so aparece se a chave estiver configurada */}
            {googleApiKey && (
              <LayersControl.BaseLayer name="Google Satelite">
                <TileLayer
                  url={`https://maps.googleapis.com/maps/api/staticmap?center={lat},{lng}&zoom={z}&size=256x256&maptype=satellite&key=${googleApiKey}`}
                  attribution="&copy; Google Maps"
                />
              </LayersControl.BaseLayer>
            )}

            {/* Favelas */}
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

            {/* Tiroteios recentes */}
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
                        {idadeTexto(t.idadeMin)} ·{" "}
                        {formatarDataHora(t.date)}
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

            {/* Roubo de carga por municipio */}
            {rouboCarga && (
              <LayersControl.Overlay name="Roubo de carga (municipio)">
                <GeoJSON key="roubo" data={rouboCarga} style={estiloRoubo} onEachFeature={popupRoubo} />
              </LayersControl.Overlay>
            )}

          </LayersControl>

          {/* Rastro do veiculo selecionado */}
          {mostrarRastro && pontosRastro.length > 1 && (
            <Polyline
              positions={pontosRastro}
              pathOptions={{
                color: "#9fb3ce",
                weight: 2.5,
                opacity: 0.85,
                dashArray: undefined,
              }}
            />
          )}

          {/* Inicio do rastro (primeiro ponto) */}
          {mostrarRastro && pontosRastro.length > 0 && (
            <CircleMarker
              center={pontosRastro[0]}
              radius={5}
              pathOptions={{
                color: "#22c55e",
                weight: 2,
                fillColor: "#22c55e",
                fillOpacity: 0.9,
              }}
            >
              <Popup>
                <div style={{ fontWeight: 700, fontSize: 12, color: "#22c55e" }}>
                  Inicio do rastro
                </div>
                <div style={{ fontSize: 11, marginTop: 2, color: "#666" }}>
                  {horas === 24 ? "ultimo dia" : "ultimos 4 dias"}
                </div>
              </Popup>
            </CircleMarker>
          )}

          {/* Marcadores de parada */}
          {mostrarParadas && paradas.map((p, i) => (
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
                  <div style={{ fontSize: 12, marginTop: 2 }}>
                    {formatarDataHora(p.data)}
                  </div>
                )}
                {p.local && (
                  <div style={{ fontSize: 12, marginTop: 2, color: "#666" }}>{p.local}</div>
                )}
              </Popup>
            </CircleMarker>
          ))}

          {/* Marcador do veiculo na posicao atual */}
          {posValida && posAtual && (
            <Marker
              position={[posAtual.lat, posAtual.lng]}
              icon={iconeCaminhao(corIgnicao, true)}
            >
              <Popup>
                <div
                  style={{
                    fontFamily: "var(--font-geist-mono, monospace)",
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
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
                  rel="noopener"
                  style={{ fontSize: 12, color: "#1d4ed8", display: "inline-block", marginTop: 4 }}
                >
                  abrir no Google Maps
                </a>
              </Popup>
            </Marker>
          )}
        </MapContainer>

        {/* Legenda de paradas (overlay no canto inferior esquerdo) */}
        {cvSelecionado && (rastro.length > 0 || paradas.length > 0) && (
          <div
            style={{
              position: "absolute",
              bottom: 24,
              left: 12,
              zIndex: 800,
              backgroundColor: "rgba(10,10,10,0.88)",
              border: "1px solid var(--border)",
              borderRadius: "0.625rem",
              padding: "0.625rem 0.875rem",
              display: "flex",
              flexDirection: "column",
              gap: 5,
              backdropFilter: "blur(6px)",
            }}
          >
            {rastro.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div
                  style={{
                    width: 20,
                    height: 2.5,
                    backgroundColor: "#9fb3ce",
                    borderRadius: 2,
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  rastro ({rastro.length} pts, {horas}h)
                </span>
              </div>
            )}
            {paradas.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    backgroundColor: "#f59e0b",
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  {paradas.length} parada(s)
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
