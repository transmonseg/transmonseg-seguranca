import { describe, it, expect, vi, beforeEach } from "vitest";
import { avaliarDesvioTeste, PARAMS_DESVIO_TESTE_PADRAO } from "./detectores-teste";
import { verificarCorredor, sequenciaOtimizadaOSRM } from "./corredor-verificacao";

vi.mock("./corredor-verificacao", () => ({
  verificarCorredor: vi.fn(),
  sequenciaOtimizadaOSRM: vi.fn(),
}));

const mockVerificarCorredor = vi.mocked(verificarCorredor);
const mockSequenciaOtimizada = vi.mocked(sequenciaOtimizadaOSRM);

const D1 = { id: "d1", lat: -22.91, lng: -43.21 };
const D2 = { id: "d2", lat: -22.92, lng: -43.22 };
const posAtual = { lat: -22.9, lng: -43.2, velocidade: 30 };

describe("avaliarDesvioTeste", () => {
  beforeEach(() => {
    mockVerificarCorredor.mockReset();
    mockSequenciaOtimizada.mockReset();
  });

  it("sem nenhum destino carregado: nao dispara, nao acumula, nao calcula sequencia", async () => {
    const r = await avaliarDesvioTeste(posAtual, [], { ultimaParadaReal: { lat: 1, lng: 1 }, foraStreak: 2, sequenciaIds: ["x"], sequenciaAtualizadaEm: new Date().toISOString() });
    expect(r.disparouAgora).toBe(false);
    expect(r.estado.foraStreak).toBe(0);
    expect(r.estado.sequenciaIds).toBeNull();
    expect(mockSequenciaOtimizada).not.toHaveBeenCalled();
    expect(mockVerificarCorredor).not.toHaveBeenCalled();
  });

  it("primeira leitura: usa a propria posicao como origem, calcula sequencia, testa corredor contra as proximas paradas", async () => {
    mockSequenciaOtimizada.mockResolvedValue(["d1", "d2"]);
    mockVerificarCorredor.mockResolvedValue({ veredito: "dentro", corredor: [] });
    const r = await avaliarDesvioTeste(posAtual, [D1, D2], null);
    expect(mockSequenciaOtimizada).toHaveBeenCalledWith({ lat: posAtual.lat, lng: posAtual.lng }, [D1, D2]);
    expect(mockVerificarCorredor).toHaveBeenCalledWith(
      { lat: posAtual.lat, lng: posAtual.lng },
      posAtual,
      [D1, D2].slice(0, PARAMS_DESVIO_TESTE_PADRAO.nProximasParadasTestadas)
    );
    expect(r.disparouAgora).toBe(false);
    expect(r.estado.sequenciaIds).toEqual(["d1", "d2"]);
  });

  it("chegou de verdade na proxima parada (raioVisitaM): reancora origem, remove da sequencia, nao chama verificarCorredor", async () => {
    mockSequenciaOtimizada.mockResolvedValue(["d1", "d2"]);
    const destinoPerto = { id: "d1", lat: posAtual.lat, lng: posAtual.lng };
    const r = await avaliarDesvioTeste(posAtual, [destinoPerto, D2], null);
    expect(r.disparouAgora).toBe(false);
    expect(r.estado.foraStreak).toBe(0);
    expect(r.estado.ultimaParadaReal).toEqual({ lat: posAtual.lat, lng: posAtual.lng });
    expect(r.estado.sequenciaIds).toEqual(["d2"]);
    expect(mockVerificarCorredor).not.toHaveBeenCalled();
  });

  it("fora do corredor N ciclos seguidos dispara no limiar exato", async () => {
    mockSequenciaOtimizada.mockResolvedValue(["d1", "d2"]);
    mockVerificarCorredor.mockResolvedValue({ veredito: "fora", corredor: null });
    let estado: Awaited<ReturnType<typeof avaliarDesvioTeste>>["estado"] | null = null;
    let disparou = false;
    for (let i = 0; i < PARAMS_DESVIO_TESTE_PADRAO.streakMinParaDisparar; i++) {
      const r = await avaliarDesvioTeste(posAtual, [D1, D2], estado);
      estado = r.estado;
      disparou = r.disparouAgora;
    }
    expect(disparou).toBe(true);
    expect(estado!.foraStreak).toBe(PARAMS_DESVIO_TESTE_PADRAO.streakMinParaDisparar);
  });

  it("nao dispara antes de atingir o streak minimo", async () => {
    mockSequenciaOtimizada.mockResolvedValue(["d1", "d2"]);
    mockVerificarCorredor.mockResolvedValue({ veredito: "fora", corredor: null });
    let estado: Awaited<ReturnType<typeof avaliarDesvioTeste>>["estado"] | null = null;
    let algumDisparo = false;
    for (let i = 0; i < PARAMS_DESVIO_TESTE_PADRAO.streakMinParaDisparar - 1; i++) {
      const r = await avaliarDesvioTeste(posAtual, [D1, D2], estado);
      estado = r.estado;
      if (r.disparouAgora) algumDisparo = true;
    }
    expect(algumDisparo).toBe(false);
  });

  it("dispara so uma vez -- streak continua fora mas ja passou do limiar antes", async () => {
    mockSequenciaOtimizada.mockResolvedValue(["d1", "d2"]);
    mockVerificarCorredor.mockResolvedValue({ veredito: "fora", corredor: null });
    let estado: Awaited<ReturnType<typeof avaliarDesvioTeste>>["estado"] | null = null;
    const disparos: boolean[] = [];
    for (let i = 0; i < PARAMS_DESVIO_TESTE_PADRAO.streakMinParaDisparar + 3; i++) {
      const r = await avaliarDesvioTeste(posAtual, [D1, D2], estado);
      estado = r.estado;
      disparos.push(r.disparouAgora);
    }
    expect(disparos.filter(Boolean).length).toBe(1);
  });

  it("indisponivel (fail-open): nao dispara nem reseta o streak", async () => {
    mockSequenciaOtimizada.mockResolvedValue(["d1", "d2"]);
    mockVerificarCorredor
      .mockResolvedValueOnce({ veredito: "fora", corredor: null })
      .mockResolvedValueOnce({ veredito: "fora", corredor: null })
      .mockResolvedValueOnce({ veredito: "indisponivel", corredor: null });
    let estado: Awaited<ReturnType<typeof avaliarDesvioTeste>>["estado"] | null = null;
    for (let i = 0; i < 3; i++) {
      const r = await avaliarDesvioTeste(posAtual, [D1, D2], estado);
      estado = r.estado;
    }
    expect(estado!.foraStreak).toBe(2);
  });

  it("sequencia cacheada e valida: nao recalcula (sequenciaOtimizadaOSRM nao e chamado de novo)", async () => {
    mockVerificarCorredor.mockResolvedValue({ veredito: "dentro", corredor: [] });
    const estadoAnterior = {
      ultimaParadaReal: { lat: -22.905, lng: -43.205 },
      foraStreak: 0,
      sequenciaIds: ["d1", "d2"],
      sequenciaAtualizadaEm: new Date().toISOString(),
    };
    await avaliarDesvioTeste(posAtual, [D1, D2], estadoAnterior);
    expect(mockSequenciaOtimizada).not.toHaveBeenCalled();
  });

  it("conjunto de destinos mudou (pendente novo): recalcula a sequencia mesmo com cache recente", async () => {
    mockSequenciaOtimizada.mockResolvedValue(["d1", "d2", "d3"]);
    mockVerificarCorredor.mockResolvedValue({ veredito: "dentro", corredor: [] });
    const D3 = { id: "d3", lat: -22.93, lng: -43.23 };
    const estadoAnterior = {
      ultimaParadaReal: { lat: -22.905, lng: -43.205 },
      foraStreak: 0,
      sequenciaIds: ["d1", "d2"],
      sequenciaAtualizadaEm: new Date().toISOString(),
    };
    await avaliarDesvioTeste(posAtual, [D1, D2, D3], estadoAnterior);
    expect(mockSequenciaOtimizada).toHaveBeenCalledTimes(1);
  });

  it("cache velho demais (passou sequenciaValidadeMin): recalcula mesmo com o mesmo conjunto de destinos", async () => {
    mockSequenciaOtimizada.mockResolvedValue(["d1", "d2"]);
    mockVerificarCorredor.mockResolvedValue({ veredito: "dentro", corredor: [] });
    const antigo = new Date(Date.now() - (PARAMS_DESVIO_TESTE_PADRAO.sequenciaValidadeMin + 5) * 60000).toISOString();
    const estadoAnterior = {
      ultimaParadaReal: { lat: -22.905, lng: -43.205 },
      foraStreak: 0,
      sequenciaIds: ["d1", "d2"],
      sequenciaAtualizadaEm: antigo,
    };
    await avaliarDesvioTeste(posAtual, [D1, D2], estadoAnterior);
    expect(mockSequenciaOtimizada).toHaveBeenCalledTimes(1);
  });

  it("recalculo falha mas ja tinha cache antigo: usa o cache antigo em vez de travar (fail-open parcial)", async () => {
    mockSequenciaOtimizada.mockResolvedValue(null);
    mockVerificarCorredor.mockResolvedValue({ veredito: "dentro", corredor: [] });
    const D3 = { id: "d3", lat: -22.93, lng: -43.23 };
    const estadoAnterior = {
      ultimaParadaReal: { lat: -22.905, lng: -43.205 },
      foraStreak: 1,
      sequenciaIds: ["d1", "d2"],
      sequenciaAtualizadaEm: new Date().toISOString(),
    };
    const r = await avaliarDesvioTeste(posAtual, [D1, D2, D3], estadoAnterior);
    expect(r.estado.sequenciaIds).toEqual(["d1", "d2"]);
    expect(mockVerificarCorredor).toHaveBeenCalled();
  });

  it("recalculo falha e nao ha cache nenhum: fail-open total, nao dispara nem acumula", async () => {
    mockSequenciaOtimizada.mockResolvedValue(null);
    const r = await avaliarDesvioTeste(posAtual, [D1, D2], { ultimaParadaReal: { lat: -22.905, lng: -43.205 }, foraStreak: 2, sequenciaIds: null, sequenciaAtualizadaEm: null });
    expect(r.disparouAgora).toBe(false);
    expect(r.estado.foraStreak).toBe(2);
    expect(mockVerificarCorredor).not.toHaveBeenCalled();
  });

  it("testa so as N proximas paradas da sequencia (tolerancia a desvio de ordem), nao todos os destinos", async () => {
    const D3 = { id: "d3", lat: -22.93, lng: -43.23 };
    mockSequenciaOtimizada.mockResolvedValue(["d2", "d3", "d1"]);
    mockVerificarCorredor.mockResolvedValue({ veredito: "dentro", corredor: [] });
    await avaliarDesvioTeste(posAtual, [D1, D2, D3], null);
    const chamada = mockVerificarCorredor.mock.calls[0];
    expect(chamada[2]).toEqual([D2, D3]);
  });

  it("PARAMS_DESVIO_TESTE_PADRAO tem os campos exigidos", () => {
    expect(PARAMS_DESVIO_TESTE_PADRAO.streakMinParaDisparar).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.raioVisitaM).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.nProximasParadasTestadas).toBeGreaterThan(0);
    expect(PARAMS_DESVIO_TESTE_PADRAO.sequenciaValidadeMin).toBeGreaterThan(0);
  });
});
