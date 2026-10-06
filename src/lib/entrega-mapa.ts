// Tela "Entrega no mapa" (05/10, botão "Ver no monitoramento" do KPI ao vivo):
// cálculos puros sobre o rastro do dia de uma placa. Quem decide se a NF foi
// entregue é o KPI; aqui só se mostra onde o caminhão estava.

export type PontoRastro = { lat: number; lng: number; em: string };
export type Coord = { lat: number; lng: number };

/** Dia AAAA-MM-DD em BRT -> intervalo [inicio, fim) em UTC. */
export function janelaDiaBR(data: string): { inicio: string; fim: string } {
  const inicio = new Date(`${data}T00:00:00-03:00`);
  const fim = new Date(inicio.getTime() + 24 * 3600 * 1000);
  return { inicio: inicio.toISOString(), fim: fim.toISOString() };
}

function horaBR(data: string, hhmm: string | null): number | null {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":");
  return Date.parse(`${data}T${h.padStart(2, "0")}:${m}:00-03:00`);
}

export function distanciaM(a: Coord, b: Coord): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Onde o caminhão ficou parado na entrega: média das posições entre a
 *  chegada e a saída do KPI. Sem posição na janela, a mais próxima da
 *  chegada se estiver a até 15 min dela. */
export function paradaDaEntrega(pontos: PontoRastro[], data: string, chegada: string | null, saida: string | null): Coord | null {
  const ini = horaBR(data, chegada);
  if (ini == null) return null;
  const fim = horaBR(data, saida) ?? ini;
  const dentro = pontos.filter(p => { const t = Date.parse(p.em); return t >= ini && t <= fim; });
  if (dentro.length) {
    return { lat: dentro.reduce((s, p) => s + p.lat, 0) / dentro.length, lng: dentro.reduce((s, p) => s + p.lng, 0) / dentro.length };
  }
  let melhor: PontoRastro | null = null, dt = Infinity;
  for (const p of pontos) { const d = Math.abs(Date.parse(p.em) - ini); if (d < dt) { dt = d; melhor = p; } }
  return melhor && dt <= 15 * 60_000 ? { lat: melhor.lat, lng: melhor.lng } : null;
}

/** Posição do dia mais perto de um ponto (pra NF não entregue). */
export function maisPerto(pontos: PontoRastro[], alvo: Coord): (PontoRastro & { distM: number }) | null {
  let melhor: (PontoRastro & { distM: number }) | null = null;
  for (const p of pontos) {
    const d = distanciaM(p, alvo);
    if (!melhor || d < melhor.distM) melhor = { ...p, distM: d };
  }
  return melhor;
}

/** No máximo ~max pontos pro mapa, sempre com o primeiro e o último. */
export function afinarRastro<T>(pontos: T[], max: number): T[] {
  if (pontos.length <= max) return pontos;
  const passo = Math.ceil(pontos.length / max);
  const r = pontos.filter((_, i) => i % passo === 0);
  if (r[r.length - 1] !== pontos[pontos.length - 1]) r.push(pontos[pontos.length - 1]);
  return r;
}

/** "rqo9h37" -> ["RQO9H37", "RQO-9H37"] (o KPI usa sem hífen, a frota com). */
export function normPlacaVariantes(placa: string): string[] {
  const n = placa.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return [n, `${n.slice(0, 3)}-${n.slice(3)}`];
}
