// Testes unitários do motor de detecção (Vitest).
import { describe, it, expect } from "vitest";
import {
  detectarPanico,
  detectarBau,
  detectarJammer,
  detectarExcessoVelocidade,
  detectarParadaCliente,
  detectarParadaLonga,
  detectarParadaAnomala,
  detectarDesvio,
  detectarTiroteioProximo,
  detectarSaidaNaoAutorizada,
  foraDeRota,
  avaliar,
  formataDuracao,
  emHorarioOperacao,
} from "./detectores";
import type { PosicaoNormalizada } from "./unitrac";

function posicaoBase(overrides: Partial<PosicaoNormalizada> = {}): PosicaoNormalizada {
  return {
    cv: "1234",
    placa: "ABC-1234",
    lat: -22.9,
    lng: -43.2,
    velocidade: 0,
    ignicao: false,
    atraso: 0,
    panico: false,
    bau: false,
    datagps: "2026-06-22T10:00:00Z",
    fresco: true,
    ...overrides,
  };
}

describe("formataDuracao", () => {
  it("formata minutos abaixo de 1h", () => {
    expect(formataDuracao(45)).toBe("45min");
  });
  it("formata 95 minutos como 1h35min", () => {
    expect(formataDuracao(95)).toBe("1h35min");
  });
  it("formata exatamente 1h", () => {
    expect(formataDuracao(60)).toBe("1h");
  });
  it("formata 2h10min", () => {
    expect(formataDuracao(130)).toBe("2h10min");
  });
});

