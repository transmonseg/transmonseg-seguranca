"use client";

// Substitui o tile CARTO (sem chave/registro, ToS proibe uso comercial) por
// tile vetorial self-hospedado (mesmo arquivo rj.pmtiles do Task 6/7 do
// plano de fallback de mapa). Ver
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md.
//
// Diferente do MapaFallbackOSM.tsx (Central, maplibre-gl): esta biblioteca
// (protomaps-leaflet) renderiza os tiles vetoriais direto em Canvas no
// thread principal, sem Web Worker -- por isso nao precisa do
// setWorkerUrl/importScriptInWorkers que o Task 8 exigiu para o maplibre-gl.
// Ainda assim, nao assumir que "compilou" == "renderiza": confirmar via
// captura de rede/visual que a camada realmente busca tiles.

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import type { Layer } from "leaflet";
import * as protomapsL from "protomaps-leaflet";

export default function CamadaPMTiles({ tema }: { tema: "dark" | "light" }) {
  const map = useMap();
  useEffect(() => {
    // O tipo de retorno de leafletLayer() não implementa a interface Layer
    // do @types/leaflet de forma estrutural completa (é um L.GridLayer.extend
    // dinâmico) -- addTo/removeLayer funcionam em runtime normalmente.
    const layer = protomapsL.leafletLayer({
      url: "/tiles/rj.pmtiles",
      flavor: tema === "dark" ? "dark" : "light",
      lang: "pt",
    }) as unknown as Layer;
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map, tema]);
  return null;
}
