"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, GeoJSON, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

type Veiculo = {
  placa: string; cv: string; lat: number; lng: number; nivel: string;
  velocidade: number; ignicao: boolean; local: string | null;
  entregas_feitas: number | null; entregas_total: number | null; atraso_min: number;
};
type Base = { nome: string; lat: number; lng: number; raio_m: number };
type Dados = { veiculos: Veiculo[]; bases: Base[] };

const COR: Record<string, string> = {
  vermelho: "#ef4444", amarelo: "#f59e0b", verde: "#5fb87a",
  concluido: "#9fb3ce", cinza: "#6b6b6b",
};

// Enquadra a vista na frota do cliente — uma vez por troca de cliente
// (não a cada refresh de 30s, pra não reposicionar o mapa enquanto o operador olha).
function AjustarVista({ pontos, cliente }: { pontos: [number, number][]; cliente: string }) {
  const map = useMap();
  const ajustado = useRef<string | null>(null);
  useEffect(() => {
    if (ajustado.current === cliente || pontos.length === 0) return;
    map.fitBounds(L.latLngBounds(pontos), { padding: [50, 50], maxZoom: 13 });
    ajustado.current = cliente;
  }, [pontos, cliente, map]);
  return null;
}

export default function MapaFrota({ cliente }: { cliente: string }) {
  const [dados, setDados] = useState<Dados | null>(null);
  const [favelas, setFavelas] = useState<GeoJSON.FeatureCollection | null>(null);

  // Favelas: carregam uma vez (estáticas, cacheadas, perímetro preciso).
  useEffect(() => {
    fetch("/api/favelas").then((r) => r.json()).then(setFavelas).catch(() => {});
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
        <AjustarVista pontos={comPos.map((v) => [v.lat, v.lng])} cliente={cliente} />
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; OpenStreetMap &copy; CARTO'
        />
        {favelas && (
          <GeoJSON
            data={favelas}
            style={{ color: "#ff2d2d", weight: 1.5, fillColor: "#ff2d2d", fillOpacity: 0.4, opacity: 0.95 }}
          />
        )}
        {dados.bases.map((b, i) => (
          <Circle key={`b${i}`} center={[b.lat, b.lng]} radius={b.raio_m}
            pathOptions={{ color: "#9fb3ce", weight: 1.2, fillColor: "#9fb3ce", fillOpacity: 0.06 }} />
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
