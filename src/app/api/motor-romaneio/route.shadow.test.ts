// Teste de INTEGRAÇÃO da rota motor-romaneio (Task Fase 4 Incremento 1,
// 27/08 -- ver
// .superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/task-fase4-inc1-brief.md).
//
// Por que este arquivo é SEPARADO de route.test.ts: aquele arquivo documenta
// no próprio cabeçalho a convenção "as regras vivem em funções PURAS
// exportadas da própria rota, testadas direto, sem mockar banco/rede" -- e
// os 592 testes lá dentro seguem isso à risca. Este arquivo faz o oposto de
// propósito: invoca o POST exportado de verdade, com banco (admin +
// pg.Pool) mockado. É o maior risco identificado pelo plano
// (2026-08-27-romaneio-fonte-unica-plano-geral.md, Fase 4): não existia
// NENHUM teste que exercitasse o handler HTTP inteiro desta rota -- só
// funções internas isoladas. O precedente de ESTILO pro mock (chain
// encadeavel do supabase-js resolvendo por `.then`, `createAdminClient`
// substituído por inteiro) é `src/app/api/romaneio/reverter/route.test.ts`;
// aqui o mock é mais elaborado porque a rota também fala Postgres cru via
// `pg.Pool` (`@/lib/supabase/contabo-ca` fica INTOCADO -- só o construtor
// `pg.Pool` é substituído, então `configPoolContabo` roda de verdade, sem
// I/O real).
//
// Escopo (mínimo aceitável, conforme o brief): UM veículo sintético, UM
// ciclo, com velocidade > 120 km/h (excesso de velocidade -- a mais simples
// das 3 opções que o brief permite, porque não depende de ignição/atraso
// como jammer nem fica presa a nenhuma lógica de parada). O resto da rota
// (Sinal A/desvio, os 3 detectores de parada) é deliberadamente DESLIGADO
// pelo cenário sintético (ver comentários abaixo) -- não é escopo desta
// task mexer nisso, e replicar toda a superfície de rede da rota (Unitrac,
// OSRM, Overpass, Fogo Cruzado, Roubo de Carga) só pra chegar até o código
// novo seria desproporcional ao "escopo mínimo aceitável" pedido.
//
// O cooldown de jammer (Task Fase 4 Incremento 1, "reaproveitado, testado")
// já tem cobertura própria em route.test.ts (bloco
// "suprimidoPorCooldownCandidato", que já testa tipo="jammer" antes desta
// task) -- aqui não duplicamos isso; ver também detectores.test.ts pro
// comportamento puro de detectarJammer/suprimidoPorCooldownTemporal.
import { describe, it, expect, vi, beforeEach } from "vitest";

const VEICULO_ID = "11111111-1111-1111-1111-111111111111";
const CLIENTE_ID = "22222222-2222-2222-2222-222222222222";

// vi.hoisted: precisa existir ANTES dos vi.mock (que o vitest hoisteia pro
// topo do arquivo) poderem referenciá-lo. Estado mutável, resetado no
// beforeEach de cada teste -- é o que permite cada `it` configurar seu
// próprio cenário de posicoes_atuais sem duplicar os mocks de módulo.
const mockState = vi.hoisted(() => ({
  veiculo: {
    id: "11111111-1111-1111-1111-111111111111",
    placa: "TST1A23",
    // cv VAZIO de propósito: cvsUnicos (route.ts) filtra cv falsy, então
    // NENHUMA chamada de rede pra Unitrac acontece neste cenário -- não é
    // escopo desta task mockar a API da Unitrac, e panico/jammer/excesso
    // não dependem dela (são 100% telemetria de posicoes_atuais).
    cv: "",
    cliente_id: "22222222-2222-2222-2222-222222222222",
  },
  posAtual: {
    veiculo_id: "11111111-1111-1111-1111-111111111111",
    lat: -22.0,
    lng: -43.0,
    velocidade: 150,
    atraso_min: 2,
    datagps: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    parado_desde: null as string | null,
    ignicao: false,
    panico: false,
    bau_aberto: false,
  },
  // presenca_confirmada_em PREENCHIDO de propósito: monta o ponto como
  // feito=true (ver montarPontosDeRomaneio, @/lib/romaneio) -- isso zera
  // `pendentes`, que zera `destinosRelevantes`, que faz deveAvaliarSinalA
  // retornar false SEM nenhuma chamada de rede (OSRM/match, distancia-real,
  // corredor-confirmacao) -- ver o comentário de route.ts:1714-1720 ("com
  // avaliaDesvio=false nada aqui dentro roda"). O Sinal A (desvio) não é
  // escopo desta task; isolar ele assim é deliberado, não um acidente de
  // teste incompleto.
  linhaRomaneio: {
    veiculo_id: "11111111-1111-1111-1111-111111111111",
    placa: "TST1A23",
    nf: "NF-TESTE-1",
    cliente_nome: "Cliente Teste Shadow",
    lat: -22.0,
    lng: -43.0,
    presenca_confirmada_em: new Date().toISOString() as string | null,
  },
  inserts: [] as Record<string, unknown>[],
}));

