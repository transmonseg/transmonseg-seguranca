// Teste de INTEGRAÇÃO da rota motor-romaneio (Task Fase 4 Incremento 1,
// 27/08 -- ver
// .superpowers/sdd/2026-08-27-romaneio-fonte-unica-plano-geral/task-fase4-inc1-brief.md,
// task-fase4-inc1-report.md e a rodada de fix pós-revisão-independente
// registrada no mesmo relatório).
//
// Por que este arquivo é SEPARADO de route.test.ts: aquele arquivo documenta
// no próprio cabeçalho a convenção "as regras vivem em funções PURAS
// exportadas da própria rota, testadas direto, sem mockar banco/rede" -- e
// os testes lá dentro seguem isso à risca. Este arquivo faz o oposto de
// propósito: invoca o POST exportado de verdade, com banco (admin +
// pg.Pool) mockado -- e, num dos testes (IMPORTANTE 4), também o GET de
// alertas-romaneio/route.ts, pra provar de verdade que o filtro de shadow
// mode sobrevive na leitura, não só no insert.
//
// O precedente de ESTILO pro mock (chain encadeavel do supabase-js
// resolvendo por `.then`, `createAdminClient` substituído por inteiro) é
// `src/app/api/romaneio/reverter/route.test.ts`; aqui o mock é mais
// elaborado porque (a) a rota também fala Postgres cru via `pg.Pool`
// (`@/lib/supabase/contabo-ca` fica INTOCADO -- só o construtor `pg.Pool` é
// substituído, então `configPoolContabo` roda de verdade, sem I/O real) e
// (b) o mock de `alertas_romaneio` precisa aplicar filtros `.eq()` de
// verdade sobre um dataset configurável, pra que um teste que remova
// `.eq("sombra", false)` do código real quebre o teste (mock ingênuo que só
// devolve dado fixo não pegaria essa regressão).
import { describe, it, expect, vi, beforeEach } from "vitest";

const VEICULO_ID = "11111111-1111-1111-1111-111111111111";
const CLIENTE_ID = "22222222-2222-2222-2222-222222222222";

// vi.hoisted: precisa existir ANTES dos vi.mock (que o vitest hoisteia pro
// topo do arquivo) poderem referenciá-lo. Estado mutável, resetado no
// beforeEach de cada teste -- é o que permite cada `it` configurar seu
// próprio cenário sem duplicar os mocks de módulo.
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
    velocidade: 0,
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
  // corredor-confirmacao) -- ver o comentário de route.ts ("com
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
  // CRÍTICO 1 (revisão independente 27/08): quando preenchido, simula
  // romaneio_desvio_estado.ultimo_datagps já gravado igual (ou depois) do
  // posAtual.datagps deste ciclo -- dispara o `continue` de idempotência
  // que bloqueia Sinal A/paradas/state-write. jammer precisa disparar
  // MESMO ASSIM (ver processarJammerIndependente, route.ts).
  ultimoDatagpsGravado: null as string | null,
  inserts: [] as Record<string, unknown>[],
  // CRÍTICO 2 (revisão independente 27/08): quando true, a leitura de
  // alertas_romaneio que pede a coluna `sombra` (o probe de
  // sombraDisponivel) devolve erro -- simula tanto "coluna não existe"
  // quanto qualquer outra falha transiente no probe. O código tem que se
  // comportar da MESMA forma nos dois casos: nunca inserir candidato de
  // shadow mode sem a coluna confirmada.
  probeSombraErro: false,
  // IMPORTANTE 4: dataset genérico pro teste do caminho de LEITURA
  // (alertas-romaneio/route.ts) -- só usado quando usarDatasetLeitura=true,
  // filtrado de verdade pelos `.eq()` que o código sob teste chamar (não é
  // um mock ingênuo que devolve dado fixo).
  usarDatasetLeitura: false,
  alertasRomaneioLeitura: [] as Record<string, unknown>[],
  // Item de acabamento (segunda revisão, 27/08): alertas JÁ ABERTOS que a
  // rota vai ler no início do ciclo (a mesma leitura que alimenta tanto o
  // dedup do Step 9 quanto `alertaExistente` de processarJammerIndependente).
  // Usado pelo teste "Step 9 não fecha jammer que continua ativo" -- as
  // outras leituras de alertas_romaneio nos testes de POST continuam vazias
  // por padrão (ver o `else` do dispatch abaixo).
  alertasAbertosPreexistentes: [] as Record<string, unknown>[],
  // Captura os .update() feitos em alertas_romaneio, com o id do
  // .eq("id", ...) que os acompanha -- é o que permite provar que o Step 9
  // NÃO tentou fechar um alerta específico (nenhuma entrada em `updates`
  // com aquele id), não só que o ciclo não crashou.
  updates: [] as { id: unknown; payload: Record<string, unknown> }[],
}));

