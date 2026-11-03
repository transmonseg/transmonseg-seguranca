// DSV-01 + DSV-02 (auditoria 03/11) no ciclo de verdade: o POST roda com
// banco (admin + pg.Pool) e rede (OSRM) falsos, para travar o que vai para
// alertas_romaneio e para alertas_romaneio_disparos quando o carro dispara
// desvio. A regra pura (planejarDisparoDesvio) tem teste em route.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const VEICULO_ID = "11111111-1111-1111-1111-111111111111";
const CLIENTE_ID = "22222222-2222-2222-2222-222222222222";

const st = vi.hoisted(() => ({
  agora: new Date(),
  alertasAbertos: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  updates: [] as { id: unknown; payload: Record<string, unknown> }[],
  disparos: [] as unknown[][],
  ultimoDisparo: null as string | null,
  trilhaQuebrada: false,
  presenca: null as string | null,
  base: null as { lat: number; lng: number } | null,
}));

vi.mock("@/lib/supabase/admin", () => {
  function builder(tabela: string) {
    let op: "select" | "insert" | "update" | null = null;
    let cols = "";
    let payload: unknown = null;
    const eqs: [string, unknown][] = [];
    const b = {
      select(c?: string) { if (op === null) { op = "select"; cols = c ?? ""; } return b; },
      insert(p: unknown) { op = "insert"; payload = p; return b; },
      update(p: unknown) { op = "update"; payload = p; return b; },
      eq(c: string, v: unknown) { eqs.push([c, v]); return b; },
      in() { return b; }, not() { return b; }, gte() { return b; }, order() { return b; }, limit() { return b; }, single() { return b; },
      then(res: (v: { data: unknown; error: unknown }) => unknown, rej: (e: unknown) => unknown) {
        let r: { data: unknown; error: unknown } = { data: [], error: null };
        if (tabela === "veiculos") r = { data: [{ id: VEICULO_ID, placa: "TOS-4J82", cv: "", cliente_id: CLIENTE_ID }], error: null };
        else if (tabela === "posicoes_atuais") r = { data: [{
          veiculo_id: VEICULO_ID, lat: -22.01, lng: -43.0, velocidade: 40, atraso_min: 1,
          datagps: st.agora.toISOString(), updated_at: st.agora.toISOString(), parado_desde: null,
          ignicao: true, panico: false, bau_aberto: false,
        }], error: null };
        else if (tabela === "clientes") r = { data: [{ id: CLIENTE_ID, cod_user_unitrac: null }], error: null };
        else if (tabela === "alertas_romaneio" && op === "insert") { st.inserts.push(payload as Record<string, unknown>); r = { data: null, error: null }; }
        else if (tabela === "alertas_romaneio" && op === "update") { st.updates.push({ id: eqs.find(([c]) => c === "id")?.[1], payload: payload as Record<string, unknown> }); r = { data: null, error: null }; }
        else if (tabela === "alertas_romaneio" && op === "select" && cols.includes("nivel")) r = { data: st.alertasAbertos, error: null };
        return Promise.resolve(r).then(res, rej);
      },
    };
    return b;
  }
  return { createAdminClient: () => ({ from: builder }) };
});

vi.mock("pg", () => {
  async function q(sql: string, params: unknown[] = []) {
    if (/update\s+motor_lease/i.test(sql)) return { rows: [{ token: "t" }] };
    if (/AS nfs|AS tem_romaneio|max\(rp\.criado_em\)/i.test(sql)) return { rows: [] };
    if (/from\s+alertas_romaneio_disparos/i.test(sql)) {
      if (st.trilhaQuebrada) throw new Error('relation "alertas_romaneio_disparos" does not exist');
      return { rows: [{ t: st.ultimoDisparo }] };
    }
    if (/insert into alertas_romaneio_disparos/i.test(sql)) {
      if (st.trilhaQuebrada) throw new Error('relation "alertas_romaneio_disparos" does not exist');
      st.disparos.push(params);
      return { rows: [] };
    }
    if (/ST_Centroid/i.test(sql)) {
      return { rows: st.base ? [{ cliente_id: CLIENTE_ID, ...st.base }] : [] };
    }
    if (/from\s+romaneio_pontos/i.test(sql)) {
      return { rows: [{ veiculo_id: VEICULO_ID, placa: "TOS-4J82", nf: "1", cliente_nome: "CLIENTE", lat: -21.9, lng: -43.0, presenca_confirmada_em: st.presenca }] };
    }
    if (/from\s+romaneio_desvio_estado/i.test(sql)) {
      return { rows: [{ veiculo_id: VEICULO_ID, afastando_streak: 1, rua_rara_streak: 0, ultima_via_principal_em: null, saiu_parada_confirmada_em: null, atualizado_em: st.agora, ultimo_datagps: null }] };
    }
    if (/from\s+posicoes_historico/i.test(sql)) {
      return { rows: [{ lat: -22.0, lng: -43.0, velocidade: 40, atraso_min: 1, criado_em: new Date(st.agora.getTime() - 30_000) }] };
    }
    return { rows: [] };
  }
  class FakePool { query = q; async connect() { return { query: q, release: () => {} }; } async end() {} }
  return { default: { Pool: FakePool } };
});