describe("detectarPanico", () => {
  it("panico=true retorna alerta critico", () => {
    const alerta = detectarPanico(posicaoBase({ panico: true }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("panico");
    expect(alerta?.score).toBe(100);
  });
  it("panico=false retorna null", () => {
    expect(detectarPanico(posicaoBase({ panico: false }))).toBeNull();
  });
});

describe("detectarBau", () => {
  it("bau=true retorna alerta critico", () => {
    const alerta = detectarBau(posicaoBase({ bau: true }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("bau");
    expect(alerta?.score).toBe(90);
  });
  it("bau=false retorna null", () => {
    expect(detectarBau(posicaoBase({ bau: false }))).toBeNull();
  });
});

describe("detectarJammer", () => {
  it("ignicao ligada e atraso=30 retorna jammer critico", () => {
    const alerta = detectarJammer(posicaoBase({ ignicao: true, atraso: 30 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("jammer");
    expect(alerta?.score).toBe(80);
  });
  it("atraso no limite inferior (30) aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 30 }))).not.toBeNull();
  });
  it("atraso abaixo da janela (15) nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 15 }))).toBeNull();
  });
  it("atraso no limite superior (720) aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 720 }))).not.toBeNull();
  });
  it("ignicao desligada nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: false, atraso: 30 }))).toBeNull();
  });
  it("atraso fora da janela (721) nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 721 }))).toBeNull();
  });
  it("atraso=0 nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 0 }))).toBeNull();
  });
});

describe("detectarExcessoVelocidade", () => {
  it("velocidade=121 retorna excesso atencao", () => {
    const alerta = detectarExcessoVelocidade(posicaoBase({ velocidade: 121 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.tipo).toBe("excesso");
    expect(alerta?.score).toBe(40);
  });
  it("velocidade=120 nao aciona (limite e >120)", () => {
    expect(detectarExcessoVelocidade(posicaoBase({ velocidade: 120 }))).toBeNull();
  });
  it("velocidade=100 nao aciona", () => {
    expect(detectarExcessoVelocidade(posicaoBase({ velocidade: 100 }))).toBeNull();
  });
  it("velocidade=60 nao aciona", () => {
    expect(detectarExcessoVelocidade(posicaoBase({ velocidade: 60 }))).toBeNull();
  });
});

// Datas de referencia para emHorarioOperacao.
// America/Sao_Paulo = UTC-3 (fora do horario de verao, ex: junho).
// Sabado 10h SP = sabado 13h UTC → new Date("2026-06-20T13:00:00Z")
// Quarta 14h SP = quarta 17h UTC  → new Date("2026-06-17T17:00:00Z")
// Quarta 23h SP = quinta 02h UTC  → new Date("2026-06-18T02:00:00Z")
describe("emHorarioOperacao", () => {
  it("sabado retorna false", () => {
    // 2026-06-20 e sabado; 10h SP = 13h UTC
    expect(emHorarioOperacao(new Date("2026-06-20T13:00:00Z"))).toBe(false);
  });
  it("quarta 14h SP retorna true", () => {
    // 2026-06-17 e quarta; 14h SP = 17h UTC
    expect(emHorarioOperacao(new Date("2026-06-17T17:00:00Z"))).toBe(true);
  });
  it("quarta 23h SP retorna false (fora do horario)", () => {
    // 23h SP = 02h UTC do dia seguinte (quinta 2026-06-18)
    expect(emHorarioOperacao(new Date("2026-06-18T02:00:00Z"))).toBe(false);
  });
});

describe("detectarParadaLonga", () => {
  it("95min + emOperacao + foraDaBase retorna parada_longa atencao", () => {
    const alerta = detectarParadaLonga({ paradoMin: 95, emOperacao: true, foraDaBase: true });
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.tipo).toBe("parada_longa");
    expect(alerta?.score).toBe(50);
    expect(alerta?.motivo).toContain("1h35min");
  });
  it("95min + emOperacao=false retorna null", () => {
    expect(
      detectarParadaLonga({ paradoMin: 95, emOperacao: false, foraDaBase: true })
    ).toBeNull();
  });
  it("95min + foraDaBase=false retorna null", () => {
    expect(
      detectarParadaLonga({ paradoMin: 95, emOperacao: true, foraDaBase: false })
    ).toBeNull();
  });
  it("paradoMin=90 + emOperacao + foraDaBase aciona (limite >=90)", () => {
    expect(
      detectarParadaLonga({ paradoMin: 90, emOperacao: true, foraDaBase: true })
    ).not.toBeNull();
  });
  it("paradoMin=89 + emOperacao + foraDaBase retorna null", () => {
    expect(
      detectarParadaLonga({ paradoMin: 89, emOperacao: true, foraDaBase: true })
    ).toBeNull();
  });
});

describe("detectarParadaCliente", () => {
  it("no cliente 95min em operacao retorna parada_cliente critico score 72", () => {
    const alerta = detectarParadaCliente({
      paradoMin: 95,
      emOperacao: true,
      noCliente: true,
      ehBenassi: true,
    });
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("parada_cliente");
    expect(alerta?.score).toBe(72);
    expect(alerta?.motivo).toContain("1h35min");
    expect(alerta?.motivo).toContain("acionar motorista");
  });
  it("Benassi no cliente exatamente 90min aciona (limite >=90)", () => {
    expect(
      detectarParadaCliente({ paradoMin: 90, emOperacao: true, noCliente: true, ehBenassi: true })
    ).not.toBeNull();
  });
  it("Benassi no cliente 89min retorna null (abaixo do limite)", () => {
    expect(
      detectarParadaCliente({ paradoMin: 89, emOperacao: true, noCliente: true, ehBenassi: true })
    ).toBeNull();
  });
  it("Benassi FORA do cliente (noCliente false) retorna null", () => {
    expect(
      detectarParadaCliente({ paradoMin: 95, emOperacao: true, noCliente: false, ehBenassi: true })
    ).toBeNull();
  });
  it("Nutry (ehBenassi false) no cliente retorna null", () => {
    expect(
      detectarParadaCliente({ paradoMin: 95, emOperacao: true, noCliente: true, ehBenassi: false })
    ).toBeNull();
  });
  it("fora de operacao retorna null", () => {
    expect(
      detectarParadaCliente({ paradoMin: 95, emOperacao: false, noCliente: true, ehBenassi: true })
    ).toBeNull();
  });
  it("sem campos opcionais (undefined) retorna null", () => {
    expect(
      detectarParadaCliente({ paradoMin: 95, emOperacao: true })
    ).toBeNull();
  });
});

describe("detectarParadaLonga — com campos Benassi", () => {
  it("Benassi no cliente 95min: retorna null (coberto por parada_cliente)", () => {
    expect(
      detectarParadaLonga({ paradoMin: 95, emOperacao: true, foraDaBase: true, noCliente: true, ehBenassi: true })
    ).toBeNull();
  });
  it("Benassi FORA do cliente 95min em operacao fora da base: retorna parada_longa", () => {
    const alerta = detectarParadaLonga({
      paradoMin: 95,
      emOperacao: true,
      foraDaBase: true,
      noCliente: false,
      ehBenassi: true,
    });
    expect(alerta).not.toBeNull();
    expect(alerta?.tipo).toBe("parada_longa");
  });
  it("Nutry (ehBenassi false) no cliente 95min em operacao fora da base: retorna parada_longa", () => {
    const alerta = detectarParadaLonga({
      paradoMin: 95,
      emOperacao: true,
      foraDaBase: true,
      noCliente: true,
      ehBenassi: false,
    });
    expect(alerta).not.toBeNull();
    expect(alerta?.tipo).toBe("parada_longa");
  });
});

describe("avaliar — cenarios parada_cliente Benassi", () => {
  it("Benassi no cliente 95min em operacao retorna parada_cliente", () => {
    const alerta = avaliar(posicaoBase(), {
      paradoMin: 95,
      emOperacao: true,
      foraDaBase: true,
      noCliente: true,
      ehBenassi: true,
    });
    expect(alerta?.tipo).toBe("parada_cliente");
    expect(alerta?.nivel).toBe("atencao");
  });
  it("Benassi fora do cliente 95min em operacao retorna parada_longa (nao parada_cliente)", () => {
    const alerta = avaliar(posicaoBase(), {
      paradoMin: 95,
      emOperacao: true,
      foraDaBase: true,
      noCliente: false,
      ehBenassi: true,
    });
    expect(alerta?.tipo).toBe("parada_longa");
  });
  it("Nutry no cliente 95min em operacao retorna parada_longa (nao parada_cliente)", () => {
    const alerta = avaliar(posicaoBase(), {
      paradoMin: 95,
      emOperacao: true,
      foraDaBase: true,
      noCliente: true,
      ehBenassi: false,
    });
    expect(alerta?.tipo).toBe("parada_longa");
  });
  it("Benassi no cliente 60min retorna null (abaixo do limite)", () => {
    const alerta = avaliar(posicaoBase(), {
      paradoMin: 60,
      emOperacao: true,
      foraDaBase: true,
      noCliente: true,
      ehBenassi: true,
    });
    expect(alerta).toBeNull();
  });
  it("Benassi no cliente fora de operacao retorna null", () => {
    const alerta = avaliar(posicaoBase(), {
      paradoMin: 95,
      emOperacao: false,
      foraDaBase: true,
      noCliente: true,
      ehBenassi: true,
    });
    expect(alerta).toBeNull();
  });
  it("parada_cliente (atencao score 52) perde para panico (critico score 100)", () => {
    const alerta = avaliar(posicaoBase({ panico: true }), {
      paradoMin: 95,
      emOperacao: true,
      foraDaBase: true,
      noCliente: true,
      ehBenassi: true,
    });
    expect(alerta?.tipo).toBe("panico");
  });
  it("parada_cliente (score 52) vence parada_longa (score 50) quando ambos seriam candidatos", () => {
    // Cenario hipotetico: mesmo ctx mas sem flag ehBenassi para isolar os scores.
    // Na pratica quando ehBenassi+noCliente, parada_longa retorna null.
    // Testamos o score via detectarParadaCliente diretamente.
    const pc = detectarParadaCliente({ paradoMin: 95, emOperacao: true, noCliente: true, ehBenassi: true });
    expect(pc?.score).toBeGreaterThan(50);
  });
});

describe("detectarDesvio", () => {
  // base: 6km do alvo, se afastando, rumo OPOSTO (movimento 0=N, alvo 180=S).
  const base = {
    distAlvoM: 6000,
    distAlvoAnteriorM: 5000,
    temPendentes: true,
    emOperacao: true,
    foraDaBase: true,
    rumoMovimento: 0,
    rumoAlvo: 180,
  };
  const emMov = posicaoBase({ velocidade: 40 });

  it("longe (>=5km), afastando, rumo oposto, em movimento → desvio critico", () => {
    const a = detectarDesvio(emMov, base);
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("desvio");
    expect(a?.motivo).toContain("6,0km");
  });
  it("longe mas indo NA DIRECAO do alvo (rumo coincide) nao aciona", () => {
    // movimento 180 = mesmo rumo do alvo (180): dif 0° → indo pro ponto, nao desvio.
    expect(detectarDesvio(emMov, { ...base, rumoMovimento: 180 })).toBeNull();
  });
  it("longe mas SE APROXIMANDO (distancia caindo) nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, distAlvoM: 6000, distAlvoAnteriorM: 8000 })).toBeNull();
  });
  it("DESLOCAMENTO interurbano (>25km) NAO e desvio mesmo afastando+oposto", () => {
    // 116km do ponto: trânsito entre regiões / voltando, não desvio local.
    expect(detectarDesvio(emMov, { ...base, distAlvoM: 116000, distAlvoAnteriorM: 114000 })).toBeNull();
    expect(detectarDesvio(emMov, { ...base, distAlvoM: 30000, distAlvoAnteriorM: 29000 })).toBeNull();
  });
  it("medio-longe (3km), afastando, rumo oposto retorna atencao", () => {
    const a = detectarDesvio(emMov, { ...base, distAlvoM: 3000, distAlvoAnteriorM: 2000 });
    expect(a?.nivel).toBe("atencao");
  });
  it("perto do ponto (1km) nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, distAlvoM: 1000, distAlvoAnteriorM: 1500 })).toBeNull();
  });
  it("parado nao aciona desvio (e parada_longa que cobre)", () => {
    expect(detectarDesvio(posicaoBase({ velocidade: 0 }), base)).toBeNull();
  });
  it("sem rumo de movimento (sem ciclo anterior) nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, rumoMovimento: null })).toBeNull();
  });
  it("sem pendentes nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, temPendentes: false })).toBeNull();
  });
  it("na base nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, foraDaBase: false })).toBeNull();
  });
  it("fora de operacao nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, emOperacao: false })).toBeNull();
  });
  it("distAlvoM null (sem alvos com coordenada) nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, distAlvoM: null })).toBeNull();
  });
  it("primeiro ciclo (distAlvoAnteriorM null) nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, distAlvoM: 7000, distAlvoAnteriorM: null })).toBeNull();
  });
  it("longe e ESTAVEL (mesma distancia) nao aciona", () => {
    expect(detectarDesvio(emMov, { ...base, distAlvoM: 6000, distAlvoAnteriorM: 6050 })).toBeNull();
  });
});

