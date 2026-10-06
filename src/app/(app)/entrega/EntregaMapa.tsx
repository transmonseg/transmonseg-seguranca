"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, Marker, useJsApiLoader } from "@react-google-maps/api";
import { DARK_STYLES } from "../central-v2/MapaLeafletV2";

// "Entrega no mapa" (05/10): mesmo Google Maps da Central (estilo escuro,
// satélite, rastro com setas), com a rota inteira da placa e a entrega da NF
// escolhida em destaque. O X volta pro Ao vivo do KPI na mesma placa/NF.

type Coord = { lat: number; lng: number };
export type PontoRota = { ordem: number; nf: string; situacao: string; nome: string; lat: number | null; lng: number | null };
export type PropsEntregaMapa = {
  info: {
    placa: string; data: string; nome: string; nf: string; endereco: string; lat: number | null; lng: number | null;
    chegada: string | null; saida: string | null; situacao: string; status: string;
    semVeiculo: boolean; semRastro: boolean; rastroTravado: boolean; volta: string; distParadaM: number | null;
    perto: { lat: number; lng: number; em: string; distM: number } | null;
  };
  rastro: [number, number][];
  rota: PontoRota[];
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

const COR_SITUACAO: Record<string, string> = { entregue: "#22c55e", sem_rastreador: "#94a3b8", pendente: "#9ca3af", nao_confirmada: "#ef4444", nao_foi: "#ef4444", revisar: "#f59e0b" };
const ROTULO_SITUACAO: Record<string, string> = { entregue: "Entregue", sem_rastreador: "Sem rastreador", pendente: "Pendente", nao_confirmada: "Não confirmada", nao_foi: "Não foi", revisar: "A revisar" };

/** Bolinha numerada da entrega (SVG em data URL, sem asset externo). */
function iconeEntrega(ordem: number, cor: string, destaque: boolean): google.maps.Icon {
  const r = destaque ? 17 : 12, t = r * 2 + 6, c = t / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${t}" height="${t}">` +
    (destaque ? `<circle cx="${c}" cy="${c}" r="${r + 2}" fill="none" stroke="#ffffff" stroke-width="2.5"/>` : "") +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${cor}" stroke="#0a0a0a" stroke-width="2"/>` +
    `<text x="${c}" y="${c + (destaque ? 5 : 4)}" font-family="Arial" font-weight="700" font-size="${destaque ? 14 : 11}" fill="#0a0a0a" text-anchor="middle">${ordem}</text></svg>`;
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new google.maps.Size(t, t), anchor: new google.maps.Point(c, c) };
}
function iconeCirculo(cor: string, raio: number, anel = false): google.maps.Icon {
  const t = raio * 2 + 8, c = t / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${t}" height="${t}">` +
    (anel ? `<circle cx="${c}" cy="${c}" r="${raio}" fill="${cor}" fill-opacity="0.25" stroke="${cor}" stroke-width="3"/>`
      : `<circle cx="${c}" cy="${c}" r="${raio}" fill="${cor}" stroke="#ffffff" stroke-width="3"/>`) + `</svg>`;
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new google.maps.Size(t, t), anchor: new google.maps.Point(c, c) };
}

function fechar(volta: string) {
  if (window.self !== window.top && volta) {
    const msg = { fonte: "monitoramento", tipo: "navegar-central", caminho: volta };
    for (const o of ["https://central.transmonseg.com.br", "https://kpi.transmonseg.com.br"]) window.parent.postMessage(msg, o);
    return;
  }
  window.history.back();
}

