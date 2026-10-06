"use client";

import dynamic from "next/dynamic";
import type { PropsEntregaMapa } from "./EntregaMapa";

// O Leaflet usa window: só no navegador.
const EntregaMapa = dynamic(() => import("./EntregaMapa"), {
  ssr: false,
  loading: () => <div className="h-[calc(100dvh-52px)] w-full" style={{ backgroundColor: "#0a0a0a" }} />,
});

export default function EntregaMapaWrapper(props: PropsEntregaMapa) {
  return <EntregaMapa {...props} />;
}