// Fake do supabase-js admin: cada `.from(tabela)` devolve um builder novo,
// encadeavel (select/insert/update/eq/in/not/gte/order/limit/single
// devolvem o próprio builder) que só resolve de verdade no `.then` -- mesmo
// truque do mock em romaneio/reverter/route.test.ts, generalizado porque
// esta rota fala com mais de uma tabela e o teste IMPORTANTE 4 precisa
// filtrar de verdade por `.eq()`.
vi.mock("@/lib/supabase/admin", () => {
  function criarBuilder(tabela: string) {
    let op: "select" | "insert" | "update" | null = null;
    let selectCols = "";
    let payload: unknown = null;
    let single = false;
    const eqFiltros: [string, unknown][] = [];
    const builder = {
      select(cols?: string) { op = "select"; selectCols = cols ?? ""; return builder; },
      insert(p: unknown) { op = "insert"; payload = p; return builder; },
      update(p: unknown) { op = "update"; payload = p; return builder; },
      eq(col: string, val: unknown) { eqFiltros.push([col, val]); return builder; },
      in() { return builder; },
      not() { return builder; },
      gte() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      single() { single = true; return builder; },
      then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject: (e: unknown) => unknown) {
        let resultado: { data: unknown; error: unknown };
        if (tabela === "veiculos" && op === "select") {
          resultado = { data: [mockState.veiculo], error: null };
        } else if (tabela === "posicoes_atuais" && op === "select") {
          resultado = { data: [mockState.posAtual], error: null };
        } else if (tabela === "clientes" && op === "select") {
          const linha = { id: mockState.veiculo.cliente_id, cod_user_unitrac: null as string | null };
          resultado = single ? { data: linha, error: null } : { data: [linha], error: null };
        } else if (tabela === "alertas_romaneio" && op === "insert") {
          mockState.inserts.push(payload as Record<string, unknown>);
          resultado = { data: null, error: null };
        } else if (tabela === "alertas_romaneio" && op === "update") {
          // Captura pra provar AUSÊNCIA de update sobre um id específico
          // (ver o teste "Step 9 não fecha jammer ativo") -- id vem do
          // .eq("id", ...) que sempre acompanha um update nesta rota
          // (resolverPelaMaquina e a escalação do Step 9).
          const idAlvo = eqFiltros.find(([col]) => col === "id")?.[1];
          mockState.updates.push({ id: idAlvo, payload: payload as Record<string, unknown> });
          resultado = { data: null, error: null };
        } else if (tabela === "alertas_romaneio" && op === "select") {
          const pedeColunaSombra = selectCols.includes("sombra");
          if (pedeColunaSombra && mockState.probeSombraErro) {
            // CRÍTICO 2: simula tanto "coluna sombra não existe" (migration
            // 062 não aplicada) quanto qualquer outra falha transiente no
            // probe -- o código de produção não pode (e não deve) tentar
            // distinguir os dois motivos, ver route.ts.
            resultado = { data: null, error: { message: "column alertas_romaneio.sombra does not exist" } };
          } else if (mockState.usarDatasetLeitura) {
            // IMPORTANTE 4: filtra de verdade pelos `.eq()` acumulados --
            // se o código sob teste não chamar `.eq("sombra", false)`, o
            // filtro `col==="sombra"` não existe em eqFiltros e a linha
            // sombra=true passa, o teste falha de verdade.
            const linhas = mockState.alertasRomaneioLeitura.filter((linha) =>
              eqFiltros.every(([col, val]) => (linha as Record<string, unknown>)[col] === val)
            );
            resultado = { data: linhas, error: null };
          } else if (selectCols.includes("nivel")) {
            // A leitura de "alertas EM ABERTO" (route.ts) é a única das 3
            // selects internas de alertas_romaneio que pede `nivel` --
            // paradasTratadas pede "tipo, veiculo_id, resolvido_em" e
            // falsosRecentes pede "tipo, veiculo_id, contexto", nenhuma das
            // duas tem "nivel". Alimenta tanto o dedup do Step 9 quanto
            // `alertaExistente` de processarJammerIndependente -- mesma
            // leitura, mesmo dado, exatamente como no código real.
            resultado = { data: mockState.alertasAbertosPreexistentes, error: null };
          } else {
            // paradasTratadas / falsosRecentes: sem dado prévio nos
            // cenários cobertos por este arquivo.
            resultado = { data: [], error: null };
          }
        } else {
          resultado = { data: [], error: null };
        }
        return Promise.resolve(resultado).then(resolve, reject);
      },
    };
    return builder;
  }
  return { createAdminClient: () => ({ from: criarBuilder }) };
});

