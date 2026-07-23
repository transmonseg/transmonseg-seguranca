import { describe, it, expect, vi, afterEach } from "vitest";
import { bufferPorVelocidade, dentroDoCorredor, decodePolyline6, verificarCorredor, ordenarPendentesPorDistancia, ordenarPorPrioridadeVerificacao, parOrigemDestinoTemHistoricoSuficiente, deveVerificarRecuperacao, paradaLongaInvalidaCache } from "./corredor-verificacao";

describe("bufferPorVelocidade (adaptativo: cidade estreito, rodovia largo)", () => {
  // Reduzido 11/07 (diretiva explicita: falso positivo aceitavel, prioridade
  // e nunca perder desvio real) -- 300/600m escondia desvios de ~100-200m.
  it("abaixo de 60 km/h: 120m (urbano)", () => {
    expect(bufferPorVelocidade(40)).toBe(120);
    expect(bufferPorVelocidade(0)).toBe(120);
  });
  it("60 km/h ou mais: 200m (rodovia/serra)", () => {
    expect(bufferPorVelocidade(60)).toBe(200);
    expect(bufferPorVelocidade(90)).toBe(200);
  });
  it("dentro de 300m de um destino: 250m (zona de chegada), independente da velocidade", () => {
    expect(bufferPorVelocidade(40, 100)).toBe(250);
    expect(bufferPorVelocidade(90, 300)).toBe(250);
    expect(bufferPorVelocidade(0, 0)).toBe(250);
  });
  it("mais de 300m de um destino: comportamento normal por velocidade", () => {
    expect(bufferPorVelocidade(40, 301)).toBe(120);
    expect(bufferPorVelocidade(90, 5000)).toBe(200);
  });
  it("sem distancia informada (parametro omitido): comportamento atual preservado", () => {
    expect(bufferPorVelocidade(40)).toBe(120);
    expect(bufferPorVelocidade(90)).toBe(200);
  });
});

describe("dentroDoCorredor", () => {
  // Polilinha reta de ~1.1km na vertical (0.01 grau de lat)
  const polilinha = [
    { lat: -22.90, lng: -43.20 },
    { lat: -22.895, lng: -43.20 },
    { lat: -22.89, lng: -43.20 },
  ];
  it("ponto a ~100m da linha, buffer 300m: dentro", () => {
    // 0.001 grau de lng a -22.9 ~ 102m
    expect(dentroDoCorredor({ lat: -22.895, lng: -43.199 }, polilinha, 300)).toBe(true);
  });
  it("ponto a ~1km da linha, buffer 300m: fora", () => {
    expect(dentroDoCorredor({ lat: -22.895, lng: -43.19 }, polilinha, 300)).toBe(false);
  });
  it("mesmo ponto a ~1km, buffer 600m (rodovia): ainda fora", () => {
    expect(dentroDoCorredor({ lat: -22.895, lng: -43.19 }, polilinha, 600)).toBe(false);
  });
  it("polilinha vazia ou de 1 ponto: nunca dentro (defensivo)", () => {
    expect(dentroDoCorredor({ lat: -22.9, lng: -43.2 }, [], 300)).toBe(false);
    expect(dentroDoCorredor({ lat: -22.9, lng: -43.2 }, [{ lat: -22.9, lng: -43.2 }], 300)).toBe(false);
  });
});

// Encoder minimo so pro teste (inverso do decoder) — nao vai pra producao.
function encodePolyline6ParaTeste(coords: [number, number][]): string {
  let out = "";
  let prevLat = 0, prevLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    s += String.fromCharCode(n + 63);
    return s;
  };
  for (const [lat, lng] of coords) {
    const iLat = Math.round(lat * 1e6), iLng = Math.round(lng * 1e6);
    out += enc(iLat - prevLat) + enc(iLng - prevLng);
    prevLat = iLat; prevLng = iLng;
  }
  return out;
}