describe("detectarTiroteioProximo", () => {
  const fresco = posicaoBase({ fresco: true });
  it("tiroteio a 500m com posicao fresca retorna critico", () => {
    const a = detectarTiroteioProximo(fresco, { distTiroteioM: 500, tiroteioIdadeMin: 25 });
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("tiroteio");
    expect(a?.score).toBe(88);
    expect(a?.motivo).toContain("500m");
    expect(a?.motivo).toContain("25min");
  });
  it("tiroteio a 800m retorna atencao (faixa 600m-2km)", () => {
    const a = detectarTiroteioProximo(fresco, { distTiroteioM: 800, tiroteioIdadeMin: 25 });
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("tiroteio");
    expect(a?.motivo).toContain("800m");
  });
  it("tiroteio a 2km retorna atencao", () => {
    const a = detectarTiroteioProximo(fresco, { distTiroteioM: 2000, tiroteioIdadeMin: 10 });
    expect(a?.nivel).toBe("atencao");
    expect(a?.score).toBe(60);
    expect(a?.motivo).toContain("2,0km");
  });
  it("tiroteio a 4km nao aciona (longe)", () => {
    expect(detectarTiroteioProximo(fresco, { distTiroteioM: 4000, tiroteioIdadeMin: 5 })).toBeNull();
  });
  it("sem tiroteio ativo (distTiroteioM null) nao aciona", () => {
    expect(detectarTiroteioProximo(fresco, { distTiroteioM: null, tiroteioIdadeMin: null })).toBeNull();
  });
  it("posicao nao fresca nao aciona (sem posicao confiavel)", () => {
    expect(detectarTiroteioProximo(posicaoBase({ fresco: false }), { distTiroteioM: 500, tiroteioIdadeMin: 5 })).toBeNull();
  });
});

