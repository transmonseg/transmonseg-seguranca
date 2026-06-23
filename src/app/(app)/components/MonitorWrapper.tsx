"use client";

import dynamic from "next/dynamic";

// O Leaflet usa window, entao carrega so no client (ssr: false).
const MapaMonitor = dynamic(() => import("./MapaMonitor"), {
  ssr: false,
  loading: () => (
    <div
      className="flex items-center justify-center rounded-2xl"
      style={{ height: "80vh", backgroundColor: "var(--card)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
    >
      carregando monitor...
    </div>
  ),
});

interface Props {
  cliente: string;
  veiculos: { placa: string; cv: string }[];
}

export default function MonitorWrapper({ cliente, veiculos }: Props) {
  return <MapaMonitor cliente={cliente} veiculos={veiculos} />;
}
