import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next 16: o antigo middleware.ts virou proxy.ts (Node runtime).
// Protege todas as rotas de página; exclui api, assets e otimizações.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

// mapa-fallback-quota-google (Task 8, achado na investigação do bug de worker
// não instanciado): maplibre-gl-worker.mjs/maplibre-gl-shared.mjs/
// pmtiles-worker-protocol.js são assets estáticos em public/ carregados pelo
// próprio MapLibre (setWorkerUrl / importScriptInWorkers) via fetch interno
// (dentro de um Web Worker, no caso do worker bundle) — não são navegação de
// página, e um redirect pro /login ali quebra o carregamento do worker mesmo
// com sessão válida (dependendo de como o worker lida com credentials).
// Tratados como os demais assets públicos (favicon, png, ico).
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.ico$|maplibre-gl-worker\\.mjs$|maplibre-gl-shared\\.mjs$|pmtiles-worker-protocol\\.js$).*)",
  ],
};
