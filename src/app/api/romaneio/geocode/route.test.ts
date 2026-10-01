import { describe, it, expect, vi, beforeEach } from "vitest";

// Incidente 01/10 (ver src/lib/cnefe-similaridade-limitada.ts): testes da
// ponte com o banco falso -- so' a RPC de similaridade importa aqui.
const PONTO = { lat: -22.9, lng: -43.2 };
const estado = {
  ativas: 0,
  pico: 0,
  chamadas: 0,
  atrasoMs: 5,
  resposta: [] as { lat: number; lng: number }[],
};

function consultaVazia() {
  const resultado = { data: [], error: null };
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit", "ilike", "gt", "not", "order"]) builder[m] = () => builder;
  // cache: devolve ponto de cidade/bairro (evita Nominatim no teste)
  builder.in = (_col: string, chaves: string[]) => ({
    then: (ok: (v: unknown) => unknown) =>
      ok({
        data: chaves
          .filter((c) => c.startsWith("CIDADE:") || c.startsWith("BAIRRO:"))
          .map((c) => ({ endereco_normalizado: c, ...PONTO, fonte: "nominatim", validado: true })),
        error: null,
      }),
  });
  builder.then = (ok: (v: unknown) => unknown) => ok(resultado);
  return builder;
}

const admin = {
  from: () => consultaVazia(),
  rpc: (nome: string) => {
    const executar = async () => {
      if (nome !== "cnefe_buscar_por_similaridade") return { data: [], error: null };
      estado.chamadas++;
      estado.ativas++;
      estado.pico = Math.max(estado.pico, estado.ativas);
      await new Promise((r) => setTimeout(r, estado.atrasoMs));
      estado.ativas--;
      return { data: estado.resposta, error: null };
    };
    let p: Promise<unknown> | null = null;
    const b = {
      abortSignal: () => b,
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => (p ??= executar()).then(ok, err),
    };
    return b;
  },
};
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

// Corta a cascata depois do CNEFE (sem OSM/Google/Nominatim throttled de
// 1,1s): o que se testa aqui e' o caminho da similaridade.
vi.mock("@/lib/romaneio-geocode", async (orig) => {
  const real = await orig<typeof import("@/lib/romaneio-geocode")>();
  return {
    ...real,
    geocodificarEndereco: async (e: string, ponto: { lat: number; lng: number } | null, deps: { geocodificarCnefeDep: (e: string, p: unknown) => Promise<{ lat: number; lng: number } | null> }) => {
      const c = await deps.geocodificarCnefeDep(e, ponto);
      return c ? { ...c, fonte: "cnefe", validado: ponto != null } : null;
    },
  };
});

// Permite simular timeout de uma busca especifica sem esperar 20s reais.
const termosComTimeout = new Set<string>();
vi.mock("@/lib/cnefe-similaridade-limitada", async (orig) => {
  const real = await orig<typeof import("@/lib/cnefe-similaridade-limitada")>();
  return {
    ...real,
    buscarSimilaridadeLimitada: (async (consulta, opcoes = {}) => {
      if (!opcoes.pular && opcoes.rotulo && [...termosComTimeout].some((t) => opcoes.rotulo!.includes(t))) return { status: "timeout" };
      return real.buscarSimilaridadeLimitada(consulta, opcoes);
    }) as typeof real.buscarSimilaridadeLimitada,
  };
});

import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://local/api/romaneio/geocode", {
    method: "POST",
    headers: { "content-type": "application/json", "x-motor-key": "segredo" },
    body: JSON.stringify(body),
  });
}
const enderecos = (prefixo: string, n: number) =>
  Array.from({ length: n }, (_, i) => `RUA ${prefixo} NUMERO ${i}, ${i + 1} - CENTRO, RIO DE JANEIRO - *`);

beforeEach(() => {
  process.env.MOTOR_SECRET = "segredo";
  Object.assign(estado, { ativas: 0, pico: 0, chamadas: 0, atrasoMs: 5, resposta: [] });
  termosComTimeout.clear();
});

describe("POST /api/romaneio/geocode -- busca por similaridade limitada (incidente 01/10)", () => {
  it("duas geracoes simultaneas: nunca mais de 2 buscas por similaridade ao mesmo tempo no processo", async () => {
    const [a, b] = await Promise.all([
      POST(req({ enderecos: enderecos("RQ", 15) })),
      POST(req({ enderecos: enderecos("NUTRY", 15) })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(estado.chamadas).toBeGreaterThanOrEqual(30);
    expect(estado.pico).toBeLessThanOrEqual(2);
  });

  it("nada estoura: resultado igual ao da cascata, sem incompletos, e conta as buscas feitas", async () => {
    estado.resposta = [PONTO];
    const res = await POST(req({ enderecos: enderecos("OK", 2) }));
    const corpo = await res.json();
    expect(corpo.resultados).toEqual([
      { ...PONTO, fonte: "cnefe", validado: true },
      { ...PONTO, fonte: "cnefe", validado: true },
    ]);
    expect(corpo.incompletos).toEqual([]);
    expect(corpo.buscasSimilaridade).toBe(estado.chamadas);
  });

  it("timeout numa busca: endereco segue como nao achado nesse passo e volta em `incompletos`", async () => {
    termosComTimeout.add("LENTA");
    const lista = [...enderecos("RAPIDA", 1), ...enderecos("LENTA", 1)];
    const corpo = await (await POST(req({ enderecos: lista }))).json();
    expect(corpo.resultados).toEqual([null, null]);
    expect(corpo.incompletos).toEqual([1]);
  });

  it("semSimilaridade=true (teto da geracao do lado do KPI): nao consulta a RPC, enderecos que precisariam dela voltam em `incompletos`", async () => {
    const corpo = await (await POST(req({ enderecos: enderecos("TETO", 3), semSimilaridade: true }))).json();
    expect(estado.chamadas).toBe(0);
    expect(corpo.resultados).toEqual([null, null, null]);
    expect(corpo.incompletos).toEqual([0, 1, 2]);
    expect(corpo.buscasSimilaridade).toBe(0);
  });
});
