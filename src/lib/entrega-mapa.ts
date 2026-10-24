// Tela "Entrega no mapa" (05/10, botão "Ver no monitoramento" do KPI ao vivo):
// cálculos puros sobre o rastro do dia de uma placa. Quem decide se a NF foi
// entregue é o KPI; aqui só se mostra onde o caminhão estava.

import type { AcessoCliente } from "./acesso-cliente";

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

/** "rqo9h37" -> ["RQO9H37", "RQO-9H37", "RQ09H37", "RQ0-9H37", ...]: o KPI usa
 *  sem hífen, a frota com; e a frota tem cadastro duplicado com O/0 e I/1
 *  trocados (achado 06/10, RQO-9H37 x RQ0-9H37). A página escolhe, entre os
 *  que existirem, o rastreador que mais se mexeu no dia. */
export function normPlacaVariantes(placa: string): string[] {
  const n = placa.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const troca: Record<string, string> = { O: "0", "0": "O", I: "1", "1": "I" };
  let formas = [""];
  for (const ch of n) {
    const alt = troca[ch];
    formas = formas.flatMap(f => (alt ? [f + ch, f + alt] : [f + ch]));
    if (formas.length > 32) formas = formas.slice(0, 32);
  }
  const todas = formas.flatMap(f => [f, f.length === 7 ? `${f.slice(0, 3)}-${f.slice(3)}` : f]);
  return [...new Set([n, `${n.slice(0, 3)}-${n.slice(3)}`, ...todas])];
}

/** Cor e rótulo de cada situação que o KPI manda (`SituacaoNf` do KPI).
 *  F1-10: "fora_da_conta" (cinza claro), a NF que não pesa na taxa. Situação
 *  desconhecida (KPI mais novo que esta tela) cai no cinza neutro da tela. */
export const COR_SITUACAO_ENTREGA: Record<string, string> = {
  entregue: "#22c55e", sem_rastreador: "#94a3b8", pendente: "#9ca3af", nao_confirmada: "#ef4444",
  nao_foi: "#ef4444", revisar: "#f59e0b", fora_da_conta: "#cbd5e1",
};
export const ROTULO_SITUACAO_ENTREGA: Record<string, string> = {
  entregue: "Entregue", sem_rastreador: "Sem rastreador", pendente: "Pendente", nao_confirmada: "Não confirmada",
  nao_foi: "Não foi", revisar: "A revisar", fora_da_conta: "Fora da conta",
};

/** F2-11: frota que o KPI manda no link ("nutrimax" | "rioquality") ->
 *  cod_user_unitrac do cliente no monitoramento. Outra coisa = sem frota. */
export function codUnitracDaFrota(frota: string): string | null {
  if (frota === "nutrimax") return "4096";
  if (frota === "rioquality") return "598";
  return null;
}

export type ClienteDaEntrega =
  | { tipo: "todos" }
  | { tipo: "cliente"; clienteId: string }
  | { tipo: "nenhum"; motivo: "sem_acesso" | "outra_frota" };

/** De qual cliente a placa pode ser aberta na tela de entrega.
 *  - frota do KPI (clienteIdFrota) restringe a busca da placa a ela;
 *  - conta de um cliente só nunca abre outra frota (ericanutrymax x RQ);
 *  - sem frota (KPI antigo, durante o deploy): a regra de antes. */
export function clienteDaEntrega(acesso: AcessoCliente, clienteIdFrota: string | null): ClienteDaEntrega {
  if (acesso.tipo === "nenhum") return { tipo: "nenhum", motivo: "sem_acesso" };
  if (acesso.tipo === "um") {
    if (clienteIdFrota && clienteIdFrota !== acesso.clienteId) return { tipo: "nenhum", motivo: "outra_frota" };
    return { tipo: "cliente", clienteId: acesso.clienteId };
  }
  return clienteIdFrota ? { tipo: "cliente", clienteId: clienteIdFrota } : { tipo: "todos" };
}
