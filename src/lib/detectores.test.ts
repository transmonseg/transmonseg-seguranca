// Testes unitarios do motor de deteccao (Vitest).
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
  distanciaAumentou,
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
    evento: null,
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
  it("ignicao ligada e atraso=60 retorna jammer critico", () => {
    const alerta = detectarJammer(posicaoBase({ ignicao: true, atraso: 60 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("jammer");
    expect(alerta?.score).toBe(80);
  });
  it("atraso no limite inferior (30) aciona jammer em nivel atencao", () => {
    const alerta = detectarJammer(posicaoBase({ ignicao: true, atraso: 30 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("atencao");
    expect(alerta?.score).toBe(55);
  });
  it("atraso abaixo da janela (15) nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 15 }))).toBeNull();
  });
  it("atraso no limite superior (180) aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 180 }))).not.toBeNull();
  });
  it("atraso acima do teto (181) nao aciona jammer (sinal perdido ha tempo demais)", () => {
    expect(detectarJammer(posicaoBase({ ignicao: true, atraso: 181 }))).toBeNull();
  });
  it("ignicao desligada nao aciona jammer", () => {
    expect(detectarJammer(posicaoBase({ ignicao: false, atraso: 30 }))).toBeNull();
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
describe("emHorarioOperacao", () => {
  it("sabado retorna false", () => {
    expect(emHorarioOperacao(new Date("2026-06-20T13:00:00Z"))).toBe(false);
  });
  it("quarta 14h SP retorna true", () => {
    expect(emHorarioOperacao(new Date("2026-06-17T17:00:00Z"))).toBe(true);
  });
  it("quarta 23h SP retorna false (fora do horario)", () => {
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
    expect(detectarParadaLonga({ paradoMin: 95, emOperacao: false, foraDaBase: true })).toBeNull();
  });
  it("95min + foraDaBase=false retorna null", () => {
    expect(detectarParadaLonga({ paradoMin: 95, emOperacao: true, foraDaBase: false })).toBeNull();
  });
  it("paradoMin=90 + emOperacao + foraDaBase aciona (limite >=90)", () => {
    expect(detectarParadaLonga({ paradoMin: 90, emOperacao: true, foraDaBase: true })).not.toBeNull();
  });
  it("paradoMin=89 + emOperacao + foraDaBase retorna null", () => {
    expect(detectarParadaLonga({ paradoMin: 89, emOperacao: true, foraDaBase: true })).toBeNull();
  });
  it("noCliente retorna null (coberto por parada_cliente)", () => {
    expect(detectarParadaLonga({ paradoMin: 95, emOperacao: true, foraDaBase: true, noCliente: true })).toBeNull();
  });
  it("em POI proximo suprime parada_longa", () => {
    expect(detectarParadaLonga({ paradoMin: 95, emOperacao: true, foraDaBase: true, temPOIProximo: true })).toBeNull();
  });
  it("rota concluida suprime parada_longa (coberto por retorno_tardio)", () => {
    expect(detectarParadaLonga({ paradoMin: 95, emOperacao: true, foraDaBase: true, entregasFeitas: 5, entregasTotal: 5 })).toBeNull();
  });
});

describe("detectarParadaCliente", () => {
  it("no cliente 95min em operacao retorna parada_cliente critico score 72", () => {
    const alerta = detectarParadaCliente({ paradoMin: 95, emOperacao: true, noCliente: true });
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("parada_cliente");
    expect(alerta?.score).toBe(72);
    expect(alerta?.motivo).toContain("1h35min");
    expect(alerta?.motivo).toContain("acionar motorista");
  });
  it("no cliente exatamente 90min aciona (limite >=90)", () => {
    expect(detectarParadaCliente({ paradoMin: 90, emOperacao: true, noCliente: true })).not.toBeNull();
  });
  it("no cliente 89min retorna null (abaixo do limite)", () => {
    expect(detectarParadaCliente({ paradoMin: 89, emOperacao: true, noCliente: true })).toBeNull();
  });
  it("fora do cliente (noCliente false) retorna null", () => {
    expect(detectarParadaCliente({ paradoMin: 95, emOperacao: true, noCliente: false })).toBeNull();
  });
  it("fora de operacao retorna null", () => {
    expect(detectarParadaCliente({ paradoMin: 95, emOperacao: false, noCliente: true })).toBeNull();
  });
  it("sem noCliente (undefined) retorna null", () => {
    expect(detectarParadaCliente({ paradoMin: 95, emOperacao: true })).toBeNull();
  });
});

describe("avaliar - cenarios parada_cliente", () => {
  it("no cliente 95min em operacao retorna parada_cliente critico", () => {
    const alerta = avaliar(posicaoBase(), { paradoMin: 95, emOperacao: true, foraDaBase: true, noCliente: true });
    expect(alerta?.tipo).toBe("parada_cliente");
    expect(alerta?.nivel).toBe("critico");
  });
  it("fora do cliente 95min em operacao retorna parada_longa", () => {
    const alerta = avaliar(posicaoBase(), { paradoMin: 95, emOperacao: true, foraDaBase: true, noCliente: false });
    expect(alerta?.tipo).toBe("parada_longa");
  });
  it("no cliente 60min retorna null (abaixo do limite)", () => {
    expect(avaliar(posicaoBase(), { paradoMin: 60, emOperacao: true, foraDaBase: true, noCliente: true })).toBeNull();
  });
  it("no cliente fora de operacao retorna null", () => {
    expect(avaliar(posicaoBase(), { paradoMin: 95, emOperacao: false, foraDaBase: true, noCliente: true })).toBeNull();
  });
  it("parada_cliente perde para panico (critico score 100)", () => {
    const alerta = avaliar(posicaoBase({ panico: true }), { paradoMin: 95, emOperacao: true, foraDaBase: true, noCliente: true });
    expect(alerta?.tipo).toBe("panico");
  });
  it("parada_cliente score (72) maior que parada_longa (50)", () => {
    const pc = detectarParadaCliente({ paradoMin: 95, emOperacao: true, noCliente: true });
    expect(pc?.score).toBeGreaterThan(50);
  });
});

describe("detectarDesvio (v3: afastamento do destino mais proximo, rapido e sem piso)", () => {
  const base = {
    menorDistDestinoM: 6000,
    temPendentes: true,
    emOperacao: true,
    foraDaBase: true,
    entregasFeitas: 2,
    streak: 2,
    afastamentoAcumuladoM: 300,
    dentroTapete: null as boolean | null,
  };
  const emMov = posicaoBase({ velocidade: 40 });

  it("streak 2 dentro de via conhecida: atencao (dispara rapido, sem piso de distancia acumulada)", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: true });
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("desvio");
  });

  it("streak 2 fora do tapete: critico direto (via que a frota nunca percorreu)", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: false });
    expect(a?.nivel).toBe("critico");
  });

  it("streak 4 escala pra critico mesmo dentro do tapete (persistencia longa)", () => {
    const a = detectarDesvio(emMov, { ...base, streak: 4, dentroTapete: true });
    expect(a?.nivel).toBe("critico");
  });

  it("desvio pequeno (afastamento acumulado de so 300m) ja dispara atencao", () => {
    const a = detectarDesvio(emMov, { ...base, afastamentoAcumuladoM: 300 });
    expect(a).not.toBeNull();
  });

  it("streak 1 nao dispara (persistencia minima 2 ciclos, ~2min)", () => {
    expect(detectarDesvio(emMov, { ...base, streak: 1 })).toBeNull();
  });

  it("parado nao dispara", () => {
    expect(detectarDesvio(posicaoBase({ velocidade: 0 }), base)).toBeNull();
  });

  it("indo para a primeira entrega (0 feitas com pendentes) nao dispara", () => {
    expect(detectarDesvio(emMov, { ...base, entregasFeitas: 0 })).toBeNull();
  });

  it("perto do destino (nao afastando) tambem pode disparar — quem decide e o streak, nao a distancia absoluta", () => {
    // menorDistDestinoM pequeno (300m) mas ainda dentro do teto: o piso de
    // distancia absoluta foi removido de proposito (desvio de 500m ja e grave).
    const a = detectarDesvio(emMov, { ...base, menorDistDestinoM: 300 });
    expect(a).not.toBeNull();
  });

  it("acima do teto de deslocamento interurbano (25km) nao dispara", () => {
    expect(detectarDesvio(emMov, { ...base, menorDistDestinoM: 30000 })).toBeNull();
  });

  it("sem destino valido (menorDistDestinoM null) nao dispara", () => {
    expect(detectarDesvio(emMov, { ...base, menorDistDestinoM: null })).toBeNull();
  });

  it("0 pendentes (fim de rota): unico destino e a base, mesma regra unificada", () => {
    const a = detectarDesvio(emMov, { ...base, temPendentes: false, streak: 2 });
    expect(a?.nivel).toBe("atencao");
  });

  it("fora de operacao ou dentro da base nao dispara", () => {
    expect(detectarDesvio(emMov, { ...base, emOperacao: false })).toBeNull();
    expect(detectarDesvio(emMov, { ...base, foraDaBase: false })).toBeNull();
  });
});

