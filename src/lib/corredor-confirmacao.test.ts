import { describe, it, expect, vi, afterEach } from "vitest";
import { bufferPorVelocidade, dentroDoCorredor, verificarCorredorFora } from "./corredor-confirmacao";

describe("bufferPorVelocidade (adaptativo: cidade estreito, rodovia largo)", () => {
  it("abaixo de 60 km/h: 120m (urbano)", () => {
    expect(bufferPorVelocidade(40)).toBe(120);
    expect(bufferPorVelocidade(0)).toBe(120);
  });
  it("60 km/h ou mais: 200m (rodovia/serra)", () => {
    expect(bufferPorVelocidade(60)).toBe(200);
    expect(bufferPorVelocidade(90)).toBe(200);
  });
});

describe("dentroDoCorredor", () => {
  const polilinha = [
    { lat: -22.90, lng: -43.20 },
    { lat: -22.895, lng: -43.20 },
    { lat: -22.89, lng: -43.20 },
  ];
  it("ponto a ~100m da linha, buffer 300m: dentro", () => {
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

function mockFetchSequence(respostas: (unknown | null)[]) {
  const fn = vi.fn();
  for (const r of respostas) {
    if (r === null) fn.mockRejectedValueOnce(new Error("network"));
    else fn.mockResolvedValueOnce({ ok: true, json: async () => r });
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ORIGEM = { lat: -22.90, lng: -43.20 };
const POS_ATUAL = { lat: -22.895, lng: -43.199, velocidade: 40 };
const DEST_A = { lat: -22.89, lng: -43.20 };
const DEST_B = { lat: -22.80, lng: -43.10 };

function respostaRotaOk(coords: [number, number][]) {
  return { code: "Ok", routes: [{ geometry: { coordinates: coords } }] };
}

describe("verificarCorredorFora", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sem destinos: confirmaFora=false (nada pra verificar)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, []);
    expect(r).toEqual({ confirmaFora: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posicao atual dentro do buffer da rota pro destino A: confirmaFora=false (dentro de rota legitima)", async () => {
    mockFetchSequence([
      respostaRotaOk([[-43.20, -22.90], [-43.20, -22.895], [-43.20, -22.89]]),
    ]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_A]);
    expect(r).toEqual({ confirmaFora: false });
  });

  it("posicao atual fora do buffer de TODOS os destinos testados com sucesso: confirmaFora=true", async () => {
    mockFetchSequence([
      respostaRotaOk([[-43.10, -22.80], [-43.10, -22.85]]),
      respostaRotaOk([[-43.10, -22.80], [-43.10, -22.82]]),
    ]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_B, DEST_B]);
    expect(r).toEqual({ confirmaFora: true });
  });

  it("OSRM indisponivel pra todos os destinos: confirmaFora=false (fail-open, sem bonus)", async () => {
    mockFetchSequence([null, null]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_A, DEST_B]);
    expect(r).toEqual({ confirmaFora: false });
  });

  it("1o destino falha (rede), 2o confirma fora: confirmaFora=true (pontual nao aborta o resto)", async () => {
    mockFetchSequence([
      null,
      respostaRotaOk([[-43.10, -22.80], [-43.10, -22.82]]),
    ]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_B, DEST_B]);
    expect(r).toEqual({ confirmaFora: true });
  });

  it("resposta HTTP nao-ok pro unico destino: confirmaFora=false", async () => {
    const fn = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fn);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_A]);
    expect(r).toEqual({ confirmaFora: false });
  });

  it("code != Ok: trata como rota nao resolvida (segue pro proximo, sem contar sucesso)", async () => {
    const fn = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ code: "NoRoute" }) });
    vi.stubGlobal("fetch", fn);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_A]);
    expect(r).toEqual({ confirmaFora: false });
  });
});
