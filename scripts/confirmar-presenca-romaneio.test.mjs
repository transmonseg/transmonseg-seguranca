import { describe, it, expect, afterEach } from "vitest";
import pg from "pg";
import { calcularStreakMaximoComPosicao, proximaEscritaCache, distanciaVizinhoConfirmadoMaisProximo, normalizarEnderecoChave, diaDoRomaneio, SQL_PENDENTES, sqlMarcarPresenca, SQL_TRILHA, paramsTrilha, deveGravarAncora, confirmarDwell } from "./confirmar-presenca-romaneio.mjs";

describe("calcularStreakMaximoComPosicao", () => {
  const PONTO = { lat: -22.9, lng: -43.2 };

  it("sem trilha: sem streak", () => {
    const r = calcularStreakMaximoComPosicao([], PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r).toEqual({ dwellMaxS: 0, posicaoReal: null });
  });

  it("streak curto (menos que o minimo): dwellMaxS abaixo do minimo, posicaoReal null", () => {
    const trilha = [
      { lat: -22.9001, lng: -43.2001, velocidade: 0, criado_em: "2026-08-30T09:00:00.000Z" },
      { lat: -22.9001, lng: -43.2001, velocidade: 0, criado_em: "2026-08-30T09:00:30.000Z" },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r.dwellMaxS).toBeLessThan(120);
    expect(r.posicaoReal).toBeNull();
  });

  it("streak longo dentro do raio, parado: confirma e retorna a media real da trilha", () => {
    const trilha = [
      { lat: -22.9002, lng: -43.2002, velocidade: 0, criado_em: "2026-08-30T09:00:00.000Z" },
      { lat: -22.9004, lng: -43.2004, velocidade: 0, criado_em: "2026-08-30T09:00:40.000Z" },
      { lat: -22.9004, lng: -43.2004, velocidade: 0, criado_em: "2026-08-30T09:01:20.000Z" },
      { lat: -22.9004, lng: -43.2004, velocidade: 0, criado_em: "2026-08-30T09:02:00.000Z" },
      { lat: -22.9004, lng: -43.2004, velocidade: 0, criado_em: "2026-08-30T09:02:40.000Z" },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r.dwellMaxS).toBeGreaterThanOrEqual(120);
    expect(r.posicaoReal).not.toBeNull();
    // media das 5 leituras
    expect(r.posicaoReal.lat).toBeCloseTo(-22.90036, 4);
    expect(r.posicaoReal.lng).toBeCloseTo(-43.20036, 4);
  });

  it("achado real 30/08 (TOS-1H26/backlog do cron morto): cadencia real >30s -- +30s fixo subestimava, tempo real bate o limiar", () => {
    // 3 leituras qualificadas com ~55-60s de cadencia real (tipico do
    // motor) -- pelo calculo antigo (+30s fixo) isso somava so' 60s,
    // abaixo do limiar de 120s. Com o tempo real (2 intervalos de ~57s),
    // fecha em ~114s -- ainda abaixo dos 120s classicos SE o limiar fosse
    // rigido, mas o objetivo do teste e' a MEDICAO ficar fiel ao real,
    // nao o limiar em si (ver proximo teste pra um caso que realmente
    // deveria confirmar).
    const trilha = [
      { lat: -22.9002, lng: -43.2002, velocidade: 0, criado_em: "2026-08-30T09:00:00.000Z" },
      { lat: -22.9002, lng: -43.2002, velocidade: 0, criado_em: "2026-08-30T09:00:57.000Z" },
      { lat: -22.9002, lng: -43.2002, velocidade: 0, criado_em: "2026-08-30T09:01:54.000Z" },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    // tempo real decorrido: 114s (2 intervalos de 57s) -- NAO 60s (2*30
    // fixo, valor que o calculo antigo teria dado).
    expect(r.dwellMaxS).toBeCloseTo(114, 0);
  });

  it("velocidade alta interrompe o streak (nao conta como parado)", () => {
    const trilha = [
      { lat: -22.9002, lng: -43.2002, velocidade: 0, criado_em: "2026-08-30T09:00:00.000Z" },
      { lat: -22.9002, lng: -43.2002, velocidade: 0, criado_em: "2026-08-30T09:00:30.000Z" },
      { lat: -22.9002, lng: -43.2002, velocidade: 20, criado_em: "2026-08-30T09:01:00.000Z" }, // interrompe
      { lat: -22.9002, lng: -43.2002, velocidade: 0, criado_em: "2026-08-30T09:01:30.000Z" },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r.dwellMaxS).toBeLessThan(120); // nenhum streak individual chega ao minimo
  });

  it("fora do raio nao conta, mesmo parado", () => {
    const trilha = [
      { lat: -23.5, lng: -43.9, velocidade: 0, criado_em: "2026-08-30T09:00:00.000Z" }, // longe do ponto
      { lat: -23.5, lng: -43.9, velocidade: 0, criado_em: "2026-08-30T09:00:30.000Z" },
      { lat: -23.5, lng: -43.9, velocidade: 0, criado_em: "2026-08-30T09:01:00.000Z" },
      { lat: -23.5, lng: -43.9, velocidade: 0, criado_em: "2026-08-30T09:01:30.000Z" },
      { lat: -23.5, lng: -43.9, velocidade: 0, criado_em: "2026-08-30T09:02:00.000Z" },
    ];
    const r = calcularStreakMaximoComPosicao(trilha, PONTO.lat, PONTO.lng, 300, 5, 120);
    expect(r.dwellMaxS).toBe(0);
    expect(r.posicaoReal).toBeNull();
  });
});

describe("distanciaVizinhoConfirmadoMaisProximo", () => {
  it("lista vazia: null, sem vizinho pra corroborar", () => {
    expect(distanciaVizinhoConfirmadoMaisProximo([], -22.9, -43.2)).toBeNull();
  });

  it("achado real 30/08 (TTM-2G02/Rocinha): 2 vizinhos confirmados na mesma rua, pega o mais proximo", () => {
    // Estrada da Gavea 213 (confirmado) e 308 (confirmado) -- ponto novo
    // e' o 369, mais perto do 308.
    const confirmados = [
      { lat: -22.98519, lng: -43.20139 }, // nº 213
      { lat: -22.9862, lng: -43.19613 },  // nº 308
    ];
    const d = distanciaVizinhoConfirmadoMaisProximo(confirmados, -22.98642, -43.19613 + 0.0002);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(100); // bem mais perto do nº308 que do nº213
  });

  it("nenhum vizinho dentro de distancia razoavel: retorna a distancia mesmo assim (quem decide o limiar e' o chamador)", () => {
    const confirmados = [{ lat: -23.5, lng: -43.9 }]; // longe (outro bairro)
    const d = distanciaVizinhoConfirmadoMaisProximo(confirmados, -22.9, -43.2);
    expect(d).toBeGreaterThan(50000);
  });
});

describe("proximaEscritaCache", () => {
  const REAL = { lat: -22.91, lng: -43.21 };

  it("sem ancora existente: cria nova linha com fonte dwell_confirmado, n_observacoes=1", () => {
    const r = proximaEscritaCache(null, REAL);
    expect(r).toEqual({ lat: REAL.lat, lng: REAL.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: true });
  });

  it("ancora existente com fonte geocodificada: corrige pra posicao real, reseta n_observacoes=1", () => {
    const existente = { lat: -22.85, lng: -43.15, fonte: "nominatim", n_observacoes: 1 };
    const r = proximaEscritaCache(existente, REAL);
    expect(r).toEqual({ lat: REAL.lat, lng: REAL.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: false });
  });

  // F4-11 (GEO-08): a similaridade do CNEFE passou a gravar a ancora com
  // fonte 'cnefe_similaridade' -- continua sendo geocodificacao (troca pelo
  // dwell real, n=1), nunca media com o dwell.
  it("ancora com fonte cnefe_similaridade: corrige pra posicao real, n_observacoes=1 (igual a cnefe)", () => {
    const existente = { lat: -22.9159, lng: -43.4295, fonte: "cnefe_similaridade", n_observacoes: 1 };
    const r = proximaEscritaCache(existente, REAL);
    expect(r).toEqual({ lat: REAL.lat, lng: REAL.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: false });
  });

  it("ancora ja dwell_confirmado: faz media ponderada por n_observacoes, incrementa", () => {
    const existente = { lat: -22.90, lng: -43.20, fonte: "dwell_confirmado", n_observacoes: 2 };
    const r = proximaEscritaCache(existente, REAL);
    // (lat*2 + REAL.lat) / 3
    expect(r.lat).toBeCloseTo((-22.90 * 2 + REAL.lat) / 3, 6);
    expect(r.lng).toBeCloseTo((-43.20 * 2 + REAL.lng) / 3, 6);
    expect(r.fonte).toBe("dwell_confirmado");
    expect(r.n_observacoes).toBe(3);
    expect(r.novaLinha).toBe(false);
  });

  // Bug real confirmado 31/08 (ver migration 069): NUTRIMED cliente_codigo
  // 139450 entrega em 9 hospitais espalhados pelo Rio, todos compartilhando
  // UMA linha de cache -- a media entre eles caiu em -22.912365,-42.775819
  // (perto de Tangua/Rio Bonito), ~60km de qualquer endereco real. A media
  // ponderada so pode acontecer entre paradas do MESMO lugar.
  it("achado real 31/08 (NUTRIMED 139450): parada real longe da ancora NAO entra na media", () => {
    // Ancora ja gravada no HEMORIO (Rua Frei Caneca, Centro).
    const existente = { lat: -22.9080, lng: -43.1950, fonte: "dwell_confirmado", n_observacoes: 3 };
    // Parada real de hoje no Hospital Estadual Santa Maria (Taquara), ~19km.
    const outroHospital = { lat: -22.9285, lng: -43.3830 };
    expect(proximaEscritaCache(existente, outroHospital)).toBeNull();
  });

  it("parada real perto da ancora (mesmo lugar, ruido de GPS) continua entrando na media", () => {
    const existente = { lat: -22.9080, lng: -43.1950, fonte: "dwell_confirmado", n_observacoes: 3 };
    const mesmoLugar = { lat: -22.9083, lng: -43.1954 }; // ~50m
    const r = proximaEscritaCache(existente, mesmoLugar);
    expect(r).not.toBeNull();
    expect(r.n_observacoes).toBe(4);
  });

  it("divergencia so bloqueia a media -- ancora geocodificada ainda e corrigida pra dwell real", () => {
    // Geocodificacao errada (bairro errado, 19km): a posicao REAL medida
    // por dwell e melhor evidencia que o texto, entao sobrescreve.
    const existente = { lat: -22.9080, lng: -43.1950, fonte: "nominatim", n_observacoes: 1 };
    const real = { lat: -22.9285, lng: -43.3830 };
    const r = proximaEscritaCache(existente, real);
    expect(r).toEqual({ lat: real.lat, lng: real.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: false });
  });
});

describe("normalizarEnderecoChave", () => {
  // Precisa bater com normalizarEndereco() de src/lib/romaneio-geocode.ts
  // (trim + upper + colapso de espacos) -- os dois lados escrevem na MESMA
  // linha de romaneio_cliente_codigo_geocode desde a migration 069.
  it("trim, upper e colapso de espacos", () => {
    expect(normalizarEnderecoChave("  rua frei   caneca, 08 - centro, RIO DE JANEIRO  "))
      .toBe("RUA FREI CANECA, 08 - CENTRO, RIO DE JANEIRO");
  });

  it("enderecos DIFERENTES do mesmo cliente_codigo geram chaves diferentes (o bug da 069)", () => {
    const hemorio = normalizarEnderecoChave("RUA FREI CANECA, 08 - CENTRO, RIO DE JANEIRO - HEMORIO");
    const santaMaria = normalizarEnderecoChave("ESTRDA RIO PEQUENO, 656 - TAQUARA, RIO DE JANEIRO - HOSPITAL ESTADUAL SANTA MARIA");
    expect(hemorio).not.toBe(santaMaria);
  });

  it("endereco nulo/vazio vira string vazia (chamador nao grava cache nesse caso)", () => {
    expect(normalizarEnderecoChave(null)).toBe("");
    expect(normalizarEnderecoChave("   ")).toBe("");
  });
});

// F2-10 (MON-07) -- achado 23/10: o servidor roda em Europe/Berlin (CEST) e o
// node-pg transforma a coluna DATE em Date na MEIA-NOITE LOCAL; o
// `toISOString().slice(0, 10)` devolvia o dia ANTERIOR (234 de 400 linhas do
// log com dia=22 para romaneio de 23). A vizinhanca entao corroborava a NF
// pendente de hoje com as confirmacoes de ONTEM do mesmo veiculo.
// A correcao tem que valer em qualquer fuso (o crontab vai mudar de fuso, F0-06).
describe("diaDoRomaneio (F2-10)", () => {
  const parserDate = pg.types.getTypeParser(1082, "text");
  const tzOriginal = process.env.TZ;
  afterEach(() => {
    if (tzOriginal === undefined) delete process.env.TZ; else process.env.TZ = tzOriginal;
  });

  for (const tz of ["Europe/Berlin", "America/Sao_Paulo", "UTC"]) {
    it(`DATE lido pelo pg (Date local) da' o dia certo com TZ=${tz}`, () => {
      process.env.TZ = tz;
      const valorDoPg = parserDate("2026-10-23");
      expect(diaDoRomaneio(valorDoPg)).toBe("2026-10-23");
    });
  }

  it("caso real do log: em CEST o jeito antigo (toISOString) dava o dia anterior", () => {
    process.env.TZ = "Europe/Berlin";
    const valorDoPg = parserDate("2026-10-23");
    expect(valorDoPg.toISOString().slice(0, 10)).toBe("2026-10-22");
    expect(diaDoRomaneio(valorDoPg)).toBe("2026-10-23");
  });

  it("texto (romaneio_data::text) passa direto, independente do fuso", () => {
    process.env.TZ = "Europe/Berlin";
    expect(diaDoRomaneio("2026-10-23")).toBe("2026-10-23");
    process.env.TZ = "America/Sao_Paulo";
    expect(diaDoRomaneio("2026-10-23")).toBe("2026-10-23");
  });

  it("a consulta dos pendentes le romaneio_data como texto (nao vira Date no node-pg)", () => {
    expect(SQL_PENDENTES).toMatch(/romaneio_data::text\s+AS\s+romaneio_data/i);
  });
});

describe("sqlMarcarPresenca (F2-10: metodo da presenca)", () => {
  it("com a coluna presenca_metodo: grava o metodo junto", () => {
    const { sql, params } = sqlMarcarPresenca("id-1", "vizinhanca", true);
    expect(sql).toMatch(/presenca_metodo\s*=\s*\$2/);
    expect(sql).toMatch(/presenca_confirmada_em IS NULL/);
    expect(params).toEqual(["id-1", "vizinhanca"]);
  });

  it("sem a coluna (migration ainda nao aplicada): mesmo UPDATE de hoje", () => {
    const { sql, params } = sqlMarcarPresenca("id-1", "dwell", false);
    expect(sql).not.toMatch(/presenca_metodo/);
    expect(params).toEqual(["id-1"]);
  });

  it("metodo desconhecido e' erro (nunca grava texto livre)", () => {
    expect(() => sqlMarcarPresenca("id-1", "chute", true)).toThrow();
  });
});

// F4-02 (GEO-29): dwell do motor confiavel. Achado 23/10: FONTES_GEOCODIFICADAS
// nao tinha photon, photon_rua nem unitrac_aprendido -- a ancora geocodificada
// por essas fontes caia no ramo de MEDIA com o dwell e nascia dwell n=2 no
// mesmo dia (RQ: 2.824 de 3.590 ancoras n>=2; Nutry: 713 com n=2 e
// primeira=ultima observacao).
describe("proximaEscritaCache (F4-02: fontes geocodificadas e dia novo)", () => {
  // Caso real (Nutry, cliente 152619): ancora photon "CPO SALINAS, S/N -
  // TERCEIRO, NOVA FRIBURGO"; parada real ~300 m dali.
  const PHOTON_SALINAS = { lat: -22.3207663, lng: -42.6521455, fonte: "photon", n_observacoes: 1, ultima_observacao: "2026-10-20" };
  const PARADA = { lat: -22.3234, lng: -42.6530 };

  for (const fonte of ["photon", "photon_rua", "unitrac_aprendido", "cnefe_bairro"]) {
    it(`ancora ${fonte}: troca pelo dwell real com n=1 (nunca media geocode+dwell como n=2)`, () => {
      const r = proximaEscritaCache({ ...PHOTON_SALINAS, fonte }, PARADA, "2026-10-23");
      expect(r).toEqual({ lat: PARADA.lat, lng: PARADA.lng, fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: false });
    });
  }

  it("ancora de fonte protegida (manual) nunca e' sobrescrita pelo dwell (D-34: manual > dwell)", () => {
    expect(proximaEscritaCache({ ...PHOTON_SALINAS, fonte: "manual" }, PARADA, "2026-10-23")).toBeNull();
  });

  it("fonte desconhecida nao entra na media (nao vira dwell n=2 por engano)", () => {
    expect(proximaEscritaCache({ ...PHOTON_SALINAS, fonte: "fonte_nova_qualquer" }, PARADA, "2026-10-23")).toBeNull();
  });

  // Caso real (Nutry, cliente 165601, "RUA 10, 749 - NOVA CAMPINAS, DUQUE DE
  // CAXIAS"): ancora dwell n=2 com primeira=ultima=2026-10-23 -- duas
  // contagens no MESMO dia nao sao duas observacoes.
  it("dwell ja observado no MESMO dia do romaneio: nao conta de novo (n fica)", () => {
    const existente = { lat: -22.64605, lng: -43.248743, fonte: "dwell_confirmado", n_observacoes: 1, ultima_observacao: "2026-10-23" };
    expect(proximaEscritaCache(existente, { lat: -22.6461, lng: -43.2488 }, "2026-10-23")).toBeNull();
  });

  it("romaneio de dia ANTERIOR ao ultimo observado (confirmacao atrasada): nao conta (so' dia novo soma)", () => {
    const existente = { lat: -22.64605, lng: -43.248743, fonte: "dwell_confirmado", n_observacoes: 1, ultima_observacao: "2026-10-23" };
    expect(proximaEscritaCache(existente, { lat: -22.6461, lng: -43.2488 }, "2026-10-22")).toBeNull();
  });

  it("dwell em dia NOVO: media e n+1", () => {
    const existente = { lat: -22.64605, lng: -43.248743, fonte: "dwell_confirmado", n_observacoes: 1, ultima_observacao: "2026-10-22" };
    const r = proximaEscritaCache(existente, { lat: -22.6461, lng: -43.2488 }, "2026-10-23");
    expect(r.n_observacoes).toBe(2);
    expect(r.fonte).toBe("dwell_confirmado");
  });
});

describe("deveGravarAncora (F4-02: RQ com cliente_codigo = NF)", () => {
  // Caso real RQ 22/10: NF 6077117, cliente_codigo 6077117, "RUA JOAO XAVIER,
  // PETROPOLIS - RJ" -- ancora dwell n=2 nascida no mesmo dia e nunca
  // reaproveitada (o codigo e' a propria NF). Ate o F4-09, nao grava.
  it("cliente_codigo igual a NF: nao grava ancora", () => {
    expect(deveGravarAncora({ nf: "6077117", cliente_codigo: "6077117" })).toBe(false);
  });
  it("Nutry (codigo do cliente de verdade): grava", () => {
    expect(deveGravarAncora({ nf: "2442557", cliente_codigo: "165601" })).toBe(true);
  });
  it("sem codigo: nao grava", () => {
    expect(deveGravarAncora({ nf: "2442557", cliente_codigo: null })).toBe(false);
  });
});

describe("SQL_TRILHA (F4-02: faixa de criado_em, usa o indice veiculo+tempo)", () => {
  it("filtra por faixa de criado_em no dia BRT, sem ::date em cima da coluna", () => {
    expect(SQL_TRILHA).toMatch(/criado_em\s*>=/);
    expect(SQL_TRILHA).toMatch(/criado_em\s*</);
    expect(SQL_TRILHA).toMatch(/America\/Sao_Paulo/);
    expect(SQL_TRILHA).not.toMatch(/\(criado_em AT TIME ZONE[^)]*\)::date/);
  });
  it("parametros: veiculo e dia do romaneio", () => {
    expect(paramsTrilha("v-1", "2026-10-23")).toEqual(["v-1", "2026-10-23"]);
  });
});