// Fake do createClient de @/lib/supabase/server -- só o GET de
// alertas-romaneio/route.ts (teste IMPORTANTE 4) usa auth; motor-romaneio
// não importa este módulo.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "operador-teste" } } }) } }),
}));

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
    if (/from\s+romaneio_desvio_estado/i.test(sql)) {
      // CRÍTICO 1: só devolve uma linha (com ultimo_datagps) quando o
      // teste configurou mockState.ultimoDatagpsGravado -- senão, "nunca
      // processado antes" (comportamento default dos outros testes).
      if (mockState.ultimoDatagpsGravado) {
        return {
          rows: [{
            veiculo_id: VEICULO_ID,
            afastando_streak: 0,
            rua_rara_streak: 0,
            ultima_via_principal_em: null,
            saiu_parada_confirmada_em: null,
            atualizado_em: null,
            // pg de verdade parseia timestamptz pra Date -- replicado aqui
            // pra bater com o tipo real que route.ts espera
            // (EstadoAnterior.ultimo_datagps: Date | null).
            ultimo_datagps: new Date(mockState.ultimoDatagpsGravado),
          }],
        };
      }
      return { rows: [] };
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
    mockState.ultimoDatagpsGravado = null;
    mockState.probeSombraErro = false;
    mockState.usarDatasetLeitura = false;
    mockState.alertasRomaneioLeitura = [];
    mockState.alertasAbertosPreexistentes = [];
    mockState.updates = [];
    mockState.posAtual = {
      veiculo_id: VEICULO_ID,
      lat: -22.0,
      lng: -43.0,
      velocidade: 0,
      atraso_min: 2,
      datagps: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      parado_desde: null,
      ignicao: false,
      panico: false,
      bau_aberto: false,
    };
  });

  it("veiculo com velocidade > 120 km/h gera linha em alertas_romaneio com sombra=true, tipo=excesso (contado em alertasSombraGerados, NAO em alertasGerados)", async () => {
    mockState.posAtual = { ...mockState.posAtual, velocidade: 150 };
    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.erros).toEqual([]);
    // MENOR 5 (revisão independente): alertasGerados não conta shadow mode.
    expect(body.alertasGerados).toBe(0);
    expect(body.alertasSombraGerados).toBeGreaterThanOrEqual(1);

    const alertaExcesso = mockState.inserts.find((i) => i.tipo === "excesso");
    expect(alertaExcesso).toBeDefined();
    expect(alertaExcesso?.sombra).toBe(true);
    expect(alertaExcesso?.veiculo_id).toBe(VEICULO_ID);
    expect(alertaExcesso?.cliente_id).toBe(CLIENTE_ID);
    expect(alertaExcesso?.nivel).toBe("critico");
  });

  it("veiculo com panico=true gera linha em alertas_romaneio com sombra=true, tipo=panico", async () => {
    mockState.posAtual = { ...mockState.posAtual, panico: true };
    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);
    const alertaPanico = mockState.inserts.find((i) => i.tipo === "panico");
    expect(alertaPanico).toBeDefined();
    expect(alertaPanico?.sombra).toBe(true);
    expect(alertaPanico?.nivel).toBe("critico");
  });

  it("veiculo com ignicao ligada + atraso alto (jammer, datagps FRESCO) gera linha com sombra=true, tipo=jammer", async () => {
    mockState.posAtual = { ...mockState.posAtual, ignicao: true, atraso_min: 45, velocidade: 0 };
    // ultimoDatagpsGravado deliberadamente null aqui -- este teste cobre o
    // caso "datagps avançou normalmente" (sem idempotência bloqueando); o
    // teste CRITICO 1 abaixo cobre o caso em que datagps NÃO avançou.
    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);
    const alertaJammer = mockState.inserts.find((i) => i.tipo === "jammer");
    expect(alertaJammer).toBeDefined();
    expect(alertaJammer?.sombra).toBe(true);
    expect(alertaJammer?.nivel).toBe("critico");
  });

  it("CRITICO 1 (revisao independente 27/08): jammer dispara mesmo quando datagps NAO avancou -- o continue de idempotencia do Sinal A bloqueia o resto do veiculo, mas jammer roda antes dele", async () => {
    const datagpsCongelado = "2026-08-27T10:00:00.000Z";
    mockState.posAtual = {
      ...mockState.posAtual,
      ignicao: true,
      atraso_min: 45,
      velocidade: 0,
      datagps: datagpsCongelado,
    };
    // ultimo_datagps GRAVADO igual ao datagps desta leitura -- dispara
    // `datagps <= ultimo_datagps` (route.ts), o continue de idempotência
    // que bloqueia Sinal A/paradas/state-write pro resto do veiculo neste
    // ciclo. ANTES do fix, jammer também ficava preso atrás desse
    // continue (nunca disparava durante um jammer real, porque a própria
    // definição de jammer é datagps congelado).
    mockState.ultimoDatagpsGravado = datagpsCongelado;

    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);

    const alertaJammer = mockState.inserts.find((i) => i.tipo === "jammer");
    expect(alertaJammer).toBeDefined();
    expect(alertaJammer?.sombra).toBe(true);
    expect(alertaJammer?.veiculo_id).toBe(VEICULO_ID);

    // veiculosProcessados NÃO conta este veículo (o continue de
    // idempotência bloqueou o resto do processamento dele) -- confirma que
    // o teste está de fato exercitando o cenário "continue disparou", não
    // um cenário onde ele simplesmente não disparou por acidente.
    const body = await res.json();
    expect(body.veiculosProcessados).toBe(0);
  });

  it("item de acabamento (segunda revisao, 27/08): Step 9 NAO fecha um jammer que processarJammerIndependente acabou de confirmar ativo no mesmo ciclo", async () => {
    // Cenario que motivou TIPOS_GERENCIADOS_FORA_DO_STEP9 (route.ts): um
    // dispositivo entregando leituras antigas em lote -- cada datagps MAIS
    // NOVO que o anterior (entao o continue de idempotencia NAO dispara,
    // Step 9 roda normalmente), mas todas ainda com atraso>=30min (a
    // condicao de jammer continua batendo). Sem a exclusao, Step 9 veria
    // "jammer" ausente de candidatosCiclo (ele nunca entra la) e tentaria
    // fechar um alerta que o bloco independente, rodando ANTES, acabou de
    // confirmar que continua ativo -- os dois mecanismos brigando pelo
    // mesmo alerta.
    const ultimoDatagpsAntigo = "2026-08-27T09:00:00.000Z";
    const datagpsNovoMasAindaAtrasado = "2026-08-27T09:35:00.000Z"; // +35min, ainda dentro da janela de jammer critico (atraso_min abaixo cobre isso)
    mockState.ultimoDatagpsGravado = ultimoDatagpsAntigo; // MAIS ANTIGO que a leitura atual -> continue NAO dispara
    mockState.posAtual = {
      ...mockState.posAtual,
      ignicao: true,
      atraso_min: 45, // >= JAMMER_ATENCAO_MIN (30), condicao de jammer continua batendo
      velocidade: 0,
      datagps: datagpsNovoMasAindaAtrasado,
    };
    // Alerta de jammer JA ABERTO pro mesmo veiculo -- é o que processarJammerIndependente
    // encontra via alertaExistente e o que Step 9 NAO pode fechar.
    mockState.alertasAbertosPreexistentes = [
      { id: "jammer-aberto-1", veiculo_id: VEICULO_ID, tipo: "jammer", nivel: "critico", contexto: {} },
    ];

    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);

    // Confirma que o cenario de fato exercitou o caminho "continue NAO
    // disparou, Step 9 rodou de verdade" -- senao este teste provaria
    // menos do que anuncia.
    const body = await res.json();
    expect(body.veiculosProcessados).toBe(1);

    // O ponto central: NENHUM update foi feito sobre o id do alerta de
    // jammer ja aberto -- nem resolverPelaMaquina (fechamento automatico
    // do Step 9), nem escalacao (nivel ja e' critico, nao escalaria mesmo,
    // mas a ausencia TOTAL de update sobre este id e' o que prova que o
    // Step 9 nem tentou tocar nele).
    const updateNoJammerAberto = mockState.updates.find((u) => u.id === "jammer-aberto-1");
    expect(updateNoJammerAberto).toBeUndefined();

    // E nenhum insert NOVO de jammer aconteceu (alertaExistente ja' cobria
    // o dedup dentro de processarJammerIndependente).
    expect(mockState.inserts.filter((i) => i.tipo === "jammer")).toEqual([]);
  });

  it("CRITICO 2 (revisao independente 27/08): probe de sombra falha (coluna ausente OU erro transiente) -- candidato de shadow mode NAO e' inserido de jeito nenhum (nem visivel, nem sombra)", async () => {
    mockState.probeSombraErro = true;
    // excesso (pos-continue) + jammer (independente, pre-continue) juntos,
    // datagps fresco (sem idempotencia bloqueando nenhum dos dois) -- os
    // DOIS caminhos de insert (Step 9 e processarJammerIndependente)
    // precisam respeitar sombraDisponivel=false.
    mockState.posAtual = { ...mockState.posAtual, velocidade: 150, ignicao: true, atraso_min: 45 };

    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);

    // Nenhuma linha de alertas_romaneio foi inserida -- nem com sombra:true
    // (que seria o comportamento antigo, incorreto) nem sem o campo (que
    // cairia no DEFAULT false da migration e vazaria pra UI permanentemente).
    expect(mockState.inserts).toEqual([]);
    const body = await res.json();
    expect(body.alertasSombraGerados).toBe(0);
    expect(body.alertasGerados).toBe(0);
  });

  it("veiculo dentro do limite de velocidade (sem panico/jammer/ignicao) NAO gera nenhum alerta de shadow mode", async () => {
    mockState.posAtual = { ...mockState.posAtual, velocidade: 60, atraso_min: 2, ignicao: false, panico: false };
    const { POST } = await import("./route");
    const res = await POST(requisicaoDoCron());
    expect(res.status).toBe(200);
    expect(mockState.inserts.filter((i) => i.sombra === true)).toEqual([]);
  });
});

