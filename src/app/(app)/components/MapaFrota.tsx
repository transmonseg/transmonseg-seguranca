"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, GeoJSON, useMap } from "react-leaflet";
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
  motivo: string | null; vitimas: number; acaoPolicial: boolean; recente: boolean;
};

const COR: Record<string, string> = {
  vermelho: "#ef4444", amarelo: "#f59e0b", verde: "#5fb87a",
  concluido: "#9fb3ce", cinza: "#6b6b6b",
};

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
    const id = setInterval(carregar, 300000);
    return () => { ativo = false; clearInterval(id); };
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
        {favelas && (
          <GeoJSON
            data={favelas}
            style={{ color: "#ff2d2d", weight: 1, fillColor: "#ff2d2d", fillOpacity: 0.22, opacity: 0.7 }}
          />
        )}
        {/* Malha de pontos de entrega pendentes (a rota que a frota cobre).
            Pontos pequenos e discretos: um veículo longe desta nuvem = desvio. */}
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
        {/* Tiroteios recentes (Fogo Cruzado, RJ, últimos 3 dias). Âmbar; os das
            últimas 24h em laranja vivo e maiores. Evento pontual de risco. */}
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
              </div>
              <div style={{ fontSize: 12, marginTop: 2 }}>
                {t.bairro ? `${t.bairro}, ` : ""}{t.cidade}
              </div>
              <div style={{ fontSize: 12, marginTop: 2 }}>
                {new Date(t.date).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                {t.recente ? " · recente" : ""}
              </div>
              {t.motivo && <div style={{ fontSize: 12, marginTop: 2 }}>motivo: {t.motivo}</div>}
              {t.vitimas > 0 && <div style={{ fontSize: 12, marginTop: 2, color: "#dc2626" }}>{t.vitimas} vítima(s)</div>}
            </Popup>
          </CircleMarker>
        ))}
        {comPos.map((v, i) => {
          const cor = COR[v.nivel] ?? "#5fb87a";
          return (
            <CircleMarker key={`v${i}`} center={[v.lat, v.lng]} radius={6}
              pathOptions={{ color: "#0a0a0a", fillColor: cor, fillOpacity: 1, weight: 1.5 }}>
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
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
