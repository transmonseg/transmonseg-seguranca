// RAS-06 (auditoria 03/11): transporte da Central. Antes: um carimbo só para
// dois polls (mapa falhando com alertas ok nunca avisava), 401 de sessão
// vencida virava só o aviso genérico, fetch sem timeout e sem pausa em aba
// escondida.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { criarPoll, saudeInicial, registrarPoll, avisoTransporte, MSG_SESSAO_VENCIDA } from "./transporte-poll";

function docFalso(hidden = false) {
  const ouvintes = new Set<() => void>();
  return {
    hidden,
    addEventListener: (_: string, f: () => void) => ouvintes.add(f),
    removeEventListener: (_: string, f: () => void) => ouvintes.delete(f),
    mudar(h: boolean) { this.hidden = h; ouvintes.forEach((f) => f()); },
  };
}
const ok = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("saúde por fonte", () => {
  it("mapa falhando 3x com alertas ok => aviso visível citando o mapa", () => {
    let s = saudeInicial(0);
    for (let i = 1; i <= 3; i++) {
      s = registrarPoll(s, "alertas", "ok", i * 30_000);
      s = registrarPoll(s, "mapa", "falha", i * 30_000);
    }
    const aviso = avisoTransporte(s, 90_000);
    expect(aviso?.tipo).toBe("desatualizado");
    expect(aviso?.texto).toMatch(/mapa/i);
    expect(aviso?.texto).not.toMatch(/alertas/i);
  });
  it("tudo ok => sem aviso", () => {
    let s = saudeInicial(0);
    s = registrarPoll(s, "alertas", "ok", 30_000);
    s = registrarPoll(s, "mapa", "ok", 30_000);
    expect(avisoTransporte(s, 40_000)).toBeNull();
  });
  it("sessão vencida vence qualquer outro aviso", () => {
    let s = saudeInicial(0);
    s = registrarPoll(s, "mapa", "sessao_vencida", 30_000);
    expect(avisoTransporte(s, 30_000)).toEqual({ tipo: "sessao_vencida", texto: MSG_SESSAO_VENCIDA });
    expect(MSG_SESSAO_VENCIDA).toBe("Sessão vencida, abra o monitoramento de novo pela Central");
  });
});

describe("criarPoll", () => {
  it("usa AbortSignal.timeout(20000)", async () => {
    const espiao = vi.spyOn(AbortSignal, "timeout");
    const f = vi.fn(async () => ok({}));
    const p = criarPoll({ url: () => "/api/mapa", intervaloMs: 30_000, fetch: f, aoReceber: () => {}, aoResultado: () => {}, doc: docFalso() });
    await vi.advanceTimersByTimeAsync(0);
    expect(espiao).toHaveBeenCalledWith(20_000);
    expect((f.mock.calls[0] as unknown[])[1]).toHaveProperty("signal");
    p.parar();
  });

  it("401 => avisa sessão vencida e para o poll", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 401 }));
    const resultados: string[] = [];
    criarPoll({ url: () => "/api/mapa", intervaloMs: 30_000, fetch: f, aoReceber: () => {}, aoResultado: (r) => resultados.push(r), doc: docFalso() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resultados).toEqual(["sessao_vencida"]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("pausa com document.hidden e volta (com 1 poll na hora) quando a aba aparece", async () => {
    const f = vi.fn(async () => ok({ a: 1 }));
    const doc = docFalso();
    const p = criarPoll({ url: () => "/x", intervaloMs: 30_000, fetch: f, aoReceber: () => {}, aoResultado: () => {}, doc });
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    doc.mudar(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f).toHaveBeenCalledTimes(1);
    doc.mudar(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(2);
    p.parar();
  });

  it("resposta mais velha que chega depois de uma nova é descartada", async () => {
    let n = 0;
    const resolvedores: ((r: Response) => void)[] = [];
    const f = vi.fn(() => new Promise<Response>((res) => { resolvedores.push(res); n++; }));
    const recebidos: unknown[] = [];
    const p = criarPoll({ url: () => "/x", intervaloMs: 30_000, fetch: f, aoReceber: (d) => recebidos.push(d), aoResultado: () => {}, doc: docFalso() });
    await vi.advanceTimersByTimeAsync(0);       // poll 1 em voo
    await vi.advanceTimersByTimeAsync(30_000);  // poll 2 em voo
    expect(n).toBe(2);
    resolvedores[1](ok({ seq: 2 }));
    await vi.advanceTimersByTimeAsync(0);
    resolvedores[0](ok({ seq: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(recebidos).toEqual([{ seq: 2 }]);
    p.parar();
  });

  it("erro de rede => 'falha', sem derrubar o poll", async () => {
    const f = vi.fn(async () => { throw new Error("rede"); });
    const resultados: string[] = [];
    const p = criarPoll({ url: () => "/x", intervaloMs: 30_000, fetch: f, aoReceber: () => {}, aoResultado: (r) => resultados.push(r), doc: docFalso() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resultados).toEqual(["falha", "falha"]);
    p.parar();
  });
});
