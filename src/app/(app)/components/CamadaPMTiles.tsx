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
      // URL RELATIVA e' segura AQUI, ao contrario do MapaFallbackOSM.tsx (que
      // precisa montar uma URL absoluta a partir de window.location.origin).
      // A diferenca nao e' estilistica: la' o `maplibre-gl` usa o protocolo
      // CUSTOMIZADO `pmtiles://`, e o parser dele exige uma URL absoluta
      // depois do prefixo -- um path relativo faz o Protocol.tile falhar
      // silenciosamente (sem erro no console, sem requisicao de rede).
      // `protomaps-leaflet` nao usa protocolo customizado nenhum: busca o
      // arquivo com o `fetch()` normal do navegador, que resolve path
      // relativo contra a origem atual sem problema.
      url: "/tiles/rj.pmtiles",
      flavor: tema === "dark" ? "dark" : "light",
      lang: "pt",
      // Licenca ODbL do OSM exige atribuicao visivel. O Leaflet repassa esta
      // opcao pro attributionControl padrao do mapa (ligado por default).
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }) as unknown as Layer;
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map, tema]);
  return null;
}