// Rede: distância em linha reta no lugar do OSRM; sem /match e sem corredor.
vi.mock("@/lib/distancia-real", async () => {
  const { haversineM } = await import("@/lib/unitrac");
  return {
    buscarDistanciasReais: async (o: { lat: number; lng: number }, ds: { lat: number; lng: number }[]) =>
      ds.map((d) => haversineM(o.lat, o.lng, d.lat, d.lng)),
  };
});
vi.mock("@/lib/osrm-match", () => ({ corrigirPosicoesComMatch: async () => null }));
vi.mock("@/lib/corredor-confirmacao", async (orig) => ({
  ...(await orig<typeof import("@/lib/corredor-confirmacao")>()),
  verificarCorredorFora: async () => ({ confirmaFora: false }),
}));

import { POST } from "./route";

const req = () => new Request("http://localhost/api/motor-romaneio", { method: "POST", headers: { "x-motor-key": "k" } });
const minAtras = (m: number) => new Date(st.agora.getTime() - m * 60_000).toISOString();
function alertaAberto() {
  return {
    id: "alerta-1", veiculo_id: VEICULO_ID, tipo: "desvio", nivel: "critico", desde: minAtras(120), lat: -22.5, lng: -43.5,
    motivo: "m", contexto: { origem_desvio: "afastando_geral", episodios: [{ desde: minAtras(120), lat: -22.5, lng: -43.5, motivo: "m" }] },
  };
}

beforeEach(() => {
  vi.stubEnv("MOTOR_SECRET", "k");
  st.agora = new Date();
  st.alertasAbertos = []; st.inserts = []; st.updates = []; st.disparos = [];
  st.ultimoDisparo = null; st.trilhaQuebrada = false;
  st.presenca = null; st.base = null;
});

describe("POST /api/motor-romaneio -- episodio de desvio e trilha (DSV-01/02)", () => {
  it("1o disparo: cria o card com id proprio, 1 episodio no contexto e 1 linha na trilha", async () => {
    const r = await (await POST(req())).json();
    expect(r.erros).toEqual([]);
    const desvio = st.inserts.find((i) => i.tipo === "desvio");
    expect(desvio).toBeDefined();
    expect(typeof desvio!.id).toBe("string");
    expect((desvio!.contexto as { episodios: unknown[] }).episodios).toHaveLength(1);
    expect(st.disparos).toHaveLength(1);
    expect(st.disparos[0][0]).toBe(desvio!.id); // alerta_id
    expect(st.disparos[0][3]).toBe("desvio");
  });

  it("card aberto e ultimo disparo ha 15 min: reabre (desde, lat e 2 episodios) e grava o disparo", async () => {
    st.alertasAbertos = [alertaAberto()];
    st.ultimoDisparo = minAtras(15);
    await POST(req());
    const up = st.updates.find((u) => u.id === "alerta-1");
    expect(up).toBeDefined();
    expect(Date.parse(String(up!.payload.desde))).toBeGreaterThan(Date.parse(minAtras(1)));
    expect(up!.payload.lat).toBe(-22.01);
    expect((up!.payload.contexto as { episodios: unknown[] }).episodios).toHaveLength(2);
    expect(st.inserts.filter((i) => i.tipo === "desvio")).toHaveLength(0);
    expect(st.disparos).toHaveLength(1);
    expect(st.disparos[0][0]).toBe("alerta-1");
  });

  it("card aberto e ultimo disparo ha 5 min: nada muda no card, so' a trilha", async () => {
    st.alertasAbertos = [alertaAberto()];
    st.ultimoDisparo = minAtras(5);
    await POST(req());
    expect(st.updates.filter((u) => u.id === "alerta-1")).toEqual([]);
    expect(st.disparos).toHaveLength(1);
  });

  it("trilha sem a tabela 092: nao reabre, avisa uma vez em erros e o ciclo segue", async () => {
    st.alertasAbertos = [alertaAberto()];
    st.trilhaQuebrada = true;
    const r = await (await POST(req())).json();
    expect(st.updates.filter((u) => u.id === "alerta-1")).toEqual([]);
    expect(r.erros.filter((e: string) => e.includes("alertas_romaneio_disparos"))).toHaveLength(1);
    expect(r.veiculosProcessados).toBe(1);
  });
});

describe("POST /api/motor-romaneio -- base e rota concluida (DSV-03/04)", () => {
  it("entrega pendente + carro indo PRA base (longe do cliente): dispara critico (a base nao encobre)", async () => {
    // carro anda de -22.00 para -22.01 (sul); pendente ao norte (-21.9) e base ao sul (-22.3)
    st.base = { lat: -22.3, lng: -43.0 };
    await POST(req());
    const d = st.inserts.find((i) => i.tipo === "desvio");
    expect(d?.nivel).toBe("critico");
    expect(String(d?.motivo)).toMatch(/Afastando de todos/);
  });

  it("rota concluida (0 pendente), afastando da base: alerta sai como atencao com texto verdadeiro", async () => {
    st.presenca = new Date().toISOString();
    st.base = { lat: -21.95, lng: -43.0 };
    await POST(req());
    const d = st.inserts.find((i) => i.tipo === "desvio");
    expect(d).toBeDefined();
    expect(d!.nivel).toBe("atencao");
    expect(d!.motivo).toBe("Rota concluída: sem cliente pendente a 50 km");
    expect((d!.contexto as { origem_desvio: string }).origem_desvio).toBe("sem_destinos");
  });
});