describe("foraDeRota (condicao de permanencia do alerta de desvio)", () => {
  const base = { distAlvoM: 6000, temPendentes: true, emOperacao: true, foraDaBase: true };
  const emMov = posicaoBase({ velocidade: 40 });

  it("longe (>=2km), com pendentes, fora da base, em operacao → true (mantem)", () => {
    expect(foraDeRota(emMov, base)).toBe(true);
  });
  it("escalou muito (60km) continua fora de rota (sem teto na permanencia)", () => {
    expect(foraDeRota(emMov, { ...base, distAlvoM: 60000 })).toBe(true);
  });
  it("voltou pra perto do ponto (<2km) → false (resolve)", () => {
    expect(foraDeRota(emMov, { ...base, distAlvoM: 1500 })).toBe(false);
  });
  it("na base → false", () => {
    expect(foraDeRota(emMov, { ...base, foraDaBase: false })).toBe(false);
  });
  it("sem pendentes → false", () => {
    expect(foraDeRota(emMov, { ...base, temPendentes: false })).toBe(false);
  });
  it("fora de operacao → false", () => {
    expect(foraDeRota(emMov, { ...base, emOperacao: false })).toBe(false);
  });
  it("distAlvoM null → false", () => {
    expect(foraDeRota(emMov, { ...base, distAlvoM: null })).toBe(false);
  });
});