describe("distanciaAumentou", () => {
  it("true quando a distancia cresce alem da margem de 50m", () => {
    expect(distanciaAumentou(6000, 5000)).toBe(true);
  });
  it("false quando a distancia caiu (aproximando)", () => {
    expect(distanciaAumentou(6000, 6900)).toBe(false);
  });
  it("false quando o crescimento fica dentro da margem de ruido de GPS", () => {
    expect(distanciaAumentou(5030, 5000)).toBe(false);
  });
  it("false com valores nulos (sem ciclo anterior ou sem destino)", () => {
    expect(distanciaAumentou(null, 5000)).toBe(false);
    expect(distanciaAumentou(5000, null)).toBe(false);
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
    expect(a?.score).toBe(50);
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

describe("foraDeRota (v2: menor distancia a qualquer destino)", () => {
  const p = posicaoBase();
  it("mantem alerta enquanto longe de todos os destinos", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 3000, emOperacao: true, foraDaBase: true })).toBe(true);
  });
  it("resolve quando volta a menos de 2,5km de algum destino", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 1000, emOperacao: true, foraDaBase: true })).toBe(false);
  });
  it("resolve dentro da base ou fora de operacao", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 9000, emOperacao: true, foraDaBase: false })).toBe(false);
    expect(foraDeRota(p, { menorDistDestinoM: 9000, emOperacao: false, foraDaBase: true })).toBe(false);
  });
});

