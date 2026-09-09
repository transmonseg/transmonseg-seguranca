"use client";

// Mapa de fallback quando a cota do Google Maps estoura (ver spec
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md).
// Fase 1, escopo deliberadamente reduzido: so' veiculos (marcador + clique).
// Sem rastro/alvos/favela/tiroteio/roubo-carga nesta fase -- ver
// Global Constraints do plano de implementacao.

import { useEffect, useRef, useState } from "react";
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
//
// 3) POR QUE ISSO NAO RODA MAIS NO ESCOPO DO MODULO (rodada 4, achado real):
//    `importScriptInWorkers` NAO e' uma chamada inerte -- por dentro ela faz
//    `getGlobalDispatcher().broadcast(...)`, o que JA CRIA o worker pool
//    (`new Worker(WORKER_URL)`) na hora. Com isso no escopo do modulo, o
//    worker nascia no LOAD da pagina (o modulo entra no mesmo chunk do
//    wrapper Google/fallback, que carrega sempre), muito antes do fallback
//    montar. Dois efeitos ruins:
//      (a) diagnostico: quem instrumenta `window.Worker` pelo devtools DEPOIS
//          do load (unica forma pratica) media ZERO workers e concluia que o
//          worker nunca era criado -- falso negativo que custou uma rodada
//          inteira de investigacao. Reproduzido 1:1 num build de producao real
//          (`next build` + `next start`, Turbopack): com o Proxy instalado
//          pos-load o contador fica em 0, enquanto o worker do maplibre existe
//          e 35 requisicoes Range de tile acontecem normalmente.
//      (b) desperdicio: todo usuario da Central pagava 1-3 Web Workers +
//          ~500KB de `maplibre-gl-shared.mjs` + o script do protocolo mesmo
//          no modo Google normal, sem nunca usar o fallback.
//    Agora o setup e' preguicoso (so' quando o fallback monta de fato),
//    idempotente (uma promise memoizada por page load) e AGUARDADO antes de
//    `new maplibregl.Map(...)` -- o que tambem elimina a corrida teorica entre
//    o registro do protocolo dentro do worker e o primeiro pedido de tile.
let setupPromise: Promise<void> | null = null;
function garantirSetupMapLibre(): Promise<void> {
  setupPromise ??= (async () => {
    maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
    maplibregl.addProtocol("pmtiles", new Protocol().tile);
    await maplibregl.importScriptInWorkers("/pmtiles-worker-protocol.js");
  })();
  return setupPromise;
}

export interface PropsFallback {
  veiculosMapa: VeiculoMapa[];
  onVeiculoClick: (vm: VeiculoMapa) => void;
  mapTokens: MapTokens;
  tema: "dark" | "light";
  // Mesma semântica de MapaLeafletV2 (Props em MapaLeafletV2.tsx) -- reaproveitados
  // aqui pra fechar a lacuna "clicar num veículo não centraliza o mapa" do banner
  // de modo reduzido. `cvSelecionado`/`seguir` seguem o veículo continuamente;
  // `flyPara`/`zoomCmd` são comandos de disparo único (o campo `gatilho`/`g` muda
  // a cada clique, mesmo que lat/lng/zoom repita, pra sempre re-disparar o efeito).
  cvSelecionado?: string | null;
  seguir?: boolean;
  flyPara?: { lat: number; lng: number; gatilho: number } | null;
  zoomCmd?: { zoom: number; g: number } | null;
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
      // `attribution` na source e' o que alimenta o AttributionControl padrao
      // do MapLibre (ligado por padrao quando `attributionControl` nao e'
      // explicitamente `false`). Sem isso, o controle nao teria NADA de OSM
      // pra exibir -- e a licenca ODbL do OpenStreetMap exige atribuicao
      // visivel, inclusive pro dado self-hospedado em rj.pmtiles.
      rj: {
        type: "vector",
        url: pmtilesUrl,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      },
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

export default function MapaFallbackOSM({
  veiculosMapa, onVeiculoClick, mapTokens, cvSelecionado, seguir, flyPara, zoomCmd,
}: PropsFallback) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  // So' pra re-disparar o efeito dos marcadores quando o mapa fica pronto
  // (a criacao virou assincrona por causa do setup preguicoso acima).
  const [mapaPronto, setMapaPronto] = useState(false);
  // Mesmo padrao de "gatilho ja processado" de MapaLeafletV2.tsx (prevFlyG/
  // prevZoomG/lastPanKey) -- evita reprocessar o mesmo comando de novo quando
  // o componente re-renderiza por outro motivo (ex: veiculosMapa atualizando).
  const prevFlyG = useRef(-1);
  const prevZoomG = useRef(0);
  const lastPanKey = useRef("");

