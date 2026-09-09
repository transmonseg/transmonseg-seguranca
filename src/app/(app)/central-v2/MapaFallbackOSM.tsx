"use client";

// Mapa de fallback quando a cota do Google Maps estoura (ver spec
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md).
// Fase 1, escopo deliberadamente reduzido: so' veiculos (marcador + clique).
// Sem rastro/alvos/favela/tiroteio/roubo-carga nesta fase -- ver
// Global Constraints do plano de implementacao.

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { VeiculoMapa } from "./MapaLeafletV2";
import type { MapTokens } from "./tokens";

// Registro do protocolo pmtiles:// -- precisa acontecer uma vez por app,
// antes de qualquer new maplibregl.Map() usar uma source "pmtiles://...".
//
// IMPORTANTE (achado via investigacao real pos-QA, nao so' pela doc do README):
// maplibre-gl@6 despacha o FETCH de tiles vetoriais pra dentro de um Web Worker
// (dist/maplibre-gl-worker.mjs), que mantem seu PROPRIO registro de protocolos
// (`self.addProtocol`), separado do registro do thread principal. Chamar so'
// `maplibregl.addProtocol` aqui registra o protocolo so' pro carregamento inicial
// do TileJSON (que roda no thread principal) -- os pedidos de tile de dado real
// (z/x/y), que rodam dentro do worker, falham silenciosamente (sem erro visivel,
// sem requisicao de rede) porque o worker nunca teve "pmtiles" registrado nele.
// A propria doc do maplibre-gl (dist/maplibre-gl.d.ts, funcao importScriptInWorkers)
// confirma: "you might need to also register the protocol on the main thread" --
// ou seja, o inverso tambem e' verdade: registrar so' no thread principal nao basta.
// Fix: usar maplibregl.importScriptInWorkers() pra rodar o registro TAMBEM dentro
// do worker, carregando public/pmtiles-worker-protocol.js (bundle UMD do pacote
// `pmtiles`, node_modules/pmtiles/dist/pmtiles.js, + uma linha de
// self.addProtocol) -- gerado uma vez e versionado em public/ porque
// importScriptInWorkers precisa de uma URL estatica pro worker importar via
// fetch+eval, nao de um modulo ES com specifiers "nus" tipo `import "pmtiles"`
// (que o worker nao consegue resolver sem bundler).
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
maplibregl.importScriptInWorkers("/pmtiles-worker-protocol.js").catch((err) => {
  console.error("[MapaFallbackOSM] falha ao registrar protocolo pmtiles no worker:", err);
});

export interface PropsFallback {
  veiculosMapa: VeiculoMapa[];
  onVeiculoClick: (vm: VeiculoMapa) => void;
  mapTokens: MapTokens;
  tema: "dark" | "light";
}

const CENTER_DEFAULT: [number, number] = [-43.2, -22.9];

// Estilo minimo apontando pro PMTiles self-hospedado -- fonte "rj" e' o
// arquivo gerado no Task 6/servido no Task 7. Paleta escura por padrao
// (ver mapTokens pra variar por tema no futuro, Fase 1 fixa em um so').
//
// IMPORTANTE: o formato oficial de source pmtiles:// do MapLibre exige uma
// URL ABSOLUTA depois do prefixo (ex. "pmtiles://https://host/arquivo.pmtiles"),
// nao um path relativo (ver README do pacote `pmtiles`, secao "MapLibre GL JS").
// Um path relativo faz o Protocol.tile falhar silenciosamente -- sem erro no
// console e sem nenhuma requisicao de rede -- por isso montamos a URL a
// partir de `window.location.origin` em runtime (funcao so' roda client-side,
// dentro de useEffect), evitando hardcode do dominio de producao.
function estiloMapLibre(): StyleSpecification {
  const pmtilesUrl = `pmtiles://${window.location.origin}/tiles/rj.pmtiles`;
  return {
    version: 8,
    sources: {
      rj: { type: "vector", url: pmtilesUrl },
    },
    layers: [
      { id: "fundo", type: "background", paint: { "background-color": "#1a1a1a" } },
      {
        id: "estradas",
        type: "line",
        source: "rj",
        "source-layer": "transportation",
        paint: { "line-color": "#555", "line-width": 1 },
      },
      {
        id: "agua",
        type: "fill",
        source: "rj",
        "source-layer": "water",
        paint: { "fill-color": "#0d2b3a" },
      },
    ],
  };
}

export default function MapaFallbackOSM({ veiculosMapa, onVeiculoClick, mapTokens }: PropsFallback) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: estiloMapLibre(),
      center: CENTER_DEFAULT,
      zoom: 9,
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = veiculosMapa
      .filter((vm) => vm.lat != null && vm.lng != null)
      .map((vm) => {
        const cor = vm.nivel === "vermelho" ? "#e11" : vm.nivel === "amarelo" ? "#eb1" : "#3a3";
        const el = document.createElement("div");
        el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${cor};border:2px solid #fff;cursor:pointer;`;
        el.addEventListener("click", () => onVeiculoClick(vm));
        return new maplibregl.Marker({ element: el }).setLngLat([vm.lng as number, vm.lat as number]).addTo(map);
      });
  }, [veiculosMapa, onVeiculoClick]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        style={{
          position: "absolute", top: 8, left: 8, zIndex: 10,
          background: mapTokens.card, color: mapTokens.text,
          padding: "4px 10px", borderRadius: 6, fontSize: 12,
        }}
      >
        Mapa de reserva (Google indisponível) — satélite indisponível neste modo
      </div>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