describe("SQL_PENDENTES (F4-02: ordem cronologica)", () => {
  it("processa do romaneio mais antigo ao mais novo (dia novo soma, dia velho nao)", () => {
    expect(SQL_PENDENTES).toMatch(/ORDER BY romaneio_data/i);
  });
});

// Cliente pg falso: registra as consultas e responde o UPDATE com rowCount.
function clienteFalso({ rowCountUpdate, existente = null }) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql: sql.trim().split(/\s+/).slice(0, 2).join(" "), params });
      if (/^UPDATE romaneio_pontos/.test(sql.trim())) return { rowCount: rowCountUpdate, rows: [] };
      if (/^SELECT/.test(sql.trim())) return { rowCount: existente ? 1 : 0, rows: existente ? [existente] : [] };
      return { rowCount: 0, rows: [] };
    },
  };
}

describe("confirmarDwell (F4-02: ancora so' quando o UPDATE confirmou de fato)", () => {
  const ANCORA = { clienteId: "cfcb52f5", clienteCodigo: "165601", enderecoChave: "RUA 10, 749 - NOVA CAMPINAS, DUQUE DE CAXIAS - * - 25268-090", posicaoReal: { lat: -22.6461, lng: -43.2488 }, dia: "2026-10-23" };

  it("UPDATE com 0 linhas (outra execucao ja confirmou): ROLLBACK e nenhuma ancora", async () => {
    const c = clienteFalso({ rowCountUpdate: 0 });
    const r = await confirmarDwell(c, { id: "p1", temColunaMetodo: true, ancora: ANCORA });
    expect(r.confirmado).toBe(false);
    expect(c.consultas.some((q) => q.sql.startsWith("INSERT"))).toBe(false);
    expect(c.consultas.map((q) => q.sql)).toContain("ROLLBACK");
    expect(c.consultas.map((q) => q.sql)).not.toContain("COMMIT");
  });

  it("UPDATE com 1 linha: grava a ancora com o dia do romaneio e faz COMMIT", async () => {
    const c = clienteFalso({ rowCountUpdate: 1 });
    const r = await confirmarDwell(c, { id: "p1", temColunaMetodo: true, ancora: ANCORA });
    expect(r.confirmado).toBe(true);
    expect(r.proxima).toMatchObject({ fonte: "dwell_confirmado", n_observacoes: 1, novaLinha: true });
    const ins = c.consultas.find((q) => q.sql.startsWith("INSERT"));
    expect(ins.params).toContain("2026-10-23");
    expect(c.consultas.at(-1).sql).toBe("COMMIT");
  });

  it("o UPDATE de presenca vem ANTES de qualquer leitura/escrita da ancora", async () => {
    const c = clienteFalso({ rowCountUpdate: 1 });
    await confirmarDwell(c, { id: "p1", temColunaMetodo: true, ancora: ANCORA });
    const seq = c.consultas.map((q) => q.sql);
    expect(seq.indexOf("UPDATE romaneio_pontos")).toBeLessThan(seq.findIndex((s) => s.startsWith("SELECT")));
  });

  it("sem ancora (RQ): so' confirma a presenca", async () => {
    const c = clienteFalso({ rowCountUpdate: 1 });
    const r = await confirmarDwell(c, { id: "p1", temColunaMetodo: true, ancora: null });
    expect(r.confirmado).toBe(true);
    expect(c.consultas.some((q) => q.sql.startsWith("INSERT") || q.sql.startsWith("SELECT"))).toBe(false);
  });

  it("dwell no mesmo dia ja contado: confirma presenca, nao regrava ancora", async () => {
    const c = clienteFalso({ rowCountUpdate: 1, existente: { lat: -22.64605, lng: -43.248743, fonte: "dwell_confirmado", n_observacoes: 2, ultima_observacao: "2026-10-23" } });
    const r = await confirmarDwell(c, { id: "p1", temColunaMetodo: true, ancora: ANCORA });
    expect(r.confirmado).toBe(true);
    expect(r.proxima).toBeNull();
    expect(c.consultas.some((q) => q.sql.startsWith("INSERT"))).toBe(false);
  });
});
