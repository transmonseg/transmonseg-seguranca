import { describe, it, expect } from "vitest";
import { agruparPontosPorPlaca, removerPicosRastro, distanciaAoSegmentoM, haversineM, suspenderPorChegada, divergenciaRumoGraus, divergenciaRumoDispara, type AlvoUnitrac } from "./unitrac";

describe("distanciaAoSegmentoM", () => {
  const origem = { lat: -22.9000, lng: -43.2000 };
  const destino = { lat: -22.9100, lng: -43.2000 }; // ~1,1km ao sul, mesma longitude

  it("ponto EXATAMENTE sobre o segmento: distancia ~0", () => {
    const meio = { lat: -22.9050, lng: -43.2000 };
    expect(distanciaAoSegmentoM(meio, origem, destino)).toBeLessThan(1);
  });

  it("ponto afastado perpendicularmente do meio do segmento: distancia bate com o afastamento real", () => {
    // ~0.01 grau de longitude na latitude -22.905 ~ 1027m
    const afastado = { lat: -22.9050, lng: -43.2100 };
    const d = distanciaAoSegmentoM(afastado, origem, destino);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1150);
  });

  it("ponto alem do DESTINO (fora do segmento): usa distancia ao destino, nao extrapola a reta", () => {
    const alemDoDestino = { lat: -22.9200, lng: -43.2000 }; // mais ao sul que o destino, na mesma linha
    const d = distanciaAoSegmentoM(alemDoDestino, origem, destino);
    const distAoDestino = haversineM(alemDoDestino.lat, alemDoDestino.lng, destino.lat, destino.lng);
    expect(d).toBeCloseTo(distAoDestino, -1); // mesma ordem de grandeza (aproximacao planar vs haversine)
  });

  it("ponto antes da ORIGEM (fora do segmento): usa distancia a origem, nao extrapola a reta", () => {
    const antesDaOrigem = { lat: -22.8900, lng: -43.2000 };
    const d = distanciaAoSegmentoM(antesDaOrigem, origem, destino);
    const distAOrigem = haversineM(antesDaOrigem.lat, antesDaOrigem.lng, origem.lat, origem.lng);
    expect(d).toBeCloseTo(distAOrigem, -1);
  });

  it("origem === destino: vira distancia ao ponto (sem divisao por zero)", () => {
    const p = { lat: -22.9050, lng: -43.2050 };
    const d = distanciaAoSegmentoM(p, origem, origem);
    const distDireta = haversineM(p.lat, p.lng, origem.lat, origem.lng);
    expect(d).toBeCloseTo(distDireta, -1);
  });
});

describe("removerPicosRastro", () => {
  it("remove um pico isolado (pula pra fora da rua e volta)", () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9010, lng: -43.2000 },
      { lat: -22.9300, lng: -43.2300 }, // pico: ~4km fora da linha
      { lat: -22.9020, lng: -43.2000 },
      { lat: -22.9030, lng: -43.2000 },
    ];
    const limpo = removerPicosRastro(pontos);
    expect(limpo).toHaveLength(4);
    expect(limpo).not.toContainEqual(pontos[2]);
  });

  it("mantem curva de rua real (desvio pequeno, nao e pico)", () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9005, lng: -43.2003 },
      { lat: -22.9010, lng: -43.2005 },
      { lat: -22.9015, lng: -43.2003 },
      { lat: -22.9020, lng: -43.2000 },
    ];
    expect(removerPicosRastro(pontos)).toHaveLength(5);
  });

  it("compara contra o ultimo ponto ACEITO, nao o bruto anterior", () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9300, lng: -43.2300 }, // pico isolado
      { lat: -22.9010, lng: -43.2000 }, // volta pra perto do ultimo aceito (pontos[0])
      { lat: -22.9020, lng: -43.2000 },
    ];
    const limpo = removerPicosRastro(pontos);
    expect(limpo.map(p => p.lat)).not.toContain(-22.9300);
    expect(limpo).toHaveLength(3);
  });

  it("listas curtas (< 3 pontos) retornam sem alteracao", () => {
    const pontos = [{ lat: -22.9, lng: -43.2 }, { lat: -22.91, lng: -43.21 }];
    expect(removerPicosRastro(pontos)).toEqual(pontos);
  });

  it("remove RAJADA de 2 picos seguidos (multipath sob viaduto/predio)", () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9300, lng: -43.2300 }, // pico 1
      { lat: -22.9310, lng: -43.2310 }, // pico 2, proximo do pico 1 (nao volta ainda)
      { lat: -22.9010, lng: -43.2000 }, // volta pra perto do ultimo aceito (pontos[0])
      { lat: -22.9020, lng: -43.2000 },
    ];
    const limpo = removerPicosRastro(pontos);
    expect(limpo.map(p => p.lat)).not.toContain(-22.9300);
    expect(limpo.map(p => p.lat)).not.toContain(-22.9310);
    expect(limpo).toHaveLength(3);
  });

  it("remove RAJADA de 3 picos seguidos (limite do lookahead)", () => {
    const pontos = [
      { lat: -22.9000, lng: -43.2000 },
      { lat: -22.9300, lng: -43.2300 }, // pico 1
      { lat: -22.9305, lng: -43.2305 }, // pico 2
      { lat: -22.9310, lng: -43.2310 }, // pico 3
      { lat: -22.9010, lng: -43.2000 }, // volta pra perto do aceito
      { lat: -22.9020, lng: -43.2000 },
    ];
    const limpo = removerPicosRastro(pontos);
    expect(limpo).toHaveLength(3);
    expect(limpo.map(p => p.lat)).not.toContain(-22.9300);
    expect(limpo.map(p => p.lat)).not.toContain(-22.9305);
    expect(limpo.map(p => p.lat)).not.toContain(-22.9310);
  });
});

