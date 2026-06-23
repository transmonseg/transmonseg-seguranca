"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, GeoJSON, LayersControl, LayerGroup, useMap } from "react-leaflet";
import type { Layer } from "leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

type Veiculo = {
  placa: string; cv: string; lat: number; lng: number; nivel: string;
  velocidade: number; ignicao: boolean; local: string | null;
  entregas_feitas: number | null; entregas_total: number | null; atraso_min: number;
};
type Dados = {
  veiculos: Veiculo[];
  bases: GeoJSON.FeatureCollection | null;
  pontos?: { lat: number; lng: number }[];
};
type Tiroteio = {
  lat: number; lng: number; date: string; bairro: string; cidade: string;
  motivo: string | null; vitimas: number; acaoPolicial: boolean; idadeMin: number; recente: boolean;
};
function idadeTexto(min: number): string {
  if (min < 1) return "agora";
  if (min < 60) return `há ${min}min`;
  return `há ${Math.floor(min / 60)}h`;
}

const COR: Record<string, string> = {
  vermelho: "#ef4444", amarelo: "#f59e0b", verde: "#5fb87a",
  concluido: "#9fb3ce", cinza: "#6b6b6b",
};

// Ícone de caminhão colorido pelo status, num disco escuro (legível no mapa dark).
// Cacheado por cor: só 5 variações. Veículos críticos um pouco maiores.
const _iconeCache: Record<string, L.DivIcon> = {};
function iconeCaminhao(cor: string, destaque: boolean): L.DivIcon {
  const chave = `${cor}-${destaque}`;
  if (_iconeCache[chave]) return _iconeCache[chave];
  const s = destaque ? 32 : 26;
  const html =
    `<div style="width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;` +
    `background:rgba(10,10,10,0.92);border:1.6px solid ${cor};border-radius:50%;` +
    `box-shadow:0 0 0 1px rgba(0,0,0,0.5)${destaque ? `,0 0 8px ${cor}` : ""}">` +
    `<svg width="${destaque ? 18 : 15}" height="${destaque ? 18 : 15}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="1" y="3" width="15" height="13"/>` +
    `<polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>` +
    `<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div>`;
  const ic = L.divIcon({ html, className: "marcador-caminhao", iconSize: [s, s], iconAnchor: [s / 2, s / 2], popupAnchor: [0, -s / 2] });
  _iconeCache[chave] = ic;
  return ic;
}

// Escala de cor do coroplético de roubo de carga (totais 12 meses por município).
// Tons suaves: a camada é contexto, não pode saturar a tela.
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
    `<div style="font-weight:700;font-size:13px">${p?.nome ?? "Município"}</div>` +
    `<div style="font-size:12px;margin-top:2px">${n} roubo(s) de carga</div>` +
    `<div style="font-size:11px;color:#666;margin-top:1px">últimos 12 meses · ISP-RJ</div>`
  );
}

// Enquadra a vista englobando a frota E as áreas de risco (estado todo),
// uma vez por troca de cliente — pra não reposicionar o mapa a cada refresh.
function AjustarVista({
  pontos, favelas, bases, cliente,
}: {
  pontos: [number, number][];
  favelas: GeoJSON.FeatureCollection | null;
  bases: GeoJSON.FeatureCollection | null;
  cliente: string;
}) {
  const map = useMap();
  const ajustado = useRef<string | null>(null);
  useEffect(() => {
    if (ajustado.current === cliente) return;
    // ?foco=base -> enquadra nas bases (ver o perímetro de perto)
    const foco = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("foco");
    if (foco === "base" && bases?.features?.length) {
      try { map.fitBounds(L.geoJSON(bases).getBounds(), { padding: [40, 40] }); ajustado.current = cliente; return; } catch { /* ignora */ }
    }
    // ?foco=rio -> enquadra a região metropolitana (onde se concentram tiroteios)
    if (foco === "rio") {
      map.setView([-22.9, -43.4], 11); ajustado.current = cliente; return;
    }
    // padrão: enquadra a frota E as áreas de risco (estado inteiro)
    if (pontos.length === 0 || !favelas) return;
    const limites = L.latLngBounds(pontos);
    try { limites.extend(L.geoJSON(favelas).getBounds()); } catch { /* ignora */ }
    map.fitBounds(limites, { padding: [30, 30] });
    ajustado.current = cliente;
  }, [pontos, favelas, bases, cliente, map]);
  return null;
}