describe("decodePolyline6 (formato do Valhalla)", () => {
  it("decodifica um shape simples de 2 pontos", () => {
    const pts = decodePolyline6(encodePolyline6ParaTeste([[-22.9, -43.2], [-22.89, -43.19]]));
    expect(pts).toHaveLength(2);
    expect(pts[0].lat).toBeCloseTo(-22.9, 5);
    expect(pts[0].lng).toBeCloseTo(-43.2, 5);
    expect(pts[1].lat).toBeCloseTo(-22.89, 5);
  });
});

function mockOsrmGeojson(coords: [number, number][]) {
  return {
    ok: true,
    json: async () => ({ code: "Ok", routes: [{ distance: 1000, geometry: { coordinates: coords } }] }),
  };
}

describe("verificarCorredor (fetch mockado, origem FIXA != posicao atual)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("veiculo em cima da rota (origem->destino) na posicao atual: dentro + retorna o corredor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockOsrmGeojson([[-43.20, -22.90], [-43.20, -22.895], [-43.20, -22.89]])
    ));
    const r = await verificarCorredor(
      { lat: -22.90, lng: -43.20 }, // origem: ponto fixo anterior (ex. desvio_inicio)
      { lat: -22.895, lng: -43.20, velocidade: 40 }, // posicao atual, em cima da rota
      [{ lat: -22.89, lng: -43.20 }]
    );
    expect(r.veredito).toBe("dentro");
    expect(r.corredor?.length).toBeGreaterThan(1);
  });

  it("veiculo longe de TODAS as rotas: fora", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockOsrmGeojson([[-43.20, -22.90], [-43.20, -22.89]])
    ));
    const r = await verificarCorredor(
      { lat: -22.90, lng: -43.20 },
      { lat: -22.895, lng: -43.15, velocidade: 40 }, // ~5km da rota
      [{ lat: -22.89, lng: -43.20 }]
    );
    expect(r.veredito).toBe("fora");
  });

  it("regressao do bug tautologico (10/07): origem != posicao atual, rota nao passa perto da posicao atual -> fora, mesmo com origem valida", async () => {
    // Antes do fix, a rota era tracada DA posicao atual, entao qualquer
    // posicao sempre "estava em cima" da propria rota (distancia 0 do
    // primeiro ponto). Aqui a rota sai de uma origem fixa e vai para o
    // destino SEM passar perto de onde o veiculo esta agora -- se o bug
    // tivesse voltado (posAtual usado como origem por engano), este teste
    // veria "dentro" errado em vez de "fora".
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockOsrmGeojson([[-43.30, -23.00], [-43.25, -22.95], [-43.20, -22.90]])
    ));
    const r = await verificarCorredor(
      { lat: -23.00, lng: -43.30 }, // origem: onde o veiculo estava confirmado antes
      { lat: -22.50, lng: -42.50, velocidade: 40 }, // posicao atual, longe da rota real
      [{ lat: -22.90, lng: -43.20 }]
    );
    expect(r.veredito).toBe("fora");
  });

  it("OSRM e Valhalla mortos: indisponivel (fail-open, quem chama dispara como hoje)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const r = await verificarCorredor(
      { lat: -22.90, lng: -43.20 },
      { lat: -22.895, lng: -43.20, velocidade: 40 },
      [{ lat: -22.89, lng: -43.20 }]
    );
    expect(r.veredito).toBe("indisponivel");
  });

  it("sem destinos: indisponivel (nada pra verificar)", async () => {
    const r = await verificarCorredor({ lat: -22.9, lng: -43.2 }, { lat: -22.9, lng: -43.2, velocidade: 40 }, []);
    expect(r.veredito).toBe("indisponivel");
  });
});