describe("GET /api/alertas-romaneio -- shadow mode NAO aparece na leitura real da UI (Task Fase 4 Incremento 1, IMPORTANTE 4)", () => {
  beforeEach(() => {
    mockState.inserts = [];
    mockState.probeSombraErro = false;
    mockState.usarDatasetLeitura = true;
    mockState.alertasRomaneioLeitura = [
      {
        id: "alerta-sombra-1", veiculo_id: VEICULO_ID, cliente_id: CLIENTE_ID,
        nivel: "critico", tipo: "excesso", motivo: "Excesso de velocidade: 150 km/h",
        desde: new Date().toISOString(), status: "ativo", score: 40,
        lat: -22.0, lng: -43.0, contexto: {}, sombra: true,
      },
      {
        id: "alerta-visivel-1", veiculo_id: VEICULO_ID, cliente_id: CLIENTE_ID,
        nivel: "critico", tipo: "desvio", motivo: "Afastando de tudo",
        desde: new Date().toISOString(), status: "ativo", score: 90,
        lat: -22.0, lng: -43.0, contexto: {}, sombra: false,
      },
    ];
  });

  it("a linha sombra=true (excesso) nao volta na resposta; a linha sombra=false (desvio) volta normalmente", async () => {
    // Exercita o handler REAL de leitura da UI -- não uma reimplementação
    // do predicado SQL em JS (achado do revisor sobre a versão anterior
    // deste teste, que só espelhava `sombra !== true` sobre o array de
    // inserts do POST, sem tocar em nenhum dos 3 arquivos de leitura de
    // verdade).
    const { GET } = await import("../alertas-romaneio/route");
    const req = new Request(`http://localhost/api/alertas-romaneio?cliente=4096`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    const tipos = (body.alertas as { tipo: string }[]).map((a) => a.tipo);
    expect(tipos).toContain("desvio");
    expect(tipos).not.toContain("excesso");
  });
});