describe("agruparPontosPorPlaca", () => {
  it("mapeia os campos completos e trata data 0001 como null", () => {
    const alvos: AlvoUnitrac[] = [
      {
        placa: "ABC1D23",
        alvosituacaoservico: 0,
        pontolatitude: -22.9,
        pontolongitude: -43.2,
        pontoraio: 100,
        pontonome: "SENDAS",
        alvoordem: 1,
        alvodocumento: "279225",
        pontoidentificador: "560036",
        alvodatainicio: "2026-06-26T00:21:13",
        alvodatarealizado: "0001-01-01T00:00:00",
        alvoobservacoes: null,
        alvorota: "ROTA",
      },
    ];
    const mapa = agruparPontosPorPlaca(alvos);
    const p = mapa.get("ABC1D23")![0];
    expect(p.documento).toBe("279225");
    expect(p.identificador).toBe("560036");
    expect(p.dataInicio).toBe("2026-06-26T00:21:13");
    expect(p.dataRealizado).toBeNull();
    expect(p.observacoes).toBeNull();
    expect(p.rota).toBe("ROTA");
    expect(p.feito).toBe(false);
  });

  it("marca feito quando alvosituacaoservico = 1 e preserva data realizada valida", () => {
    const alvos: AlvoUnitrac[] = [
      {
        placa: "XYZ9K88",
        alvosituacaoservico: 1,
        pontolatitude: -22.8,
        pontolongitude: -43.1,
        alvoordem: 2,
        alvodatarealizado: "2026-06-26T08:15:00",
      },
    ];
    const p = agruparPontosPorPlaca(alvos).get("XYZ9K88")![0];
    expect(p.feito).toBe(true);
    expect(p.situacao).toBe(1);
    expect(p.dataRealizado).toBe("2026-06-26T08:15:00");
    expect(p.documento).toBeNull();
  });

  it("situacao 98 (encerrado por outra via) conta como feito, nao como pendente", () => {
    const alvos: AlvoUnitrac[] = [
      {
        placa: "LSN6I72",
        alvosituacaoservico: 98,
        pontolatitude: -22.95,
        pontolongitude: -43.18,
        alvoordem: 0,
        alvodatarealizado: "2026-06-30T11:04:25",
      },
    ];
    const p = agruparPontosPorPlaca(alvos).get("LSN6I72")![0];
    expect(p.feito).toBe(true);
    expect(p.situacao).toBe(98);
  });
});

describe("suspenderPorChegada (achado 25/07: geofence de chegada substitui distancia-cancela)", () => {
  it("dentro do raio do destino mais proximo: suspende", () => {
    expect(suspenderPorChegada(100, 150, false)).toBe(true);
  });

  it("exatamente no raio (limite): suspende", () => {
    expect(suspenderPorChegada(150, 150, false)).toBe(true);
  });

  it("fora do raio do destino, raio da Unitrac menor que o piso de 150m: usa o piso", () => {
    // raio vindo da Unitrac = 50m, mas o piso e 150m -- 120m de distancia
    // fica DENTRO do piso, mesmo estando fora do raio bruto de 50m.
    expect(suspenderPorChegada(120, 50, false)).toBe(true);
  });

  it("fora do raio (com piso aplicado) e nao esta em ponto seguro: nao suspende", () => {
    expect(suspenderPorChegada(500, 150, false)).toBe(false);
  });

  it("fora do raio do destino mas dentro de um ponto seguro (posto de gasolina): suspende", () => {
    expect(suspenderPorChegada(500, 150, true)).toBe(true);
  });
});

describe("divergenciaRumoGraus (achado 25/07: sinal de direcao, pega desvio mesmo aproximando em linha reta)", () => {
  it("rumo real bate com o esperado (mesma direcao): divergencia proxima de 0", () => {
    // De (0,0) indo pra (1,0): rumo ~90 (leste). Destino tambem a leste.
    // anterior (lat=0, lng=0), atual (lat=0, lng=0.01), destino (lat=0, lng=1)
    const d = divergenciaRumoGraus(0, 0, 0, 0.01, 0, 1);
    expect(d).toBeLessThan(10);
  });

  it("rumo real oposto ao esperado (voltando): divergencia proxima de 180", () => {
    // Indo de (1,0) pra (0,0): rumo ~180 (sul). Destino ao norte (2,0).
    // anterior (lat=1, lng=0), atual (lat=0, lng=0), destino (lat=2, lng=0)
    const d = divergenciaRumoGraus(1, 0, 0, 0, 2, 0);
    expect(d).toBeGreaterThan(170);
  });

  it("velocidade abaixo do piso (10km/h): retorna null, rumo e ruido", () => {
    expect(divergenciaRumoGraus(0, 0, 0, 0.001, 0, 0.01, 5)).toBeNull();
  });

  it("velocidade no piso ou acima: calcula normalmente", () => {
    const d = divergenciaRumoGraus(0, 0, 0, 0.01, 0, 1, 10);
    expect(d).not.toBeNull();
  });
});

describe("divergenciaRumoDispara (limiar, SEM amortecimento por familiaridade -- decisao revista 25/07)", () => {
  it("streak abaixo do piso (1): nao dispara", () => {
    expect(divergenciaRumoDispara(1)).toBe(false);
  });

  it("streak no piso (2): dispara", () => {
    expect(divergenciaRumoDispara(2)).toBe(true);
  });

  it("streak acima do piso (5): dispara", () => {
    expect(divergenciaRumoDispara(5)).toBe(true);
  });
});
