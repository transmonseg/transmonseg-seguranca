// RAS-01 (auditoria 03/11): o mapa usava só o atraso_min da última gravação,
// que congela quando o motor para de gravar um cliente. A rota passa a
// devolver o atraso efetivo calculado no Postgres (now() do banco, nunca o
// relógio do navegador) e a hora estimada da posição.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sqlAtrasoEfetivo } from "@/lib/frescor-posicao";

const estado = vi.hoisted(() => ({
  agora: Date.parse("2026-11-03T20:00:00Z"),
  posicoes: [] as { placa: string; cv: string; atraso_min: number; updated_at: string; velocidade: number }[],
  sqls: [] as string[],
}));

// Mini "Postgres": a consulta de veículos só devolve atraso efetivo se o SQL
// pedir a expressão do frescor (sqlAtrasoEfetivo) com o alias certo; a conta
// em si é a mesma que o banco faz, sobre o updated_at da fixture.
vi.mock("pg", () => ({
  default: {
    Pool: vi.fn().mockImplementation(function () {
      return {
        connect: async () => ({
          release: () => {},
          query: async (sql: string) => {
            estado.sqls.push(sql);
            if (sql.includes("from clientes")) return { rows: [{ id: "cli-1" }] };
            if (sql.includes("from posicoes_atuais p")) {
              const temEfetivo = sql.includes(`${sqlAtrasoEfetivo("p")} as atraso_efetivo_min`);
              return {
                rows: estado.posicoes.map((p) => {
                  const idade = (estado.agora - Date.parse(p.updated_at)) / 60_000;
                  const efetivo = Math.max(p.atraso_min, idade);
                  return {
                    placa: p.placa, cv: p.cv, lat: -22.9, lng: -43.2, velocidade: p.velocidade, atraso_min: p.atraso_min,
                    ...(temEfetivo ? { atraso_efetivo_min: efetivo } : {}),
                    ...(sql.includes("as posicao_em") ? { posicao_em: new Date(Date.parse(p.updated_at) - p.atraso_min * 60_000).toISOString() } : {}),
                  };
                }),
              };
            }
            if (sql.includes("from bases")) return { rows: [{ gj: { type: "FeatureCollection", features: [] } }] };
            return { rows: [] };
          },
        }),
      };
    }),
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u" } } }) } }) }));
vi.mock("@/lib/supabase/contabo-ca", () => ({ configPoolContabo: () => ({}) }));
vi.mock("@/lib/acesso-cliente", () => ({ acessoDoUsuario: async () => ({ tipo: "todos" }), podeVerCod: async () => true }));
vi.mock("@/lib/unitrac", () => ({ buscarAlvos: async () => [], agruparPontosPorPlaca: () => new Map(), corrigirComPontoAprendido: (p: unknown) => p }));

const { GET } = await import("./route");

beforeEach(() => { estado.sqls = []; });

describe("GET /api/mapa: frescor real", () => {
  it("updated_at de 10 min atrás com atraso_min=0 devolve atraso_efetivo_min >= 10 e a hora da posição", async () => {
    estado.posicoes = [{ placa: "RQQ5B81", cv: "1", atraso_min: 0, updated_at: "2026-11-03T19:50:00Z", velocidade: 40 }];
    const r = await GET(new Request("http://x/api/mapa?cliente=4096"));
    expect(r.status).toBe(200);
    const { veiculos } = await r.json();
    expect(veiculos[0].atraso_efetivo_min).toBeGreaterThanOrEqual(10);
    expect(veiculos[0].posicao_em).toBe("2026-11-03T19:50:00.000Z");
    // calculado no banco: o SQL usa now() do Postgres, não um valor vindo do Node
    const sqlVeic = estado.sqls.find((s) => s.includes("from posicoes_atuais p"))!;
    expect(sqlVeic).toContain("now() - p.updated_at");
  });
});
