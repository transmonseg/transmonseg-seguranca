"use client";

import { useEffect, useState } from "react";
import { MapContainer, Polyline, CircleMarker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import CamadaPMTiles from "../components/CamadaPMTiles";

type Coord = { lat: number; lng: number };
export type PropsEntregaMapa = {
  info: {
    placa: string; data: string; nome: string; nf: string; endereco: string; lat: number | null; lng: number | null;
    chegada: string | null; saida: string | null; situacao: string; status: string;
    semVeiculo: boolean; semRastro: boolean; distParadaM: number | null;
    perto: { lat: number; lng: number; em: string; distM: number } | null;
  };
  rastro: [number, number][];
  alvo: Coord | null;
  parada: Coord | null;
  atual: { lat: number; lng: number; em: string } | null;
};

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const dataBR = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
const metros = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km` : `${m} m`);
function minutos(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const [ha, ma] = a.split(":").map(Number), [hb, mb] = b.split(":").map(Number);
  return hb * 60 + mb - (ha * 60 + ma);
}

const COR = { rastro: "#3b82f6", cliente: "#ffffff", parada: "#22c55e", perto: "#f59e0b", atual: "#38bdf8" };

function Enquadrar({ pontos, gatilho }: { pontos: Coord[]; gatilho: number }) {
  const map = useMap();
  useEffect(() => {
    if (!pontos.length) return;
    if (pontos.length === 1) { map.setView([pontos[0].lat, pontos[0].lng], 16); return; }
    map.fitBounds(L.latLngBounds(pontos.map(p => [p.lat, p.lng] as [number, number])), { padding: [90, 90], maxZoom: 17 });
  }, [gatilho]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function EntregaMapa({ info, rastro, alvo, parada, atual }: PropsEntregaMapa) {
  const foco: Coord[] = [alvo, parada, info.perto, !parada && !info.perto ? atual : null].filter((p): p is Coord => !!p);
  const diaInteiro: Coord[] = rastro.map(([lat, lng]) => ({ lat, lng }));
  const [modo, setModo] = useState<"entrega" | "dia">("entrega");
  const [gatilho, setGatilho] = useState(0);
  const enquadrar = modo === "dia" || !foco.length ? (diaInteiro.length ? diaInteiro : foco) : foco;
  const tempo = minutos(info.chegada, info.saida);
  const centro: [number, number] = foco[0] ? [foco[0].lat, foco[0].lng] : diaInteiro[0] ? [diaInteiro[0].lat, diaInteiro[0].lng] : [-22.9, -43.2];

  return (
    <div className="relative h-[calc(100dvh-52px)] w-full">
      <MapContainer center={centro} zoom={14} zoomControl={false} style={{ height: "100%", width: "100%", background: "#0a0a0a" }}>
        <CamadaPMTiles tema="dark" />
        <Enquadrar pontos={enquadrar} gatilho={gatilho} />
        {rastro.length > 1 && <Polyline positions={rastro} pathOptions={{ color: COR.rastro, weight: 3, opacity: 0.85 }} />}
        {alvo && (
          <CircleMarker center={[alvo.lat, alvo.lng]} radius={9} pathOptions={{ color: "#0a0a0a", weight: 3, fillColor: COR.cliente, fillOpacity: 1 }}>
            <Tooltip direction="top" offset={[0, -8]} permanent>{info.nome || "Cliente"}</Tooltip>
          </CircleMarker>
        )}
        {parada && (
          <CircleMarker center={[parada.lat, parada.lng]} radius={11} pathOptions={{ color: COR.parada, weight: 3, fillColor: COR.parada, fillOpacity: 0.35 }}>
            <Tooltip direction="bottom" offset={[0, 10]} permanent>Parada {info.chegada}{info.saida ? `–${info.saida}` : ""}</Tooltip>
          </CircleMarker>
        )}
        {info.perto && (
          <CircleMarker center={[info.perto.lat, info.perto.lng]} radius={9} pathOptions={{ color: COR.perto, weight: 3, fillColor: COR.perto, fillOpacity: 0.35 }}>
            <Tooltip direction="bottom" offset={[0, 10]} permanent>Mais perto: {metros(info.perto.distM)} às {hhmm(info.perto.em)}</Tooltip>
          </CircleMarker>
        )}
        {atual && (
          <CircleMarker center={[atual.lat, atual.lng]} radius={8} pathOptions={{ color: "#0a0a0a", weight: 2, fillColor: COR.atual, fillOpacity: 1 }}>
            <Tooltip direction="right" offset={[10, 0]}>Agora ({hhmm(atual.em)})</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>

      <section className="absolute left-4 top-4 z-[500] w-[min(360px,calc(100%-32px))] rounded-[16px] p-4 backdrop-blur-xl"
        style={{ backgroundColor: "color-mix(in srgb, var(--card) 92%, transparent)", border: "1px solid var(--border)", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}>
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>{info.placa} · {dataBR(info.data)}{info.nf ? ` · NF ${info.nf}` : ""}</p>
        <h1 className="mt-1 text-[16px] font-semibold leading-snug" style={{ color: "var(--text)" }}>{info.nome || "Entrega"}</h1>
        {info.endereco && <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>{info.endereco}</p>}

        {info.semVeiculo ? (
          <p className="mt-3 text-[13px]" style={{ color: "var(--text)" }}>Placa não encontrada na frota do monitoramento.</p>
        ) : info.semRastro ? (
          <p className="mt-3 text-[13px]" style={{ color: "var(--text)" }}>Sem posição do rastreador nesse dia.</p>
        ) : parada ? (
          <>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[["Chegou", info.chegada ?? "—"], ["Saiu", info.saida ?? "—"], ["No cliente", tempo != null ? `${tempo} min` : "—"]].map(([r, v]) => (
                <div key={r}><p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{r}</p><p className="text-[15px] font-semibold tabular-nums" style={{ color: "var(--text)" }}>{v}</p></div>
              ))}
            </div>
            {info.distParadaM != null && <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>Parada a {metros(info.distParadaM)} do endereço.</p>}
          </>
        ) : info.perto ? (
          <p className="mt-3 text-[13px]" style={{ color: "var(--text)" }}>Sem parada de entrega. O mais perto que o caminhão chegou foi {metros(info.perto.distM)}, às {hhmm(info.perto.em)}.</p>
        ) : (
          <p className="mt-3 text-[13px]" style={{ color: "var(--text)" }}>{alvo ? "Sem parada de entrega registrada." : "O endereço desta nota não tem coordenada."}</p>
        )}
        {info.status && info.situacao !== "entregue" && <p className="mt-2 rounded-lg px-2.5 py-1.5 text-[12px]" style={{ backgroundColor: "rgba(245,158,11,0.12)", color: "#f5b443" }}>{info.status}</p>}

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => { setModo(m => (m === "dia" ? "entrega" : "dia")); setGatilho(g => g + 1); }}
            className="h-8 rounded-full px-3 text-[12px] font-medium transition-colors hover:bg-card-hover" style={{ border: "1px solid var(--border)", color: "var(--text)" }}>
            {modo === "dia" ? "Ver a entrega" : "Ver o dia inteiro"}
          </button>
          {alvo && (
            <a href={`https://www.google.com/maps?q=${alvo.lat},${alvo.lng}`} target="_blank" rel="noreferrer"
              className="inline-flex h-8 items-center rounded-full px-3 text-[12px] font-medium transition-colors hover:bg-card-hover" style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              Endereço no Google Maps
            </a>
          )}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: COR.cliente }} />Cliente</li>
          {parada && <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: COR.parada }} />Parada da entrega</li>}
          {info.perto && <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: COR.perto }} />Mais perto</li>}
          <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded" style={{ background: COR.rastro }} />Trajeto do dia</li>
          {atual && <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: COR.atual }} />Agora</li>}
        </ul>
      </section>
    </div>
  );
}