export default function EntregaMapa({ info, rastro, rota, alvo, parada, atual }: PropsEntregaMapa) {
  const { isLoaded } = useJsApiLoader({ googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "", id: "transmonseg-google-maps" });
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [satelite, setSatelite] = useState(true);
  const [modo, setModo] = useState<"entrega" | "dia">("entrega");
  const linhas = useRef<google.maps.Polyline[]>([]);
  const tempo = minutos(info.chegada, info.saida);

  const foco = useMemo<Coord[]>(() => [alvo, parada, info.perto, !parada && !info.perto ? atual : null].filter((p): p is Coord => !!p), [alvo, parada, info.perto, atual]);
  const tudo = useMemo<Coord[]>(() => [
    ...rastro.map(([lat, lng]) => ({ lat, lng })),
    ...rota.filter(p => p.lat != null && p.lng != null).map(p => ({ lat: p.lat!, lng: p.lng! })),
    ...foco,
  ], [rastro, rota, foco]);

  const enquadrar = useCallback((pontos: Coord[]) => {
    if (!map || !pontos.length) return;
    if (pontos.length === 1) { map.setCenter(pontos[0]); map.setZoom(17); return; }
    const b = new google.maps.LatLngBounds();
    pontos.forEach(p => b.extend(p));
    map.fitBounds(b, { top: 80, bottom: 80, left: 420, right: 80 });
    google.maps.event.addListenerOnce(map, "idle", () => { if ((map.getZoom() ?? 0) > 18) map.setZoom(18); });
  }, [map]);

  useEffect(() => { enquadrar(modo === "dia" || !foco.length ? tudo : foco); }, [map, modo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rastro imperativo (mesmo motivo da Central: Polyline declarativo do
  // @react-google-maps/api não se limpa direito no React 18).
  useEffect(() => {
    linhas.current.forEach(l => l.setMap(null));
    linhas.current = [];
    if (!map || rastro.length < 2) return;
    const path = rastro.map(([lat, lng]) => ({ lat, lng }));
    const seta: google.maps.Symbol = { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2.5, fillColor: "#00e5ff", fillOpacity: 1, strokeColor: "#000", strokeWeight: 0.8, strokeOpacity: 0.7 };
    const fora = new google.maps.Polyline({ map, path, strokeColor: "#000000", strokeWeight: 7, strokeOpacity: 0.7, geodesic: true, zIndex: 4 });
    const dentro = new google.maps.Polyline({ map, path, strokeColor: "#00e5ff", strokeWeight: 3.5, strokeOpacity: 1, geodesic: true, zIndex: 5, icons: [{ icon: seta, offset: "20px", repeat: "80px" }] });
    linhas.current = [fora, dentro];
    return () => { fora.setMap(null); dentro.setMap(null); };
  }, [map, rastro]);

  const outrasNoMapa = rota.filter(p => p.lat != null && p.lng != null && p.nf !== info.nf);
  const daNf = rota.find(p => p.nf === info.nf);

  return (
    <div className="relative h-[calc(100dvh-52px)] w-full" style={{ backgroundColor: "#0a0a0a" }}>
      {isLoaded && (
        <GoogleMap
          mapContainerStyle={{ width: "100%", height: "100%" }}
          center={foco[0] ?? tudo[0] ?? { lat: -22.9, lng: -43.2 }}
          zoom={15}
          onLoad={setMap}
          onUnmount={() => setMap(null)}
          options={{ mapTypeId: satelite ? "hybrid" : "roadmap", disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: "greedy", styles: satelite ? [] : DARK_STYLES }}
        >
          {outrasNoMapa.map(p => (
            <Marker key={p.nf} position={{ lat: p.lat!, lng: p.lng! }} icon={iconeEntrega(p.ordem, COR_SITUACAO[p.situacao] ?? "#9ca3af", false)} title={`${p.ordem}. ${p.nome} (${ROTULO_SITUACAO[p.situacao] ?? p.situacao})`} zIndex={10} />
          ))}
          {parada && <Marker position={parada} icon={iconeCirculo("#22c55e", 16, true)} title={`Parada da entrega ${info.chegada ?? ""}${info.saida ? `–${info.saida}` : ""}`} zIndex={20} />}
          {info.perto && <Marker position={info.perto} icon={iconeCirculo("#f59e0b", 12, true)} title={`Mais perto: ${metros(info.perto.distM)} às ${hhmm(info.perto.em)}`} zIndex={20} />}
          {alvo && <Marker position={alvo} icon={iconeEntrega(daNf?.ordem ?? 0, COR_SITUACAO[info.situacao] ?? "#ffffff", true)} title={info.nome} zIndex={30} />}
          {atual && <Marker position={atual} icon={iconeCirculo("#38bdf8", 8)} title={`Agora (${hhmm(atual.em)})`} zIndex={40} />}
        </GoogleMap>
      )}

      <section className="absolute left-4 top-4 z-10 flex max-h-[calc(100%-32px)] w-[min(380px,calc(100%-32px))] flex-col rounded-[16px] backdrop-blur-xl"
        style={{ backgroundColor: "color-mix(in srgb, var(--card) 94%, transparent)", border: "1px solid var(--border)", boxShadow: "0 8px 24px rgba(0,0,0,0.35)" }}>
        <div className="p-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <p className="pt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>{info.placa} · {dataBR(info.data)}{info.nf ? ` · NF ${info.nf}` : ""}</p>
            <button type="button" onClick={() => fechar(info.volta)} aria-label="Fechar e voltar" title="Fechar e voltar"
              className="-mr-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-card-hover" style={{ color: "var(--text-muted)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <h1 className="text-[17px] font-semibold leading-snug" style={{ color: "var(--text)" }}>{daNf ? `${daNf.ordem}. ` : ""}{info.nome || "Entrega"}</h1>
          {info.endereco && <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>{info.endereco}</p>}

          {info.semVeiculo ? (
            <p className="mt-3 text-[13px]" style={{ color: "var(--text)" }}>Placa não encontrada na frota do monitoramento.</p>
          ) : parada ? (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[["Chegou", info.chegada ?? "—"], ["Saiu", info.saida ?? "—"], ["No cliente", tempo != null ? `${tempo} min` : "—"]].map(([r, v]) => (
                  <div key={r}><p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{r}</p><p className="text-[16px] font-semibold tabular-nums" style={{ color: "var(--text)" }}>{v}</p></div>
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
          {(info.rastroTravado || info.semRastro) && !info.semVeiculo && (
            <p className="mt-2 rounded-lg px-2.5 py-1.5 text-[12px]" style={{ backgroundColor: "rgba(239,68,68,0.12)", color: "#f87171" }}>
              {info.semRastro ? "Sem posição do rastreador no monitoramento nesse dia." : "O rastreador desta placa ficou parado no mesmo ponto o dia todo no monitoramento; o trajeto não aparece. A parada mostrada é a da Unitrac, a mesma que o KPI usou."}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => setModo(m => (m === "dia" ? "entrega" : "dia"))}
              className="h-8 rounded-full px-3 text-[12px] font-medium transition-colors hover:bg-card-hover" style={{ border: "1px solid var(--border)", color: "var(--text)" }}>
              {modo === "dia" ? "Ver a entrega" : "Ver a rota inteira"}
            </button>
            <button type="button" onClick={() => setSatelite(s => !s)}
              className="h-8 rounded-full px-3 text-[12px] font-medium transition-colors hover:bg-card-hover" style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              {satelite ? "Mapa" : "Satélite"}
            </button>
            {alvo && (
              <a href={`https://www.google.com/maps?q=${alvo.lat},${alvo.lng}`} target="_blank" rel="noreferrer"
                className="inline-flex h-8 items-center rounded-full px-3 text-[12px] font-medium transition-colors hover:bg-card-hover" style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                Google Maps
              </a>
            )}
          </div>
        </div>

        {rota.length > 1 && (
          <div className="min-h-0 flex-1 overflow-y-auto border-t px-2 py-2" style={{ borderColor: "var(--border)" }}>
            <p className="px-2 pb-1 text-[11px]" style={{ color: "var(--text-muted)" }}>Rota da placa no dia</p>
            <ul>
              {rota.map(p => (
                <li key={p.nf}>
                  <button type="button" disabled={p.lat == null}
                    onClick={() => { if (map && p.lat != null && p.lng != null) { map.panTo({ lat: p.lat, lng: p.lng }); map.setZoom(17); } }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-card-hover disabled:opacity-50"
                    style={{ color: p.nf === info.nf ? "var(--text)" : "var(--text-muted)", fontWeight: p.nf === info.nf ? 600 : 400 }}>
                    <span className="w-5 shrink-0 text-right tabular-nums" style={{ color: "var(--text-muted)" }}>{p.ordem}</span>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: COR_SITUACAO[p.situacao] ?? "#9ca3af" }} />
                    <span className="min-w-0 flex-1 truncate">{p.nome || `NF ${p.nf}`}</span>
                    <span className="shrink-0 text-[11px]" style={{ color: COR_SITUACAO[p.situacao] ?? "var(--text-muted)" }}>{ROTULO_SITUACAO[p.situacao] ?? ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