  useEffect(() => {
    let cancelado = false;
    garantirSetupMapLibre()
      .catch((err) => {
        // Nao aborta: sem o protocolo no worker o mapa ainda monta (fundo +
        // marcadores), so' nao carrega a camada vetorial -- melhor que tela
        // preta. O erro fica registrado pra diagnostico.
        console.error("[MapaFallbackOSM] falha no setup do MapLibre/pmtiles:", err);
      })
      .then(() => {
        if (cancelado || !containerRef.current) return;
        mapRef.current = new maplibregl.Map({
          container: containerRef.current,
          style: estiloMapLibre(),
          center: CENTER_DEFAULT,
          zoom: 9,
          // Explicito (o default ja' seria ligado) pra deixar registrado que
          // a atribuicao OSM/ODbL declarada na source `rj` PRECISA aparecer.
          attributionControl: { compact: true },
        });
        setMapaPronto(true);
      });
    return () => {
      cancelado = true;
      mapRef.current?.remove();
      // map.remove() ja' destroi os Marker, mas o array continuaria segurando
      // referencias a objetos mortos ate' o proximo render dos marcadores.
      markersRef.current = [];
      mapRef.current = null;
      setMapaPronto(false);
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
  }, [veiculosMapa, onVeiculoClick, mapaPronto]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyPara || flyPara.gatilho === prevFlyG.current) return;
    prevFlyG.current = flyPara.gatilho;
    map.panTo([flyPara.lng, flyPara.lat]);
    map.setZoom(16);
  }, [flyPara, mapaPronto]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !zoomCmd || zoomCmd.g === prevZoomG.current) return;
    prevZoomG.current = zoomCmd.g;
    map.setZoom(zoomCmd.zoom);
  }, [zoomCmd, mapaPronto]);

  const vmSelecionado = cvSelecionado ? veiculosMapa.find((v) => v.cv === cvSelecionado) : null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !seguir || !vmSelecionado?.lat || !vmSelecionado?.lng) return;
    const k = `${vmSelecionado.lat.toFixed(5)},${vmSelecionado.lng.toFixed(5)}`;
    if (k === lastPanKey.current) return;
    lastPanKey.current = k;
    map.panTo([vmSelecionado.lng, vmSelecionado.lat]);
  }, [seguir, vmSelecionado, mapaPronto]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        style={{
          position: "absolute", top: 8, left: 8, zIndex: 10,
          background: mapTokens.card, color: mapTokens.text,
          padding: "4px 10px", borderRadius: 6, fontSize: 12,
        }}
      >
        {/* flyPara/zoomCmd/seguir ja funcionam aqui (clicar num veiculo
            centraliza normal) -- o que falta ainda e' rastro/alvos de
            entrega/favelas/tiroteios, escopo Fase 1 (ver Global Constraints
            do plano de implementacao). Satelite fica pra Fase 2
            (spec Decisao 5, Sentinel-2 self-hospedado). */}
        Mapa de reserva (Google indisponível) — modo reduzido: sem satélite,
        sem rastro/alvos de entrega
      </div>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
