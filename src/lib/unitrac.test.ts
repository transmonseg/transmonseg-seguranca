import { describe, it, expect } from "vitest";
import { agruparPontosPorPlaca, removerPicosRastro, distanciaAoSegmentoM, haversineM, suspenderPorChegada, divergenciaRumoGraus, divergenciaRumoMinima, divergenciaRumoDispara, corrigirComPontoAprendido, deveCorrigirComRomaneio, type AlvoUnitrac, type PontoEntrega } from "./unitrac";

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

  it("fora do raio do destino, raio da Unitrac menor que o piso: usa o piso", () => {
    // raio vindo da Unitrac = 50m, mas o piso vale (RAIO_CHEGADA_MIN_M,
    // 300m desde 01/08 -- era 150m) -- 120m de distancia fica DENTRO do
    // piso, mesmo estando fora do raio bruto de 50m.
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

describe("divergenciaRumoMinima (achado real 31/07-01/08: compara contra TODOS os destinos, nao so o mais proximo)", () => {
  it("rumo bate com um destino distante, mesmo divergindo do mais proximo: divergencia baixa (o menor valor vence)", () => {
    // anterior (0,0) -> atual (0,0.01): rumo real ~leste (90).
    // destino A (perto, mas ao SUL -- diverge muito): (-1, 0.01).
    // destino B (longe, mas ao LESTE -- bate com o rumo real): (0, 1).
    const d = divergenciaRumoMinima(0, 0, 0, 0.01, [{ lat: -1, lng: 0.01 }, { lat: 0, lng: 1 }], 999);
    expect(d).toBeLessThan(10);
  });

  it("diverge de TODOS os destinos: divergencia alta", () => {
    // anterior (1,0) -> atual (0,0): rumo real ~sul (180).
    // dois destinos, ambos ao NORTE -- nenhum bate com o rumo real.
    const d = divergenciaRumoMinima(1, 0, 0, 0, [{ lat: 2, lng: 0 }, { lat: 3, lng: 0.5 }], 999);
    expect(d).toBeGreaterThan(170);
  });

  it("lista de destinos vazia: retorna null (sem sinal confiavel, mantem o alerta -- mesma diretriz de sempre)", () => {
    expect(divergenciaRumoMinima(0, 0, 0, 0.01, [], 999)).toBeNull();
  });

  it("velocidade abaixo do piso: retorna null (mesmo piso de divergenciaRumoGraus)", () => {
    expect(divergenciaRumoMinima(0, 0, 0, 0.001, [{ lat: 0, lng: 0.01 }], 5)).toBeNull();
  });

  it("caso real 31/07-01/08: veiculo voltando pra base bate com a base entre os destinos, mesmo com uma entrega pendente mais proxima em outra direcao", () => {
    // Cenario baseado nos casos reais TTK-4D17/TTP-0H36/TTH-6H80: veiculo
    // indo de leste pra oeste rumo a base, com uma entrega pendente ao
    // NORTE (mais proxima em linha reta, mas na direcao errada).
    const anterior = { lat: -22.85, lng: -43.20 };
    const atual = { lat: -22.85, lng: -43.21 }; // moveu pra oeste
    const entregaPendente = { lat: -22.84, lng: -43.205 }; // ao norte, mais proxima
    const base = { lat: -22.85, lng: -43.30 }; // ao oeste, mais longe mas na direcao certa
    const distEntrega = Math.hypot(entregaPendente.lat - atual.lat, entregaPendente.lng - atual.lng);
    const distBase = Math.hypot(base.lat - atual.lat, base.lng - atual.lng);
    expect(distEntrega).toBeLessThan(distBase); // confirma que a entrega e' "mais proxima" nesse instante
    const d = divergenciaRumoMinima(anterior.lat, anterior.lng, atual.lat, atual.lng, [entregaPendente, base], 999);
    expect(d).toBeLessThan(10); // bate com a base, mesmo ela nao sendo a mais proxima
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

// ───────────────────────────────────────────────────────────────────────
// Piso do raio de chegada -- medicao 01/08 dos pontos de entrega reais.
// ───────────────────────────────────────────────────────────────────────
describe("suspenderPorChegada: piso de 300m (RAIO_CHEGADA_MIN_M)", () => {
  it("200m do ponto conta como chegada -- com o piso antigo de 150m NAO contava, e era metade das entregas", () => {
    expect(suspenderPorChegada(200, 50, false)).toBe(true);
  });

  it("299m conta, 301m nao conta (fronteira exata do piso)", () => {
    expect(suspenderPorChegada(299, 50, false)).toBe(true);
    expect(suspenderPorChegada(301, 50, false)).toBe(false);
  });

  it("raio proprio do ponto maior que o piso manda (nao rebaixa pra 300)", () => {
    expect(suspenderPorChegada(450, 500, false)).toBe(true);
  });

  it("ponto seguro (posto) suspende independente da distancia", () => {
    expect(suspenderPorChegada(99999, 50, true)).toBe(true);
  });
});

describe("corrigirComPontoAprendido", () => {
  const pontoBase: PontoEntrega = {
    lat: -22.9, lng: -43.2, raio: 150, ordem: 1, nome: "Cliente Teste",
    feito: false, situacao: 0, codigo: 111, pontoCodigo: 222,
    documento: "NF1", identificador: null, dataInicio: null,
    dataRealizado: null, observacoes: null, rota: null,
  };

  it("sem correção disponível, retorna o ponto inalterado", () => {
    const r = corrigirComPontoAprendido(pontoBase, undefined);
    expect(r).toEqual(pontoBase);
  });

  it("correção dentro do teto de 500m, aplica lat/lng do aprendido e mantém o resto", () => {
    // ~111m ao norte da posição original (0.001 grau de lat ~ 111m)
    const aprendido = { lat: -22.899, lng: -43.2, fonte: "aprendido" as const };
    const r = corrigirComPontoAprendido(pontoBase, aprendido);
    expect(r.lat).toBe(aprendido.lat);
    expect(r.lng).toBe(aprendido.lng);
    expect(r.raio).toBe(pontoBase.raio);
    expect(r.nome).toBe(pontoBase.nome);
    expect(r.pontoCodigo).toBe(pontoBase.pontoCodigo);
  });

  it("correção fora do teto de 500m, retorna o ponto inalterado (fonte aprendido)", () => {
    // ~1110m ao norte (0.01 grau de lat ~ 1110m, bem acima do teto de 500m)
    const aprendidoLonge = { lat: -22.89, lng: -43.2, fonte: "aprendido" as const };
    const r = corrigirComPontoAprendido(pontoBase, aprendidoLonge);
    expect(r).toEqual(pontoBase);
  });

  it("correção exatamente no teto (500m) ainda aplica", () => {
    // Calculado via haversineM real: 0.0044966078939030745 graus de latitude
    // produz exatamente ~500m de divergência (verificado com binary search)
    const aprendidoNoLimite = {
      lat: -22.9 + 0.0044966078939030745,
      lng: -43.2,
      fonte: "aprendido" as const,
    };
    const r = corrigirComPontoAprendido(pontoBase, aprendidoNoLimite);
    expect(r.lat).toBe(aprendidoNoLimite.lat);
    expect(r.lng).toBe(aprendidoNoLimite.lng);
  });

  it("correção acima do teto (>500m) retorna o ponto inalterado (fonte aprendido)", () => {
    // Calculado via haversineM real: 0.004506607893903074 graus de latitude
    // produz ~501.11m de divergência (ligeiramente acima do teto de 500m)
    const aprendidoAcimaDolimite = {
      lat: -22.9 + 0.004506607893903074,
      lng: -43.2,
      fonte: "aprendido" as const,
    };
    const r = corrigirComPontoAprendido(pontoBase, aprendidoAcimaDolimite);
    expect(r).toEqual(pontoBase);
  });

  it("fonte manual ignora o teto de 500m -- aplica mesmo com divergência de vários km", () => {
    // ~17.3km ao norte, mesma ordem de grandeza do pior caso real de 10/08
    // (Embaúba Boutique Hotel, cadastro Unitrac x endereço confirmado).
    const aprendidoManualLonge = { lat: -22.9 + 0.156, lng: -43.2, fonte: "manual" as const };
    const r = corrigirComPontoAprendido(pontoBase, aprendidoManualLonge);
    expect(r.lat).toBe(aprendidoManualLonge.lat);
    expect(r.lng).toBe(aprendidoManualLonge.lng);
    expect(r.raio).toBe(pontoBase.raio);
  });
});

describe("deveCorrigirComRomaneio", () => {
  const SP = { lat: -22.9, lng: -43.2 };

  it("não corrige se a entrega não está confirmada, mesmo com coordenada bem diferente", () => {
    const romaneio = { lat: -22.95, lng: -43.25 }; // ~7km de diferença
    expect(deveCorrigirComRomaneio(SP, romaneio, false, "cnefe")).toBe(false);
  });

  it("não corrige se a coordenada é essencialmente igual (ruído de geocode < 15m)", () => {
    const romaneio = { lat: -22.900001, lng: -43.200001 }; // ~0.15m
    expect(deveCorrigirComRomaneio(SP, romaneio, true, "cnefe")).toBe(false);
  });

  it("corrige quando confirmada, fonte=cnefe e diverge acima do piso de 15m", () => {
    const romaneio = { lat: -22.9003, lng: -43.2 }; // ~33m
    expect(deveCorrigirComRomaneio(SP, romaneio, true, "cnefe")).toBe(true);
  });

  it("corrige com divergência grande, ainda dentro do teto de 20km (mesma ordem do pior caso legítimo documentado, 17km)", () => {
    const romaneio = { lat: -22.98, lng: -43.2 }; // ~8,9km
    expect(deveCorrigirComRomaneio(SP, romaneio, true, "cnefe")).toBe(true);
  });

  // Achado real 12/08 (simulação contra o romaneio de hoje, casos
  // SEPETIBA/CAMPOS): geocode de romaneio pode errar por dezenas a
  // centenas de km quando rua homônima existe em cidade errada -- teto
  // evita corromper pontos_aprendidos mesmo com entrega "confirmada"
  // (confirmação é sobre a ENTREGA, não sobre a qualidade do geocode).
  it("NÃO corrige acima do teto de 20km, mesmo com entrega confirmada e fonte=cnefe", () => {
    const romaneio = { lat: -21.7, lng: -41.03 }; // ~230km (caso real: Grussaí/SJB geocodificado no Rio)
    expect(deveCorrigirComRomaneio(SP, romaneio, true, "cnefe")).toBe(false);
  });

  it("aceita teto customizado", () => {
    const romaneio = { lat: -22.9003, lng: -43.2 }; // ~33m
    expect(deveCorrigirComRomaneio(SP, romaneio, true, "cnefe", { tetoM: 20 })).toBe(false);
  });

  // Achado real 12/08: so CNEFE (dado de campo do IBGE, ja filtrado por
  // municipio na consulta) tem garantia forte o bastante pra corrigir
  // cadastro automaticamente -- local (OSM)/Google/Nominatim nao tem
  // filtro de municipio rigido, so proximidade de referencia, que ja
  // mostrou falhar em bairro grande (achado real 12/08, caso Rua Iate).
  it("NÃO corrige com fonte='local' (OSM), mesmo confirmada e dentro do teto", () => {
    const romaneio = { lat: -22.9003, lng: -43.2 }; // ~33m
    expect(deveCorrigirComRomaneio(SP, romaneio, true, "local")).toBe(false);
  });

  it("NÃO corrige com fonte='nominatim'", () => {
    const romaneio = { lat: -22.9003, lng: -43.2 };
    expect(deveCorrigirComRomaneio(SP, romaneio, true, "nominatim")).toBe(false);
  });

  it("NÃO corrige com fonte='google'", () => {
    const romaneio = { lat: -22.9003, lng: -43.2 };
    expect(deveCorrigirComRomaneio(SP, romaneio, true, "google")).toBe(false);
  });
});