describe("ordenarPendentesPorDistancia (substitui o corte fixo em 3 mais proximos)", () => {
  it("ordena todos os pendentes por distancia crescente, sem cortar nenhum", () => {
    const pos = { lat: -22.90, lng: -43.20 };
    const pendentes = [
      { lat: -22.90, lng: -43.20 + 0.05, nome: "longe" },
      { lat: -22.90, lng: -43.20 + 0.01, nome: "perto" },
      { lat: -22.90, lng: -43.20 + 0.03, nome: "medio" },
      { lat: -22.90, lng: -43.20 + 0.09, nome: "muito longe" },
    ];
    const resultado = ordenarPendentesPorDistancia(pos, pendentes);
    expect(resultado.map((p) => p.nome)).toEqual(["perto", "medio", "longe", "muito longe"]);
    expect(resultado).toHaveLength(4);
  });

  it("lista vazia retorna vazia", () => {
    expect(ordenarPendentesPorDistancia({ lat: 0, lng: 0 }, [])).toEqual([]);
  });

  it("com rumoAtual: candidato alinhado com o rumo vence mesmo estando mais longe", () => {
    const pos = { lat: -22.90, lng: -43.20 };
    // "norte" fica ~1.1km ao norte (rumo ~0), "leste_perto" fica ~200m a leste (rumo ~90).
    const pendentes = [
      { lat: -22.90, lng: -43.20 + 0.002, nome: "leste_perto" },
      { lat: -22.90 + 0.01, lng: -43.20, nome: "norte" },
    ];
    // rumoAtual = 0 (indo pro norte): "norte" esta na mesma faixa angular
    // (dif ~0) e deve vencer mesmo sendo mais longe que "leste_perto" (dif ~90).
    const resultado = ordenarPendentesPorDistancia(pos, pendentes, 0);
    expect(resultado.map((p) => p.nome)).toEqual(["norte", "leste_perto"]);
  });

  it("com rumoAtual: dentro da mesma faixa angular (30 graus), desempata por distancia", () => {
    const pos = { lat: -22.90, lng: -43.20 };
    const pendentes = [
      { lat: -22.90 + 0.02, lng: -43.20, nome: "norte_longe" },
      { lat: -22.90 + 0.005, lng: -43.20 + 0.001, nome: "quase_norte_perto" },
    ];
    // Ambos com rumo bem proximo de 0 (mesma faixa de 30 graus) -- o mais
    // perto vence dentro da faixa.
    const resultado = ordenarPendentesPorDistancia(pos, pendentes, 0);
    expect(resultado.map((p) => p.nome)).toEqual(["quase_norte_perto", "norte_longe"]);
  });

  it("sem rumoAtual (null ou omitido): comportamento atual preservado, so distancia", () => {
    const pos = { lat: -22.90, lng: -43.20 };
    const pendentes = [
      { lat: -22.90, lng: -43.20 + 0.05, nome: "longe" },
      { lat: -22.90, lng: -43.20 + 0.01, nome: "perto" },
    ];
    expect(ordenarPendentesPorDistancia(pos, pendentes, null).map((p) => p.nome)).toEqual(["perto", "longe"]);
    expect(ordenarPendentesPorDistancia(pos, pendentes).map((p) => p.nome)).toEqual(["perto", "longe"]);
  });
});

describe("parOrigemDestinoTemHistoricoSuficiente", () => {
  it("menos de 3 dias distintos: false", () => {
    expect(parOrigemDestinoTemHistoricoSuficiente(2, 3)).toBe(false);
  });
  it("3 ou mais dias distintos: true", () => {
    expect(parOrigemDestinoTemHistoricoSuficiente(3, 3)).toBe(true);
    expect(parOrigemDestinoTemHistoricoSuficiente(10, 3)).toBe(true);
  });
});