// Fake do supabase-js admin: cada `.from(tabela)` devolve um builder novo,
// encadeavel (select/insert/update/eq/in/not/gte/order/limit devolvem o
// próprio builder) que só resolve de verdade no `.then` -- mesmo truque do
// mock em romaneio/reverter/route.test.ts, generalizado pra várias tabelas
// porque esta rota fala com mais de uma.
vi.mock("@/lib/supabase/admin", () => {
  function criarBuilder(tabela: string) {
    let op: "select" | "insert" | "update" | null = null;
    let payload: unknown = null;
    const builder = {
      select() { op = "select"; return builder; },
      insert(p: unknown) { op = "insert"; payload = p; return builder; },
      update(p: unknown) { op = "update"; payload = p; return builder; },
      eq() { return builder; },
      in() { return builder; },
      not() { return builder; },
      gte() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject: (e: unknown) => unknown) {
        let resultado: { data: unknown; error: unknown };
        if (tabela === "veiculos" && op === "select") {
          resultado = { data: [mockState.veiculo], error: null };
        } else if (tabela === "posicoes_atuais" && op === "select") {
          resultado = { data: [mockState.posAtual], error: null };
        } else if (tabela === "clientes" && op === "select") {
          // cod_user_unitrac null => avaliaParadas=false
          // (decidirEscopoDoVeiculo) -- os 3 detectores de parada da task
          // B1 ficam desligados neste cenário, mesmo raciocínio de isolar
          // só o que esta task testa.
          resultado = { data: [{ id: mockState.veiculo.cliente_id, cod_user_unitrac: null }], error: null };
        } else if (tabela === "alertas_romaneio" && op === "insert") {
          mockState.inserts.push(payload as Record<string, unknown>);
          resultado = { data: null, error: null };
        } else if (tabela === "alertas_romaneio" && op === "update") {
          resultado = { data: null, error: null };
        } else {
          // Toda leitura de alertas_romaneio (abertos+sombra, falsos
          // recentes, paradas tratadas) começa vazia -- sem alerta prévio
          // pra deduplicar/escalar/silenciar neste cenário.
          resultado = { data: [], error: null };
        }
        return Promise.resolve(resultado).then(resolve, reject);
      },
    };
    return builder;
  }
  return { createAdminClient: () => ({ from: criarBuilder }) };
});

// Fake do pg.Pool: só o CONSTRUTOR é substituído (criaPgPool, route.ts,
// continua chamando configPoolContabo de verdade -- é parsing puro, sem
// I/O). Dispatch por trecho da SQL, não por posição -- a rota faz dezenas
// de pool.query() diferentes (celula_frequencia_cliente, corredor_celulas,
// escala_pontos, posicoes_historico, bases...) que não interessam a este
// teste; todas caem no default `{ rows: [] }`, seguro pra cada uma delas
// (todas são try/catch com fallback fail-open ou Map vazio no código real
// -- ver os comentários de route.ts em cada bloco).
vi.mock("pg", () => {
  async function pgQuery(sql: string) {
    if (/update\s+motor_lease/i.test(sql)) {
      // Serve tanto a aquisição do lease (com RETURNING token) quanto o
      // update de liberação no finally -- o valor de rows não é usado
      // nesse segundo caso.
      return { rows: [{ token: "token-teste" }] };
    }
    if (/from\s+romaneio_pontos/i.test(sql)) {
      return { rows: [mockState.linhaRomaneio] };
    }
    return { rows: [] };
  }
  class FakePool {
    query = pgQuery;
    async connect() {
      return { query: pgQuery, release: () => {} };
    }
    async end() {}
  }
  return { default: { Pool: FakePool } };
});

function requisicaoDoCron(): Request {
  return new Request("http://localhost/api/motor-romaneio", {
    method: "POST",
    headers: { "x-motor-key": "chave-teste" },
  });
}

describe("POST /api/motor-romaneio -- shadow mode (Task Fase 4 Incremento 1)", () => {
  beforeEach(() => {
    vi.stubEnv("MOTOR_SECRET", "chave-teste");
    mockState.inserts = [];
    mockState.posAtual = {
      veiculo_id: VEICULO_ID,
      lat: -22.0,
      lng: -43.0,
      velocidade: 150,
      atraso_min: 2,
      datagps: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      parado_desde: null,
      ignicao: false,
      panico: false,
      bau_aberto: false,
    };
  });

  it("veiculo com velocidade > 120 km/h gera linha em alertas_romaneio com sombra=true, tipo=excesso", async () => {
    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.erros).toEqual([]);
    expect(body.alertasGerados).toBeGreaterThanOrEqual(1);

    const alertaExcesso = mockState.inserts.find((i) => i.tipo === "excesso");
    expect(alertaExcesso).toBeDefined();
    expect(alertaExcesso?.sombra).toBe(true);
    expect(alertaExcesso?.veiculo_id).toBe(VEICULO_ID);
    expect(alertaExcesso?.cliente_id).toBe(CLIENTE_ID);
    expect(alertaExcesso?.nivel).toBe("critico");
  });

  it("a linha de shadow mode NAO aparece numa leitura filtrada por sombra=false (simula o que a UI ve)", async () => {
    const { POST } = await import("./route");
    await POST(requisicaoDoCron());

    // Simula exatamente o predicado que os 3 caminhos de leitura da UI
    // aplicam (alertas-romaneio/route.ts, central-romaneio/page.tsx,
    // mapa/route.ts) -- `.eq("sombra", false)` -- sobre o mesmo estado que
    // o insert real do ciclo gravou.
    const visivelNaUi = mockState.inserts.filter((i) => i.sombra !== true);
    expect(visivelNaUi.find((i) => i.tipo === "excesso")).toBeUndefined();

    // Confirma que o alerta existe (não é ausência por falha silenciosa) --
    // só não passa pelo filtro de visibilidade.
    expect(mockState.inserts.some((i) => i.tipo === "excesso")).toBe(true);
  });

  it("veiculo dentro do limite de velocidade (sem panico/jammer/ignicao) NAO gera nenhum alerta de shadow mode", async () => {
    mockState.posAtual = { ...mockState.posAtual, velocidade: 60, atraso_min: 2, ignicao: false, panico: false };
    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);
    expect(mockState.inserts.filter((i) => i.sombra === true)).toEqual([]);
  });
});