// ctx padrao para avaliar: em operacao, fora da base
const ctxOp = { paradoMin: 0, emOperacao: true, foraDaBase: true };

describe("avaliar", () => {
  it("atraso=101 + ignicao ligada retorna jammer critico", () => {
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
  it("jammer (ignicao+atraso=60) retorna critico", () => {
    const alerta = avaliar(posicaoBase({ ignicao: true, atraso: 60 }), ctxOp);
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
    expect(avaliar(posicaoBase(), { paradoMin: 95, emOperacao: false, foraDaBase: true })).toBeNull();
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
  it("desvio entra na avaliacao quando ha destino (menorDistDestinoM definido)", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 40 }), {
      ...ctxOp,
      menorDistDestinoM: 6000,
      temPendentes: true,
      entregasFeitas: 3,
      desvioStreak: 4,
      afastamentoAcumuladoM: 1600,
    });
    expect(alerta?.tipo).toBe("desvio");
    expect(alerta?.nivel).toBe("critico");
  });
  it("sem destino (menorDistDestinoM ausente) NAO avalia desvio", () => {
    expect(avaliar(posicaoBase({ velocidade: 40 }), ctxOp)).toBeNull();
  });
  it("panico tem prioridade sobre desvio", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 40, panico: true }), {
      ...ctxOp,
      menorDistDestinoM: 6000,
      temPendentes: true,
      entregasFeitas: 3,
      desvioStreak: 4,
      afastamentoAcumuladoM: 1600,
    });
    expect(alerta?.tipo).toBe("panico");
  });
});

describe("detectarParadaAnomala - supressao por congestionamento", () => {
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
    expect(detectarParadaAnomala({ ...ctxParada, vizinhosParados: 2 })).toBeNull();
  });
  it("1 vizinho parado por perto ainda dispara (nao e aglomeracao)", () => {
    expect(detectarParadaAnomala({ ...ctxParada, vizinhosParados: 1 })).not.toBeNull();
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
  it("fora da base, sem rota, ignicao ligada e PARADO retorna atencao", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 0 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
    );
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("saida_nao_autorizada");
    expect(a?.score).toBe(45);
  });
  it("tem pendentes: nao aciona (esta trabalhando)", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: true, entregasTotal: 5 }
      )
    ).toBeNull();
  });
  it("entregasTotal undefined: nao aciona (API indisponivel)", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: false }
      )
    ).toBeNull();
  });
  it("entregasTotal > 0: nao aciona (trabalhou no dia)", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: 3 }
      )
    ).toBeNull();
  });
  it("na base: nao aciona", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: false, temPendentes: false, entregasTotal: 0 }
      )
    ).toBeNull();
  });
  it("ignicao desligada: nao aciona", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: false, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
      )
    ).toBeNull();
  });
});
