"use client";

import dynamic from "next/dynamic";

// O Leaflet usa window, entao carrega so no client (ssr: false).
const MapaFrota = dynamic(() => import("./MapaFrota"), {
  ssr: false,
  loading: () => (
    <div
      className="flex items-center justify-center rounded-2xl"
      style={{ height: "100%", minHeight: "320px", backgroundColor: "var(--card)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
    >
      carregando mapa...
    </div>
  ),
});

export default function MapaWrapper({
  cliente,
  altura = "72vh",
  tiposAtivos,
  soProblema,
}: {
  cliente: string;
  altura?: string;
  tiposAtivos?: string[];
  soProblema?: boolean;
}) {
  return (
    <MapaFrota
      cliente={cliente}
      altura={altura}
      tiposAtivos={tiposAtivos}
      soProblema={soProblema}
    />
  );
}