describe("ordenarPorPrioridadeVerificacao (rotação justa do orçamento de OSRM)", () => {
  it("ordena veiculos nunca verificados (ausentes do mapa) antes dos ja verificados", () => {
    const itens = [
      { veiculo_id: "ja-verificado", label: "A" },
      { veiculo_id: "nunca-verificado", label: "B" },
    ];
    const ultimaVerificacao = new Map([["ja-verificado", 1000]]);
    const resultado = ordenarPorPrioridadeVerificacao(itens, ultimaVerificacao);
    expect(resultado.map((x) => x.label)).toEqual(["B", "A"]);
  });

  it("ordena por timestamp ascendente -- verificado ha mais tempo primeiro", () => {
    const itens = [
      { veiculo_id: "recente", label: "recente" },
      { veiculo_id: "antigo", label: "antigo" },
      { veiculo_id: "medio", label: "medio" },
    ];
    const ultimaVerificacao = new Map([
      ["recente", 3000],
      ["antigo", 1000],
      ["medio", 2000],
    ]);
    const resultado = ordenarPorPrioridadeVerificacao(itens, ultimaVerificacao);
    expect(resultado.map((x) => x.label)).toEqual(["antigo", "medio", "recente"]);
  });

  it("nao muda a lista original (retorna copia nova)", () => {
    const itens = [{ veiculo_id: "x", label: "x" }];
    const original = [...itens];
    ordenarPorPrioridadeVerificacao(itens, new Map());
    expect(itens).toEqual(original);
  });

  it("com mapa vazio, mantem a ordem original (todos empatados em prioridade)", () => {
    const itens = [
      { veiculo_id: "a", label: "a" },
      { veiculo_id: "b", label: "b" },
      { veiculo_id: "c", label: "c" },
    ];
    const resultado = ordenarPorPrioridadeVerificacao(itens, new Map());
    expect(resultado.map((x) => x.label)).toEqual(["a", "b", "c"]);
  });
});

describe("deveVerificarRecuperacao (economia de orcamento OSRM na cerca virtual)", () => {
  it("area conhecida pela frota (dentroTapete=true): NAO precisa verificar", () => {
    expect(deveVerificarRecuperacao(true, null)).toBe(false);
  });

  it("area conhecida so pelo proprio veiculo (familiarVeiculo=true): NAO precisa verificar", () => {
    expect(deveVerificarRecuperacao(null, true)).toBe(false);
  });

  it("area conhecida pelos dois (frota E veiculo): NAO precisa verificar", () => {
    expect(deveVerificarRecuperacao(true, true)).toBe(false);
  });

  it("area desconhecida pelos dois (false/false): PRECISA verificar", () => {
    expect(deveVerificarRecuperacao(false, false)).toBe(true);
  });

  it("sem cobertura minima nos dois (null/null, cold-start): PRECISA verificar", () => {
    expect(deveVerificarRecuperacao(null, null)).toBe(true);
  });

  it("frota desconhece mas veiculo cold-start (false/null): PRECISA verificar", () => {
    expect(deveVerificarRecuperacao(false, null)).toBe(true);
  });

  it("veiculo desconhece mas frota cold-start (null/false): PRECISA verificar", () => {
    expect(deveVerificarRecuperacao(null, false)).toBe(true);
  });
});

describe("paradaLongaInvalidaCache (achado 22/07: gap do design original de 09/07)", () => {
  const AGORA = new Date("2026-07-22T12:00:00.000Z").getTime();

  it("parado ha menos de 5min: nao invalida", () => {
    const paradoDesde = new Date(AGORA - 3 * 60_000).toISOString();
    expect(paradaLongaInvalidaCache(0, paradoDesde, AGORA)).toBe(false);
  });

  it("parado ha exatamente 5min: invalida", () => {
    const paradoDesde = new Date(AGORA - 5 * 60_000).toISOString();
    expect(paradaLongaInvalidaCache(0, paradoDesde, AGORA)).toBe(true);
  });

  it("parado ha mais de 5min: invalida", () => {
    const paradoDesde = new Date(AGORA - 10 * 60_000).toISOString();
    expect(paradaLongaInvalidaCache(0, paradoDesde, AGORA)).toBe(true);
  });

  it("veiculo NAO estava parado no ciclo anterior (velocidade != 0): nao invalida, mesmo com parado_desde preenchido", () => {
    const paradoDesde = new Date(AGORA - 10 * 60_000).toISOString();
    expect(paradaLongaInvalidaCache(40, paradoDesde, AGORA)).toBe(false);
  });

  it("sem parado_desde (null): nao invalida, mesmo com velocidade=0", () => {
    expect(paradaLongaInvalidaCache(0, null, AGORA)).toBe(false);
  });
});