export default function MapaFrota({ cliente }: { cliente: string }) {
  const [dados, setDados] = useState<Dados | null>(null);
  const [favelas, setFavelas] = useState<GeoJSON.FeatureCollection | null>(null);
  const [tiroteios, setTiroteios] = useState<Tiroteio[]>([]);
  const [rouboCarga, setRouboCarga] = useState<GeoJSON.FeatureCollection | null>(null);

  // Favelas: carregam uma vez (estáticas, cacheadas, perímetro preciso).
  useEffect(() => {
    fetch("/api/favelas").then((r) => r.json()).then(setFavelas).catch(() => {});
  }, []);

  // Tiroteios (Fogo Cruzado): risco dinâmico, recarrega a cada 5 min.
  useEffect(() => {
    let ativo = true;
    const carregar = () =>
      fetch("/api/tiroteios")
        .then((r) => r.json())
        .then((d) => { if (ativo && Array.isArray(d?.tiroteios)) setTiroteios(d.tiroteios); })
        .catch(() => {});
    carregar();
    const id = setInterval(carregar, 90000); // tempo real: a cada 90s
    return () => { ativo = false; clearInterval(id); };
  }, []);

  // Roubo de carga (ISP-RJ): índice por município, carrega uma vez (mensal).
  useEffect(() => {
    fetch("/api/roubo-carga")
      .then((r) => r.json())
      .then((d) => { if (d?.geojson) setRouboCarga(d.geojson); })
      .catch(() => {});
  }, []);

  // Veículos + bases: por cliente, atualizam junto com a tela.
  useEffect(() => {
    let ativo = true;
    const carregar = () =>
      fetch(`/api/mapa?cliente=${cliente}`)
        .then((r) => r.json())
        .then((d) => { if (ativo) setDados(d); })
        .catch(() => {});
    carregar();
    const id = setInterval(carregar, 30000);
    return () => { ativo = false; clearInterval(id); };
  }, [cliente]);

  if (!dados) {
    return (
      <div className="flex items-center justify-center rounded-2xl"
        style={{ height: "72vh", backgroundColor: "var(--card)", border: "1px solid var(--border)", color: "var(--text-dim)" }}>
        carregando mapa...
      </div>
    );
  }

  const comPos = dados.veiculos.filter((v) => v.lat && v.lng);
  const centro: [number, number] = comPos.length
    ? [comPos[0].lat, comPos[0].lng]
    : [-22.9, -43.2];

  return (
    <div style={{ height: "72vh", borderRadius: "1rem", overflow: "hidden", border: "1px solid var(--border)" }}>
      <MapContainer center={centro} zoom={10} preferCanvas style={{ height: "100%", width: "100%", background: "#0a0a0a" }}>
        <AjustarVista pontos={comPos.map((v) => [v.lat, v.lng])} favelas={favelas} bases={dados.bases} cliente={cliente} />
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; OpenStreetMap &copy; CARTO'
        />
        {/* Camadas de risco toggleáveis pelo operador (controle no canto). */}
        <LayersControl position="topright">
          {favelas && (
            <LayersControl.Overlay checked name="Favelas">
              <GeoJSON
                data={favelas}
                style={{ color: "#ff2d2d", weight: 1, fillColor: "#ff2d2d", fillOpacity: 0.22, opacity: 0.7 }}
              />
            </LayersControl.Overlay>
          )}
          {/* Tiroteios recentes (Fogo Cruzado, RJ, últimos 3 dias). Âmbar; os das
              últimas 24h em laranja vivo, maiores e com anel branco. */}
          <LayersControl.Overlay checked name="Tiroteios (24h)">
            <LayerGroup>
              {tiroteios.map((t, i) => (
                <CircleMarker key={`tiro${i}`} center={[t.lat, t.lng]}
                  radius={t.recente ? 6 : 4}
                  pathOptions={{
                    color: t.recente ? "#ffffff" : "#fde68a",
                    weight: t.recente ? 2 : 1,
                    fillColor: t.recente ? "#ff6a00" : "#d97706",
                    fillOpacity: 1,
                  }}>
                  <Popup>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#c2410c" }}>
                      Tiroteio{t.acaoPolicial ? " · ação policial" : ""}
                      {t.recente ? <span style={{ marginLeft: 6, color: "#dc2626", fontSize: 11 }}>● AGORA</span> : null}
                    </div>
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                      {t.bairro ? `${t.bairro}, ` : ""}{t.cidade}
                    </div>
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                      {idadeTexto(t.idadeMin)} · {new Date(t.date).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </div>
                    {t.motivo && <div style={{ fontSize: 12, marginTop: 2 }}>motivo: {t.motivo}</div>}
                    {t.vitimas > 0 && <div style={{ fontSize: 12, marginTop: 2, color: "#dc2626" }}>{t.vitimas} vítima(s)</div>}
                  </Popup>
                </CircleMarker>
              ))}
            </LayerGroup>
          </LayersControl.Overlay>
          {/* Roubo de carga por município (ISP-RJ, 12 meses). Coroplético, começa
              desligado pra não competir com as outras camadas. */}
          {rouboCarga && (
            <LayersControl.Overlay name="Roubo de carga (município)">
              <GeoJSON key="roubo" data={rouboCarga} style={estiloRoubo} onEachFeature={popupRoubo} />
            </LayersControl.Overlay>
          )}
        </LayersControl>

        {/* Malha de pontos de entrega pendentes (a rota que a frota cobre). */}
        {(dados.pontos ?? []).map((pt, i) => (
          <CircleMarker key={`pt${i}`} center={[pt.lat, pt.lng]} radius={1.5}
            pathOptions={{ stroke: false, fillColor: "#38bdf8", fillOpacity: 0.5 }} />
        ))}
        {dados.bases && (
          <GeoJSON
            key={`bases-${cliente}`}
            data={dados.bases}
            style={{ color: "#7dd3fc", weight: 1.5, fillColor: "#7dd3fc", fillOpacity: 0.12, opacity: 0.85, dashArray: "5 4" }}
          />
        )}
        {comPos.map((v, i) => {
          const cor = COR[v.nivel] ?? "#5fb87a";
          const destaque = v.nivel === "vermelho" || v.nivel === "amarelo";
          return (
            <Marker key={`v${i}`} position={[v.lat, v.lng]} icon={iconeCaminhao(cor, destaque)}>
              <Popup>
                <div style={{ fontFamily: "var(--font-geist-mono), monospace", fontWeight: 700, fontSize: 14 }}>{v.placa}</div>
                <div style={{ fontSize: 12, marginTop: 2 }}>
                  {v.velocidade > 0 ? `${v.velocidade} km/h` : "parado"} · ignição {v.ignicao ? "ligada" : "desligada"}
                </div>
                {v.local && <div style={{ fontSize: 12, marginTop: 2 }}>{v.local}</div>}
                {(v.entregas_total ?? 0) > 0 && (
                  <div style={{ fontSize: 12, marginTop: 2 }}>
                    entregas {v.entregas_feitas}/{v.entregas_total}
                  </div>
                )}
                <a href={`https://www.google.com/maps?q=${v.lat},${v.lng}`} target="_blank" rel="noopener"
                  style={{ fontSize: 12, color: "#1d4ed8", display: "inline-block", marginTop: 4 }}>
                  abrir no Google Maps
                </a>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
