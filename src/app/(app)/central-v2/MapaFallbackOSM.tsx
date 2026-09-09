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

// Setup do protocolo pmtiles:// -- precisa acontecer uma vez por app, antes
// de qualquer new maplibregl.Map() usar uma source "pmtiles://...".
//
// IMPORTANTE (achado via investigacao real pos-QA, nao so' por doc/README --
// ver task-8-report.md pro historico completo de 3 rodadas de bug):
//
// 1) maplibre-gl@6 despacha o FETCH de tiles vetoriais pra dentro de um Web
//    Worker (dist/maplibre-gl-worker.mjs), que mantem seu PROPRIO registro de
//    protocolos (`self.addProtocol`), separado do thread principal. So'
//    `maplibregl.addProtocol` no thread principal resolve o TileJSON inicial,
//    mas nao os pedidos de tile real (z/x/y), que rodam dentro do worker.
//    Fix: `maplibregl.importScriptInWorkers(...)` roda o registro TAMBEM
//    dentro do worker.
//
// 2) POREM: nada disso importa se o worker nunca chega a ser criado. Em
//    producao (Next.js + Turbopack), confirmado ao vivo via Proxy em
//    `window.Worker` que ZERO workers eram instanciados durante todo o ciclo
//    de vida do componente. Causa: por padrao, maplibre-gl calcula a URL do
//    seu proprio bundle de worker a partir de `import.meta.url` do modulo
//    principal (funcao interna que so' funciona se isso for uma URL
//    http(s)://... valida) -- sob Turbopack esse valor nao bate o formato
//    esperado, a funcao devolve uma URL vazia, e a criacao do worker nunca
//    acontece (nem chega a lancar erro visivel). Fix: apontar explicitamente
//    via `maplibregl.setWorkerUrl(...)` pro bundle do worker, servido como
//    asset estatico. Confirmado localmente (fora de producao, via Playwright
//    + servidor local espelhando os mesmos arquivos que vao pra public/) que
//    com `setWorkerUrl` setado, o Worker É instanciado de verdade, tiles reais
//    sao buscados (Range requests que aumentam conforme zoom) e o mapa
//    renderiza ruas/agua corretamente.
//
// Os arquivos estaticos usados abaixo (versionados em public/, nao gerados no
// build):
// - public/maplibre-gl-worker.mjs + public/maplibre-gl-shared.mjs: copia
//   direta de node_modules/maplibre-gl/dist/{maplibre-gl-worker,maplibre-gl-shared}.mjs
//   (o worker importa o "shared" via specifier relativo "./maplibre-gl-shared.mjs",
//   por isso os dois precisam estar juntos no mesmo diretorio).
// - public/pmtiles-worker-protocol.js: bundle UMD do pacote `pmtiles`
//   (node_modules/pmtiles/dist/pmtiles.js) + uma linha de `self.addProtocol`,
//   carregado via importScriptInWorkers (que faz fetch+eval da URL dentro do
//   worker -- um `import "pmtiles"` com specifier "nu" nao resolveria ali sem
//   bundler).
// Esses 3 arquivos tambem precisaram ser excluidos do proxy.ts de autenticacao
// (ver src/proxy.ts) -- sem isso, um pedido anonimo a eles e' redirecionado
// pro /login, e o Worker (que faz fetch com credentials:"same-origin", nao
// necessariamente com a mesma robustez de um <script> de pagina) pode falhar.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
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
