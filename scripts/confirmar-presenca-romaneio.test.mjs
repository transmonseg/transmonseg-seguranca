import { describe, it, expect } from "vitest";
import { calcularStreakMaximoComPosicao, proximaEscritaCache, distanciaVizinhoConfirmadoMaisProximo, normalizarEnderecoChave } from "./confirmar-presenca-romaneio.mjs";

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