// ctx padrao para avaliar: em operacao, fora da base
const ctxOp = { paradoMin: 0, emOperacao: true, foraDaBase: true };

describe("avaliar", () => {
  // Regressao: atraso=101 + ignicao = jammer critico, NAO cinza.
  // Garante que detectarJammer funciona mesmo com fresco=false (atraso > 60).
  it("atraso=101 + ignicao ligada retorna jammer critico (nao cinza)", () => {
    const alerta = avaliar(
      posicaoBase({ ignicao: true, atraso: 101, fresco: false }),
      { ...ctxOp, paradoMin: 0 }
    );
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("jammer");
  });

  it("panico retorna critico", () => {
    const alerta = avaliar(posicaoBase({ panico: true }), ctxOp);
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("panico");
  });
  it("bau retorna critico", () => {
    const alerta = avaliar(posicaoBase({ bau: true }), ctxOp);
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("bau");
  });
  it("jammer (ignicao+atraso=30) retorna critico", () => {
    const alerta = avaliar(posicaoBase({ ignicao: true, atraso: 30 }), ctxOp);
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("jammer");
  });
  it("velocidade=121 retorna excesso atencao", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 121 }), ctxOp);
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.tipo).toBe("excesso");
  });
  it("paradoMin=95 + emOperacao + foraDaBase retorna parada_longa atencao", () => {
    const alerta = avaliar(posicaoBase(), { paradoMin: 95, emOperacao: true, foraDaBase: true });
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.tipo).toBe("parada_longa");
  });
  it("paradoMin=95 + emOperacao=false NAO retorna parada_longa", () => {
    expect(
      avaliar(posicaoBase(), { paradoMin: 95, emOperacao: false, foraDaBase: true })
    ).toBeNull();
  });
  it("posicao limpa + paradoMin=0 retorna null", () => {
    expect(avaliar(posicaoBase(), ctxOp)).toBeNull();
  });
  it("panico tem prioridade sobre excesso de velocidade", () => {
    const alerta = avaliar(posicaoBase({ panico: true, velocidade: 120 }), ctxOp);
    expect(alerta?.tipo).toBe("panico");
  });
  it("panico tem prioridade sobre parada longa", () => {
    const alerta = avaliar(posicaoBase({ panico: true }), { paradoMin: 120, emOperacao: true, foraDaBase: true });
    expect(alerta?.tipo).toBe("panico");
  });
  it("desvio entra na avaliacao quando ha alvos (distAlvoM definido)", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 40 }), {
      ...ctxOp,
      distAlvoM: 6000,
      distAlvoAnteriorM: 5000,
      temPendentes: true,
      rumoMovimento: 0,
      rumoAlvo: 180,
    });
    expect(alerta?.tipo).toBe("desvio");
    expect(alerta?.nivel).toBe("critico");
  });
  it("sem alvos (distAlvoM ausente) NAO avalia desvio", () => {
    // mesmo cenario geografico, mas sem passar distAlvoM → detector nao roda
    expect(avaliar(posicaoBase({ velocidade: 40 }), ctxOp)).toBeNull();
  });
  it("panico tem prioridade sobre desvio", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 40, panico: true }), {
      ...ctxOp,
      distAlvoM: 6000,
      distAlvoAnteriorM: 5000,
      temPendentes: true,
      rumoMovimento: 0,
      rumoAlvo: 180,
    });
    expect(alerta?.tipo).toBe("panico");
  });
});

