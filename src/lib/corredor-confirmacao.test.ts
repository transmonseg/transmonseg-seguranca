import { describe, it, expect, vi, afterEach } from "vitest";
import {
  bufferPorVelocidade,
  dentroDoCorredor,
  verificarCorredorFora,
  aplicarCorroboracaoCorredor,
} from "./corredor-confirmacao";

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

  // Achado da revisao final (14/08, item 6 Minor): o loop nao pode dar
  // short-circuit "otimista" no primeiro destino que der fora -- precisa
  // continuar ate achar um "dentro" (ou esgotar a lista/deadline) antes de
  // decidir. Aqui o 1o destino testado da fora do buffer, o 2o da dentro:
  // o resultado final tem que ser confirmaFora=false (rota legitima achada
  // depois de ja ter visto um "fora"), nao true.
  it("1o destino da fora do buffer, 2o da dentro: confirmaFora=false (nao para no primeiro 'fora')", async () => {
    const fn = mockFetchSequence([
      // destino B: rota longe de POS_ATUAL -- "fora"
      respostaRotaOk([[-43.10, -22.80], [-43.10, -22.82]]),
      // destino A: rota que passa perto de POS_ATUAL -- "dentro"
      respostaRotaOk([[-43.20, -22.90], [-43.20, -22.895], [-43.20, -22.89]]),
    ]);
    const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_B, DEST_A]);
    expect(r).toEqual({ confirmaFora: false });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Achado da revisao final (14/08, item 6 Minor): confirma que o deadline
  // TOTAL do loop (checado a cada iteracao, nao por chamada individual)
  // realmente impede destinos subsequentes de serem testados quando o
  // tempo acumulado estoura -- sem depender de esperar o tempo real (o que
  // deixaria o teste lento/flaky). Mocka Date.now() pra simular, de forma
  // deterministica, que o relogio avancou alem do deadline entre a checagem
  // do 1o e do 2o destino -- o 2o nunca chega a disparar fetch.
  it("deadline total estourado entre destinos: destinos restantes nao sao testados", async () => {
    const fn = mockFetchSequence([
      // destino B: rota longe de POS_ATUAL -- "fora" (unico que sera testado)
      respostaRotaOk([[-43.10, -22.80], [-43.10, -22.82]]),
    ]);
    let chamadasDateNow = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      chamadasDateNow++;
      // 1a chamada: `inicio`. 2a chamada: checagem do deadline antes do
      // 1o destino (ainda dentro do prazo). Da 3a em diante: alem do
      // deadline de 3s -- estoura antes de sequer chegar no 2o destino.
      return chamadasDateNow <= 2 ? 1_000 : 10_000;
    });
    try {
      const r = await verificarCorredorFora(ORIGEM, POS_ATUAL, [DEST_B, DEST_A]);
      // So o destino B foi testado (fora, sucesso) -- A nunca chegou a
      // rodar, mas como B ja confirmou sucesso sem bater o buffer,
      // confirmaFora fica true (reflete so o que deu tempo de checar).
      expect(r).toEqual({ confirmaFora: true });
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("aplicarCorroboracaoCorredor", () => {
  it("confirmaFora=false: retorna o MESMO objeto, sem mutacao (score/motivo inalterados)", () => {
    const alerta = { score: 50, motivo: "Desvio do trajeto esperado" };
    const r = aplicarCorroboracaoCorredor(alerta, false, 15);
    expect(r).toBe(alerta);
    expect(r.score).toBe(50);
    expect(r.motivo).toBe("Desvio do trajeto esperado");
  });

  it("confirmaFora=true: score sobe pelo bonus e motivo ganha o sufixo de corroboracao", () => {
    const alerta = { score: 50, motivo: "Desvio do trajeto esperado" };
    const r = aplicarCorroboracaoCorredor(alerta, true, 15);
    expect(r.score).toBe(65);
    expect(r.motivo).toBe("Desvio do trajeto esperado (corroborado por: corredor real fora de rota)");
    expect(alerta.score).toBe(50); // original preservado, sem mutacao
  });

  it("confirmaFora=true com score inicial alto: nunca passa de 100 (95 + 15 = 100, nao 110)", () => {
    const alerta = { score: 95, motivo: "Desvio critico" };
    const r = aplicarCorroboracaoCorredor(alerta, true, 15);
    expect(r.score).toBe(100);
  });
});

// Garantia de fail-open em route.ts (item 4 da revisao final 14/08):
// verificarCorredorFora e' chamada dentro de um bloco try/catch (ver
// src/app/api/motor/route.ts, comentario "Corredor real via OSRM como
// sinal de CORROBORACAO"), sempre DEPOIS de alertaDesvioV2 ja existir
// (dentro de `if (alertaDesvioV2) { ... }`). Uma falha ali (excecao de
// rede, timeout, erro de query na ancora) cai no `catch (errCorredor)`,
// que so' faz `erros.push(...)` -- sem throw, sem return, sem qualquer
// caminho que aborte o ciclo do veiculo. `corredorConfirmou` permanece
// `false` e `alertaDesvioV2` segue intacto (sem bonus) ate o INSERT em
// `desvio_disparo_log` logo abaixo, que roda incondicionalmente dentro do
// seu proprio `if (alertaDesvioV2)`. Ou seja: o alerta SEMPRE grava,
// corredor confirmando, falhando, ou nao rodando. Nao testavel isolado
// aqui (route.ts nao tem harness de teste -- depende de pool.query real e
// do runtime do Next) -- confirmado por leitura de codigo, nao automatizado.
