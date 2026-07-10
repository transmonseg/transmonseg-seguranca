import { describe, it, expect, vi, afterEach } from "vitest";
import { bufferPorVelocidade, dentroDoCorredor, decodePolyline6, verificarCorredor } from "./corredor-verificacao";

describe("bufferPorVelocidade (adaptativo: cidade estreito, rodovia largo)", () => {
  it("abaixo de 60 km/h: 300m (urbano)", () => {
    expect(bufferPorVelocidade(40)).toBe(300);
    expect(bufferPorVelocidade(0)).toBe(300);
  });
  it("60 km/h ou mais: 600m (rodovia/serra)", () => {
    expect(bufferPorVelocidade(60)).toBe(600);
    expect(bufferPorVelocidade(90)).toBe(600);
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
