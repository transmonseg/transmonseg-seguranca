// Revisao F3-07 (R1): as acoes do operador (Resolver, Falso positivo, Resolver
// todos, Limpar) gravavam contexto {} via STRIP_PESADO. O card agregado
// romaneio_ausente guarda no contexto quem ja' foi contado no dia (agregado,
// dia, placas, veiculo_ids): sem isso o motor nao reconhecia o card de hoje e
// abria outro no ciclo seguinte com todos os carros -- 1 card novo a cada
// clique, e a regra do card fechado pelo operador (carro novo abre o 2o;
// carro contado ainda rodando 60 min depois reabre o mesmo) nunca rodava. Aqui a acao real grava num banco em memoria e o ciclo
// seguinte do motor (planejarRomaneioAusente) le a linha como ela ficou.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { planejarRomaneioAusente, type AlertaRomaneioAusente, type VeiculoEmRota } from "@/lib/romaneio-ausente";

type Linha = Record<string, unknown>;
const tabela = vi.hoisted(() => ({ linhas: [] as Record<string, unknown>[] }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "op1", email: "op@transmonseg" } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      if (t === "operadores") return { upsert: async () => ({ error: null }) };
      const filtros: ((l: Record<string, unknown>) => boolean)[] = [];
      let patch: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {};
      b.update = (p: Record<string, unknown>) => { patch = p; return b; };
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filtros.push((l) => l[c] === v); return b; };
      b.neq = (c: string, v: unknown) => { filtros.push((l) => l[c] !== v); return b; };
      b.in = (c: string, v: unknown[]) => { filtros.push((l) => v.includes(l[c])); return b; };
      b.lte = (c: string, v: string) => { filtros.push((l) => String(l[c]) <= v); return b; };
      b.then = (res: (v: unknown) => unknown) => {
        const alvo = tabela.linhas.filter((l) => filtros.every((f) => f(l)));
        if (patch) for (const l of alvo) Object.assign(l, patch);
        return Promise.resolve({ data: alvo.map((l) => ({ id: l.id })), error: null }).then(res);
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/casos-desvio-revisao", () => ({ registrarCasosDesvioRevisao: vi.fn() }));
vi.mock("@/lib/detectores", () => ({ IDADE_MINIMA_ACAO_MASSA_MIN: 10 }));
vi.mock("@/app/api/alertas/route", () => ({ invalidarCacheAlertas: vi.fn() }));
vi.mock("@/app/api/alertas-romaneio/route", () => ({ invalidarCacheAlertasRomaneio: vi.fn() }));
vi.mock("@/app/api/mapa/route", () => ({ invalidarCacheMapa: vi.fn() }));
vi.mock("@/lib/acesso-cliente", () => ({ acessoDoUsuario: async () => ({ tipo: "todos" }) }));
vi.mock("@/lib/acesso-guardas", () => ({ idsAlertaPermitidos: async (_a: unknown, _t: unknown, ids: string[]) => ids }));

import { limparVarios, resolverAlerta, resolverVarios, marcarFalsoComCategoria } from "./acoes-alertas";

const NUTRY = "cfcb52f5-fd01-47c7-988c-d13a10f0d8fd";
const HOJE = "2026-10-21";
const AS_0610 = new Date("2026-10-21T09:10:00Z"); // 06:10 BRT
// 50 carros da Nutry rodando sem romaneio as 06:10 (21/10: 47-51 as 06:30).
const PLACAS = Array.from({ length: 50 }, (_, i) => `NTY-${String(1000 + i)}`);
const carro = (placa: string): VeiculoEmRota => ({ veiculo_id: `v-${placa}`, cliente_id: NUTRY, placa, lat: -22.85, lng: -43.3 });

function cardNutry(): Linha {
  return {
    id: "c1", cliente_id: NUTRY, veiculo_id: `v-${PLACAS[0]}`, tipo: "romaneio_ausente", status: "ativo",
    desde: "2026-10-21T08:41:00.000Z", motivo: "50 carros em rota sem romaneio", origem_acao: null,
    lat: -22.85, lng: -43.3,
    contexto: {
      agregado: true, dia: HOJE, placas: [...PLACAS], veiculo_ids: PLACAS.map((p) => `v-${p}`),
      em_rota_agora: 50, ultimo_envio: "2026-10-20T14:10:00Z", visto_em: "2026-10-21T09:05:00.000Z",
    },
  };
}

function cicloSeguinte(emRota: VeiculoEmRota[], agora = new Date(AS_0610.getTime() + 60_000)) {
  return planejarRomaneioAusente({
    emRota,
    existentes: tabela.linhas.filter((l) => l.tipo === "romaneio_ausente") as unknown as AlertaRomaneioAusente[],
    ultimoEnvio: { [NUTRY]: "2026-10-20T14:10:00Z" },
    hoje: HOJE,
    agora,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AS_0610);
  tabela.linhas = [cardNutry()];
});
afterEach(() => vi.useRealTimers());

describe("acoes do operador no card agregado romaneio_ausente (revisao F3-07, R1)", () => {
  it("06:10 Limpar no card da Nutry com 50 placas: o card guarda quem foi contado e o ciclo seguinte NAO abre card novo para os mesmos carros", async () => {
    const r = await limparVarios(["c1"], "alertas_romaneio");
    expect(r).toMatchObject({ ok: true, limpos: 1 });
    const card = tabela.linhas[0];
    expect(card).toMatchObject({ status: "limpo", origem_acao: "limpar_massa", lat: null, lng: null });
    expect(card.contexto).toMatchObject({ agregado: true, dia: HOJE, placas: PLACAS });

    expect(cicloSeguinte(PLACAS.map(carro))).toEqual({ inserir: [], atualizar: [], resolver: [] });
    // Carro que nao estava no card abre o 2o card do dia (nunca some).
    const novo = cicloSeguinte([...PLACAS.map(carro), carro("TTI-6E43")]);
    expect(novo.inserir).toHaveLength(1);
  });

  it("Resolver e Falso positivo individuais tambem mantem o contexto do card agregado", async () => {
    await resolverAlerta("c1", "alertas_romaneio");
    expect(tabela.linhas[0]).toMatchObject({ status: "resolvido", origem_acao: "resolver_individual", lat: null, lng: null });
    expect((tabela.linhas[0].contexto as Linha).placas).toEqual(PLACAS);
    expect(cicloSeguinte(PLACAS.map(carro)).inserir).toEqual([]);

    tabela.linhas = [cardNutry()];
    await marcarFalsoComCategoria("c1", "DESATUALIZADO", "alertas_romaneio");
    expect(tabela.linhas[0]).toMatchObject({ status: "falso_positivo", origem_acao: "falso_individual" });
    expect((tabela.linhas[0].contexto as Linha).veiculo_ids).toHaveLength(50);
    expect(cicloSeguinte(PLACAS.map(carro)).inserir).toEqual([]);
  });

  it("Resolver todos com desvio e romaneio_ausente juntos: so' o desvio perde o contexto (strip de antes)", async () => {
    tabela.linhas.push({
      id: "d1", cliente_id: NUTRY, veiculo_id: "v-X", tipo: "desvio", status: "ativo", desde: "2026-10-21T08:00:00.000Z",
      origem_acao: null, lat: -22.9, lng: -43.2, contexto: { origem_desvio: "sinal_a", pesado: [1, 2, 3] },
    });
    const r = await resolverVarios(["c1", "d1"], "alertas_romaneio");
    expect(r).toMatchObject({ ok: true, resolvidos: 2 });
    const [card, desvio] = tabela.linhas;
    expect(desvio).toMatchObject({ status: "resolvido", origem_acao: "resolver_massa", contexto: {}, lat: null, lng: null });
    expect(card).toMatchObject({ status: "resolvido", origem_acao: "resolver_massa", lat: null, lng: null });
    expect((card.contexto as Linha).placas).toEqual(PLACAS);
  });

  it("guard de idade minima continua valendo nas duas partes do Limpar (card de 5 min nao fecha)", async () => {
    tabela.linhas[0].desde = "2026-10-21T09:05:00.000Z";
    const r = await limparVarios(["c1"], "alertas_romaneio");
    expect(r).toMatchObject({ ok: true, limpos: 0, ignoradosRecentes: 1 });
    expect(tabela.linhas[0].status).toBe("ativo");
  });

  // Decisao do dono (R1 F3-07, recall): fechar o card nao pode esconder pelo
  // resto do dia carro que segue rodando sem romaneio. 60 min depois do
  // fechamento, se algum carro ja' contado continua em rota sem romaneio, o
  // MESMO card reabre com o texto atualizado.
  it("Limpar as 06:10 no card da Nutry com 50 placas; as 07:15 ainda 30 delas rodando sem romaneio => o mesmo card reabre", async () => {
    await limparVarios(["c1"], "alertas_romaneio");
    const rodando = PLACAS.slice(0, 30).map(carro);
    // 06:40: so' 30 min depois do Limpar -- ainda nao reabre.
    expect(cicloSeguinte(rodando, new Date("2026-10-21T09:40:00Z"))).toEqual({ inserir: [], atualizar: [], resolver: [] });

    const p = cicloSeguinte(rodando, new Date("2026-10-21T10:15:00Z")); // 07:15 BRT
    expect(p.inserir).toEqual([]);
    expect(p.resolver).toEqual([]);
    expect(p.atualizar).toHaveLength(1);
    expect(p.atualizar[0].id).toBe("c1");
    expect(p.atualizar[0].patch).toMatchObject({ status: "ativo", resolvido_em: null, origem_acao: null });
    expect(p.atualizar[0].patch.motivo).toMatch(/^50 carros em rota sem romaneio \(30 agora\), /);
    expect(p.atualizar[0].patch.contexto).toMatchObject({ placas: PLACAS, em_rota_agora: 30, reaberto_apos_operador: 1 });
  });

  it("Limpar as 06:10; as 07:15 todos os 50 ja' com romaneio (nenhum em rota sem) => nao reabre", async () => {
    await limparVarios(["c1"], "alertas_romaneio");
    expect(cicloSeguinte([], new Date("2026-10-21T10:15:00Z"))).toEqual({ inserir: [], atualizar: [], resolver: [] });
  });
});