describe("detectarParadaAnomala — supressao por congestionamento", () => {
  // Cenario base: parada suspeita que DISPARA (cidade, 25min, fora de rota).
  const ctxParada = {
    paradoMin: 25,
    emOperacao: true,
    foraDaBase: true,
    noCliente: false,
    estavEmMovimento: true,
    esMadrugada: false,
    emZonaRisco: false,
    temPOIProximo: false,
    jaParedoNoCicloAnterior: true,
  };

  it("veiculo parado isolado (sem vizinhos) dispara parada_anomala", () => {
    const a = detectarParadaAnomala({ ...ctxParada, vizinhosParados: 0 });
    expect(a).not.toBeNull();
    expect(a?.tipo).toBe("parada_anomala");
  });

  it("2+ veiculos parados na mesma area (transito) NAO dispara", () => {
    const a = detectarParadaAnomala({ ...ctxParada, vizinhosParados: 2 });
    expect(a).toBeNull();
  });

  it("1 vizinho parado por perto ainda dispara (nao e aglomeracao)", () => {
    const a = detectarParadaAnomala({ ...ctxParada, vizinhosParados: 1 });
    expect(a).not.toBeNull();
  });
});

describe("detectarSaidaNaoAutorizada", () => {
  it("fora da base, sem rota, ignicao ligada e EM MOVIMENTO retorna critico", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
    );
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("saida_nao_autorizada");
    expect(a?.score).toBe(80);
  });
  it("fora da base, sem rota, ignicao ligada e PARADO retorna atencao (pode ser recarga)", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 0 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
    );
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("saida_nao_autorizada");
    expect(a?.score).toBe(45);
  });
  it("perto da base (distBaseM 1500m) NAO dispara — saindo/manobrando/abastecendo na base", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0, distBaseM: 1500 }
    );
    expect(a).toBeNull();
  });
  it("longe da base (distBaseM 5000m) em movimento ainda dispara critico", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0, distBaseM: 5000 }
    );
    expect(a?.nivel).toBe("critico");
  });
  it("parado perto de posto/POI NAO dispara — abastecendo/parada legitima", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 0 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0, distBaseM: 5000, temPOIProximo: true }
    );
    expect(a).toBeNull();
  });
  it("dispara 24h: nao depende mais de horario de operacao (movimento de madrugada)", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 50 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
    );
    expect(a?.nivel).toBe("critico");
  });
  it("com pendentes (tem rota) retorna null mesmo em movimento", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 40 }),
        { foraDaBase: true, temPendentes: true, entregasTotal: 0 }
      )
    ).toBeNull();
  });
  it("entregasTotal > 0 (tem/teve entregas no dia) retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 40 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: 5 }
      )
    ).toBeNull();
  });
  it("entregasTotal undefined (API de rota indisponivel) retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 40 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: undefined }
      )
    ).toBeNull();
  });
  it("dentro da base retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 40 }),
        { foraDaBase: false, temPendentes: false, entregasTotal: 0 }
      )
    ).toBeNull();
  });
  it("ignicao desligada retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: false, fresco: true, velocidade: 0 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
      )
    ).toBeNull();
  });
  it("posicao nao fresca retorna null", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: false, velocidade: 40 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
      )
    ).toBeNull();
  });
});
