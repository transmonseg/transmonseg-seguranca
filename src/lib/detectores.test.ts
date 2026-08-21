// Testes unitarios do motor de deteccao (Vitest).
import { describe, it, expect } from "vitest";
import type { Baseline } from "./baseline-veiculo";
import {
  detectarPanico,
  detectarBau,
  detectarJammer,
  detectarExcessoVelocidade,
  detectarParadaCliente,
  detectarParadaLonga,
  detectarParadaAnomala,
  detectarParadaForaTapete,
  PARADA_FORA_TAPETE_MIN,
  calcularRiscoArea,
  RISCO_AREA_LIMIAR,
  detectarTiroteioProximo,
  detectarSaidaNaoAutorizada,
  avaliar,
  montarCandidatosCore,
  formataDuracao,
  emHorarioOperacao,
  detectarBypassEntrega,
  detectarParadaSemMarcacao,
  type CtxParadaSemMarcacao,
  PARADA_SEM_MARCACAO_DWELL_MINIMO_SEGUNDOS,
  type CtxBypassEntrega,
  detectarAnomaliaBaseline,
  arbitrarCandidatos,
  reduzirPorTransitoInferido,
  TIPOS_NAO_GERENCIADOS,
  temCoordenadaValida,
  contaComoEventoDeSilenciamento,
  contaComoRotuloHumano,
  formatarProgressoDestino,
  formatarPlacarSombra,
  formatarConfiabilidadeDetector,
  elegivelParaAcaoMassa,
  IDADE_MINIMA_ACAO_MASSA_MIN,
  type Alerta,
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
  // velocidade:40 (em movimento quando o sinal caiu) pros testes "base", pra
  // isolar do novo modificador de "parado quando o sinal caiu" (testado a parte).
  it("ignicao ligada e atraso=60 retorna jammer critico", () => {
    const alerta = detectarJammer(posicaoBase({ ignicao: true, atraso: 60, velocidade: 40 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("jammer");
    expect(alerta?.score).toBe(80);
  });
  it("atraso no limite inferior (30) aciona jammer (nivel atencao eliminado, tudo critico)", () => {
    const alerta = detectarJammer(posicaoBase({ ignicao: true, atraso: 30, velocidade: 40 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
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

  // Achado da pesquisa 07/07: jammer coincidindo com o veiculo PARADO no
  // momento em que o sinal caiu e sinal mais forte (~85% dos roubos de carga
  // documentados no Mexico envolveram jammer) — score mais alto, motivo mais
  // especifico pro operador priorizar.
  describe("modificador: parado quando o sinal caiu (velocidade=0 na ultima leitura)", () => {
    it("jammer critico (60min) com veiculo parado: score 90 (vs 80 em movimento)", () => {
      const parado = detectarJammer(posicaoBase({ ignicao: true, atraso: 60, velocidade: 0 }));
      const movimento = detectarJammer(posicaoBase({ ignicao: true, atraso: 60, velocidade: 40 }));
      expect(parado?.score).toBe(90);
      expect(movimento?.score).toBe(80);
      expect(parado?.motivo).toContain("PARADO quando o sinal caiu");
    });
    it("jammer inicial (30min) com veiculo parado: score 65 (vs 55 em movimento)", () => {
      const parado = detectarJammer(posicaoBase({ ignicao: true, atraso: 30, velocidade: 0 }));
      const movimento = detectarJammer(posicaoBase({ ignicao: true, atraso: 30, velocidade: 40 }));
      expect(parado?.score).toBe(65);
      expect(movimento?.score).toBe(55);
    });
  });
});

describe("detectarExcessoVelocidade", () => {
  it("velocidade=121 retorna excesso critico", () => {
    const alerta = detectarExcessoVelocidade(posicaoBase({ velocidade: 121 }));
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
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
  it("95min + emOperacao + foraDaBase retorna parada_longa critico", () => {
    const alerta = detectarParadaLonga({ paradoMin: 95, emOperacao: true, foraDaBase: true });
    expect(alerta).not.toBeNull();
    expect(alerta?.nivel).toBe("critico");
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

describe("calcularRiscoArea", () => {
  it("sem nenhum sinal de risco: score 0 (mesmo com fator horario alto)", () => {
    expect(calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: false, fatorHorario: 1.6,
    })).toBe(0);
  });

  it("dentro de favela sozinho ja atinge o limiar de escalonamento (fator horario neutro)", () => {
    const score = calcularRiscoArea({
      emFavela: true, tiroteioRecentePertoM: null, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: false, fatorHorario: 1,
    });
    expect(score).toBeGreaterThanOrEqual(RISCO_AREA_LIMIAR);
  });

  it("tiroteio recente proximo (<=1500m) sozinho ja atinge o limiar", () => {
    const score = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: 800, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: false, fatorHorario: 1,
    });
    expect(score).toBeGreaterThanOrEqual(RISCO_AREA_LIMIAR);
  });

  it("tiroteio longe demais (>1500m) nao conta", () => {
    const score = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: 5000, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: false, fatorHorario: 1,
    });
    expect(score).toBe(0);
  });

  it("roubo de carga alto no CISP (>=15 em 12 meses) soma mais que medio", () => {
    const alto = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 20,
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: false, fatorHorario: 1,
    });
    const medio = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 3,
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: false, fatorHorario: 1,
    });
    expect(alto).toBeGreaterThan(medio);
    expect(medio).toBeGreaterThan(0);
  });

  it("fator horario e MULTIPLICATIVO: amplifica proporcionalmente um sinal espacial ja existente", () => {
    const base = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 3, // medio = 10
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: false, fatorHorario: 1,
    });
    const amplificado = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 3,
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: false, fatorHorario: 1.6,
    });
    expect(base).toBe(10);
    expect(amplificado).toBe(16); // 10 * 1.6, nao 10 + bonus fixo
  });

  it("combinacao de sinais fracos pode somar acima do limiar", () => {
    const score = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 20,
      emCorredorRodoviaRisco: true, emAreaRiscoCliente: false, fatorHorario: 1,
    });
    expect(score).toBeGreaterThanOrEqual(RISCO_AREA_LIMIAR);
  });

  it("nunca passa de 100 mesmo com todos os sinais ativos e fator horario maximo", () => {
    const score = calcularRiscoArea({
      emFavela: true, tiroteioRecentePertoM: 100, rouboCargaCispTotal: 999,
      emCorredorRodoviaRisco: true, emAreaRiscoCliente: false, fatorHorario: 1.6,
    });
    expect(score).toBeLessThanOrEqual(100);
  });

  it("dentro de area de risco cadastrada pelo cliente sozinho ja atinge o limiar (ex.: Caixotaria do Ceasa)", () => {
    const score = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, emAreaRiscoCliente: true, fatorHorario: 1,
    });
    expect(score).toBeGreaterThanOrEqual(RISCO_AREA_LIMIAR);
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
  it("tiroteio a 800m retorna critico (faixa 600m-2km)", () => {
    const a = detectarTiroteioProximo(fresco, { distTiroteioM: 800, tiroteioIdadeMin: 25 });
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("tiroteio");
    expect(a?.motivo).toContain("800m");
  });
  it("tiroteio a 2km retorna critico", () => {
    const a = detectarTiroteioProximo(fresco, { distTiroteioM: 2000, tiroteioIdadeMin: 10 });
    expect(a?.nivel).toBe("critico");
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
  it("velocidade=121 retorna excesso critico", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 121 }), ctxOp);
    expect(alerta?.nivel).toBe("critico");
    expect(alerta?.tipo).toBe("excesso");
  });
  it("paradoMin=95 + emOperacao + foraDaBase retorna parada_longa critico", () => {
    const alerta = avaliar(posicaoBase(), { paradoMin: 95, emOperacao: true, foraDaBase: true });
    expect(alerta?.nivel).toBe("critico");
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
});

describe("montarCandidatosCore (candidatos crus, sem arbitrar -- extraido no fix do bug 12/07)", () => {
  it("avaliar() e equivalente a arbitrarCandidatos(montarCandidatosCore(...)) -- mesmo resultado", () => {
    const ctx = { ...ctxOp, temPendentes: true, entregasFeitas: 3 };
    const p = posicaoBase({ velocidade: 40 });
    expect(avaliar(p, ctx)).toEqual(arbitrarCandidatos(montarCandidatosCore(p, ctx)));
  });

  it("parado fora do tapete (Fix 1, 27/07; tipo proprio desde a revisao adversarial): aparece como candidato tipo='parada_fora_tapete', e avaliar() o retorna", () => {
    const ctx = {
      ...ctxOp,
      paradoMin: PARADA_FORA_TAPETE_MIN,
      dentroTapete: false,
    };
    const p = posicaoBase({ velocidade: 0 });
    const candidatos = montarCandidatosCore(p, ctx);
    const candidato = candidatos.find((c) => c.tipo === "parada_fora_tapete");
    expect(candidato).toBeDefined();
    expect(candidato?.origemDesvio).toBeUndefined();
    expect(avaliar(p, ctx)?.tipo).toBe("parada_fora_tapete");
  });

  it("parado fora do tapete NUNCA aparece com tipo='desvio' (revisao adversarial 27/07, caso TTK-4D14): tipo proprio evita colisao de vaga com desvio comportamental real", () => {
    const ctx = {
      ...ctxOp,
      paradoMin: PARADA_FORA_TAPETE_MIN,
      dentroTapete: false,
    };
    const p = posicaoBase({ velocidade: 0 });
    const candidatos = montarCandidatosCore(p, ctx);
    expect(candidatos.some((c) => c.tipo === "desvio")).toBe(false);
  });
});

describe("TIPOS_NAO_GERENCIADOS (achado real 27/07, revisao adversarial, caso TTK-4D14)", () => {
  // route.ts usa este set pra decidir quais tipos ficam de fora do
  // auto-resolve generico (alertasGerenciados) -- ver comentario completo
  // em detectores.ts. desvio/favela/bypass_entrega NUNCA fecham sozinhos
  // (so acao manual do operador ou o cron de 7 dias); todo o resto
  // (incluindo parada_anomala e, agora, parada_fora_tapete) fecha sozinho
  // quando a condicao que disparou deixa de valer.
  it("desvio, favela e bypass_entrega continuam de fora do auto-resolve", () => {
    expect(TIPOS_NAO_GERENCIADOS.has("desvio")).toBe(true);
    expect(TIPOS_NAO_GERENCIADOS.has("favela")).toBe(true);
    expect(TIPOS_NAO_GERENCIADOS.has("bypass_entrega")).toBe(true);
  });

  it("parada_fora_tapete participa do auto-resolve generico, igual a parada_anomala (nao fica na lista)", () => {
    expect(TIPOS_NAO_GERENCIADOS.has("parada_fora_tapete")).toBe(false);
    expect(TIPOS_NAO_GERENCIADOS.has("parada_anomala")).toBe(false);
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

describe("detectarParadaAnomala - limiares baixados 12/07 (menos conservador)", () => {
  const base = {
    emOperacao: true,
    foraDaBase: true,
    noCliente: false,
    esMadrugada: false,
    emZonaRisco: false,
    temPOIProximo: false,
    jaParedoNoCicloAnterior: true,
    vizinhosParados: 0,
  };

  // Historico: 12/25min ja foram tentados e revertidos pra 20/35 porque
  // disparavam pra praticamente qualquer parada em transito pesado do RJ
  // (ver comentario em detectores.ts). O novo valor (12/20) fica no limite
  // do que ja foi tentado pra cidade e um meio-termo pra estrada -- mais
  // conservador que repetir exatamente o par que ja falhou (12/25).
  it("cidade, 15min parado (entre o novo 12 e o antigo 20): dispara agora", () => {
    const a = detectarParadaAnomala({ ...base, paradoMin: 15, estavEmMovimento: true });
    expect(a).not.toBeNull();
  });

  it("cidade, 10min parado (abaixo do novo minimo): ainda nao dispara", () => {
    expect(detectarParadaAnomala({ ...base, paradoMin: 10, estavEmMovimento: true })).toBeNull();
  });

  it("estrada, 22min parado (entre o novo 20 e o antigo 35): dispara agora", () => {
    const a = detectarParadaAnomala({ ...base, paradoMin: 22, estavEmMovimento: false });
    expect(a).not.toBeNull();
  });

  it("estrada, 18min parado (abaixo do novo minimo): ainda nao dispara", () => {
    expect(detectarParadaAnomala({ ...base, paradoMin: 18, estavEmMovimento: false })).toBeNull();
  });
});

describe("detectarSaidaNaoAutorizada", () => {
  // Achado real 09/08: detector desligado em producao (SAIDA_NAO_AUTORIZADA_ATIVO
  // = false, ver comentario em detectores.ts) -- `ativo: true` nos testes
  // abaixo usa o override pra continuar exercitando a logica real, mesmo
  // padrao ja usado por DESVIO_SO_AFASTANDO_OU_FORA_DO_TAPETE.
  it("fora da base, sem rota, ignicao ligada e EM MOVIMENTO retorna critico", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0, ativo: true }
    );
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("saida_nao_autorizada");
    expect(a?.score).toBe(80);
  });
  it("fora da base, sem rota, ignicao ligada e PARADO retorna critico", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 0 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0, ativo: true }
    );
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("saida_nao_autorizada");
    expect(a?.score).toBe(45);
  });
  it("tem pendentes: nao aciona (esta trabalhando)", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: true, entregasTotal: 5, ativo: true }
      )
    ).toBeNull();
  });
  it("entregasTotal undefined: nao aciona (API indisponivel)", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: false, ativo: true }
      )
    ).toBeNull();
  });
  it("entregasTotal > 0: nao aciona (trabalhou no dia)", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: 3, ativo: true }
      )
    ).toBeNull();
  });
  it("na base: nao aciona", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: false, temPendentes: false, entregasTotal: 0, ativo: true }
      )
    ).toBeNull();
  });
  it("ignicao desligada: nao aciona", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: false, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: 0, ativo: true }
      )
    ).toBeNull();
  });
  it("flag desligada (producao, sem override): nunca aciona mesmo em condicao que dispararia", () => {
    expect(
      detectarSaidaNaoAutorizada(
        posicaoBase({ ignicao: true, fresco: true, velocidade: 35 }),
        { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
      )
    ).toBeNull();
  });
});

describe("detectarBypassEntrega (achado do audio do cliente 11/07: chegou na porta e nao parou)", () => {
  const base: CtxBypassEntrega = {
    saiuDoRaioAgora: true,
    mesmoAlvoCodigo: true,
    dwellSegundosAcumulados: 20,
    entregaConfirmada: false,
  };

  it("saiu do raio sem dwell suficiente e sem confirmar entrega: dispara atencao", () => {
    const a = detectarBypassEntrega(base);
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("bypass_entrega");
    expect(a?.motivo).toContain("sem confirmar");
  });

  it("dwell suficiente (>=120s): nao dispara, ficou tempo bastante", () => {
    expect(detectarBypassEntrega({ ...base, dwellSegundosAcumulados: 120 })).toBeNull();
  });

  it("entrega confirmada pela Unitrac: nao dispara mesmo com dwell baixo", () => {
    expect(detectarBypassEntrega({ ...base, entregaConfirmada: true })).toBeNull();
  });

  it("nao saiu do raio agora (ainda dentro): nao dispara", () => {
    expect(detectarBypassEntrega({ ...base, saiuDoRaioAgora: false })).toBeNull();
  });

  it("trocou de alvo (nao e o mesmo raio que entrou): nao dispara", () => {
    expect(detectarBypassEntrega({ ...base, mesmoAlvoCodigo: false })).toBeNull();
  });
});

describe("detectarParadaSemMarcacao (achado real 28/07, cliente Nutry Max, caso TTM-7C13: parou 9min perto de cliente real mas fora do raio registrado, nenhum alerta disparou; redesenhado apos revisao independente BLOCK -- sinal de TRANSICAO na saida, mesmo padrao de detectarBypassEntrega, nao mais 'enquanto parado')", () => {
  const base: CtxParadaSemMarcacao = {
    saiuDaFaixaAgora: true,
    mesmoAlvoCodigo: true,
    dwellSegundosAcumulados: PARADA_SEM_MARCACAO_DWELL_MINIMO_SEGUNDOS + 30,
    entregaConfirmada: false,
  };

  it("saiu da faixa com dwell suficiente e sem confirmar entrega: dispara critico (achado real 20/08 -- ver spec reduzir-ruido, este tipo agora conta como possivel desvio)", () => {
    const a = detectarParadaSemMarcacao(base);
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("parada_sem_marcacao");
    expect(a?.motivo).toContain("sem confirmar");
  });

  it("nao saiu da faixa agora (ainda nela): nao dispara -- achado CRITICO da revisao, nunca dispara enquanto ainda parado (evita disparar em entrega normal em andamento)", () => {
    expect(detectarParadaSemMarcacao({ ...base, saiuDaFaixaAgora: false })).toBeNull();
  });

  it("trocou de alvo (nao e o mesmo ponto que entrou na faixa): nao dispara", () => {
    expect(detectarParadaSemMarcacao({ ...base, mesmoAlvoCodigo: false })).toBeNull();
  });

  it("entrega confirmada pela Unitrac antes de sair: nao dispara mesmo com dwell alto", () => {
    expect(detectarParadaSemMarcacao({ ...base, entregaConfirmada: true })).toBeNull();
  });

  it("dwell insuficiente (< PARADA_SEM_MARCACAO_DWELL_MINIMO_SEGUNDOS): nao dispara -- so passou perto, nao ficou tempo suficiente pra ser tentativa de entrega", () => {
    expect(
      detectarParadaSemMarcacao({ ...base, dwellSegundosAcumulados: PARADA_SEM_MARCACAO_DWELL_MINIMO_SEGUNDOS - 30 })
    ).toBeNull();
  });

  it("no limite exato do dwell minimo (>=): ja dispara -- so abaixo do limiar que nao dispara", () => {
    expect(
      detectarParadaSemMarcacao({ ...base, dwellSegundosAcumulados: PARADA_SEM_MARCACAO_DWELL_MINIMO_SEGUNDOS })
    ).not.toBeNull();
  });

  it("caso real TTM-7C13 (28/07): 9min continuos parado perto de cliente fora do raio, saiu sem confirmar -- dispara", () => {
    const a = detectarParadaSemMarcacao({
      saiuDaFaixaAgora: true,
      mesmoAlvoCodigo: true,
      dwellSegundosAcumulados: 9 * 60,
      entregaConfirmada: false,
    });
    expect(a).not.toBeNull();
    expect(a?.tipo).toBe("parada_sem_marcacao");
  });
});

describe("detectarAnomaliaBaseline (baseline comportamental por veiculo)", () => {
  const baselineProprioEstavel: Baseline = { n: 50, media: 40, variancia: 100 };
  const baselineFrota: Baseline = { n: 500, media: 45, variancia: 121 };

  it("dentro do padrao do proprio veiculo (menos de 3 desvios): nao dispara", () => {
    const a = detectarAnomaliaBaseline({
      velocidadeMediaViagemKmh: 50,
      baselineProprio: baselineProprioEstavel,
      baselineFrota,
      minAmostrasProprio: 20,
    });
    expect(a).toBeNull();
  });

  it("mais de 3 desvios do proprio veiculo: dispara atencao", () => {
    const a = detectarAnomaliaBaseline({
      velocidadeMediaViagemKmh: 80,
      baselineProprio: baselineProprioEstavel,
      baselineFrota,
      minAmostrasProprio: 20,
    });
    expect(a?.nivel).toBe("atencao");
    expect(a?.tipo).toBe("baseline_veiculo");
  });

  it("veiculo em cold start (poucas amostras proprias): usa baseline da frota", () => {
    const a = detectarAnomaliaBaseline({
      velocidadeMediaViagemKmh: 80,
      baselineProprio: { n: 3, media: 40, variancia: 100 },
      baselineFrota,
      minAmostrasProprio: 20,
    });
    expect(a).not.toBeNull();
  });

  it("sem baseline nenhum ainda confiavel (nem proprio nem frota): nao dispara", () => {
    const a = detectarAnomaliaBaseline({
      velocidadeMediaViagemKmh: 80,
      baselineProprio: { n: 0, media: 0, variancia: 0 },
      baselineFrota: { n: 0, media: 0, variancia: 0 },
      minAmostrasProprio: 20,
    });
    expect(a).toBeNull();
  });
});

describe("arbitrarCandidatos (fusao de sinais corroborantes, 12/07)", () => {
  const alertaBase = (tipo: string, score: number, nivel: "critico" | "atencao" = "critico"): Alerta => ({
    nivel, tipo, motivo: `motivo de ${tipo}`, score,
  });

  it("1 candidato so: retorna ele sem alteracao", () => {
    const a = arbitrarCandidatos([alertaBase("jammer", 80)]);
    expect(a?.score).toBe(80);
    expect(a?.motivo).toBe("motivo de jammer");
  });

  it("lista vazia: retorna null", () => {
    expect(arbitrarCandidatos([])).toBeNull();
  });

  it("2 candidatos SEM corroboracao relevante (retorno_tardio + parada_longa): maior score vence, sem bonus", () => {
    const a = arbitrarCandidatos([alertaBase("retorno_tardio", 40), alertaBase("parada_longa", 50)]);
    expect(a?.score).toBe(50);
    expect(a?.motivo).toBe("motivo de parada_longa");
  });

  it("2 candidatos DO conjunto relevante (jammer + desvio): corrobora, soma +15, enriquece motivo", () => {
    const a = arbitrarCandidatos([alertaBase("jammer", 80), alertaBase("desvio", 45)]);
    expect(a?.score).toBe(95); // 80 + 15
    expect(a?.motivo).toContain("motivo de jammer");
    expect(a?.motivo).toContain("corroborado por");
    expect(a?.motivo).toContain("desvio");
  });

  it("3 candidatos do conjunto relevante (jammer + desvio + baseline_veiculo): bonus dobrado (+30)", () => {
    const a = arbitrarCandidatos([alertaBase("jammer", 60), alertaBase("desvio", 45), alertaBase("baseline_veiculo", 35, "atencao")]);
    expect(a?.score).toBe(90); // 60 + 30
  });

  it("score nunca passa de 100 mesmo com muitos sinais corroborando", () => {
    const a = arbitrarCandidatos([
      alertaBase("jammer", 90), alertaBase("desvio", 80),
      alertaBase("bypass_entrega", 40, "atencao"), alertaBase("baseline_veiculo", 35, "atencao"),
    ]);
    expect(a?.score).toBe(100);
  });

  it("desvio de duas fontes (desvio + cerca, ambos tipo=desvio) conta como 1 tipo so, nao corrobora sozinho", () => {
    const a = arbitrarCandidatos([alertaBase("desvio", 45), alertaBase("desvio", 75)]);
    expect(a?.score).toBe(75); // maior dos dois, SEM bonus (mesmo tipo, nao e corroboracao)
    expect(a?.motivo).not.toContain("corroborado");
  });

  it("desvio (2 fontes, mesmo tipo) + jammer: corrobora normalmente contando desvio como 1 tipo", () => {
    const a = arbitrarCandidatos([alertaBase("desvio", 45), alertaBase("desvio", 75), alertaBase("jammer", 60)]);
    expect(a?.score).toBe(90); // 75 (maior) + 15 (1 bonus, desvio conta 1 vez so)
  });

  it("critico sempre vence atencao, independente de score", () => {
    const a = arbitrarCandidatos([alertaBase("baseline_veiculo", 90, "atencao"), alertaBase("retorno_tardio", 20, "critico")]);
    expect(a?.tipo).toBe("retorno_tardio");
  });

  it("extras operacionais (retorno_tardio, parada_noturna, aceleracao) nao contam pro bonus de corroboracao", () => {
    const a = arbitrarCandidatos([alertaBase("desvio", 45), alertaBase("retorno_tardio", 40), alertaBase("aceleracao", 70)]);
    expect(a?.score).toBe(70); // maior score vence (aceleracao), sem bonus (so 1 tipo relevante presente: desvio)
    expect(a?.motivo).not.toContain("corroborado");
  });

  it("bug real 12/07 (auditoria pre-merge): arbitrar TODOS os candidatos crus numa unica chamada nao dobra o bonus quando desvio vem de 2 fontes + jammer", () => {
    // Cenario de producao: jammer(60) e desvio comportamental(45) sao
    // candidatos "core"; separadamente, a cerca virtual (alertaCerca,
    // tambem tipo desvio, fonte independente) e um "extra"(50). O jeito
    // CERTO (route.ts apos o fix) e uma unica arbitragem com TODOS os
    // candidatos crus -- desvio conta 1 tipo so mesmo com 2 fontes.
    const core = [alertaBase("jammer", 60), alertaBase("desvio", 45)];
    const extras = [alertaBase("desvio", 50)];

    const correto = arbitrarCandidatos([...core, ...extras]);
    expect(correto?.score).toBe(75); // 60 (jammer) + 15 (1 bonus, desvio conta 1x)
    expect(correto?.motivo.match(/corroborado por/g)?.length ?? 0).toBe(1);

    // O jeito ERRADO (bug corrigido): arbitrar core primeiro (jammer vence
    // com bonus, score 75, motivo ja diz "corroborado por: desvio"), DEPOIS
    // arbitrar esse resultado de novo junto com os extras -- o dedup por
    // tipo enxerga "desvio" (do extra) como sinal novo e soma +15 de novo.
    const arbitradoEmCadeia = arbitrarCandidatos([arbitrarCandidatos(core)!, ...extras]);
    expect(arbitradoEmCadeia?.score).toBe(90); // 60 + 15 + 15, dobrado -- e o bug, nao o comportamento esperado
  });
});

describe("reduzirPorTransitoInferido (transito real da propria frota corrobora corte de transito, 12/07)", () => {
  const desvioRodovia: Alerta = { nivel: "critico", tipo: "desvio", motivo: "Fora da rota esperada", score: 75 };

  it("fora de rodovia (contexto urbano): nao reduz, mesmo com vizinhos lentos", () => {
    const a = reduzirPorTransitoInferido(desvioRodovia, { emRodovia: false, vizinhosLentos: 3 });
    expect(a.score).toBe(75);
  });

  it("em rodovia mas sem vizinhos lentos o suficiente (so 1): nao reduz", () => {
    const a = reduzirPorTransitoInferido(desvioRodovia, { emRodovia: true, vizinhosLentos: 1 });
    expect(a.score).toBe(75);
  });

  it("em rodovia com 2+ vizinhos lentos: reduz 20 pontos", () => {
    const a = reduzirPorTransitoInferido(desvioRodovia, { emRodovia: true, vizinhosLentos: 2 });
    expect(a.score).toBe(55);
  });

  it("reducao respeita piso minimo de 30 (nao deixa o alerta sumir)", () => {
    const scoreBaixo: Alerta = { ...desvioRodovia, score: 40 };
    const a = reduzirPorTransitoInferido(scoreBaixo, { emRodovia: true, vizinhosLentos: 5 });
    expect(a.score).toBe(30); // 40 - 20 = 20, mas piso e 30
  });

  it("so aplica a alertas tipo desvio -- outros tipos passam intactos", () => {
    const outroTipo: Alerta = { nivel: "critico", tipo: "jammer", motivo: "x", score: 80 };
    const a = reduzirPorTransitoInferido(outroTipo, { emRodovia: true, vizinhosLentos: 3 });
    expect(a.score).toBe(80);
  });
});

describe("temCoordenadaValida", () => {
  it("rejeita lat/lng null", () => {
    expect(temCoordenadaValida({ lat: null, lng: -43.2 })).toBe(false);
    expect(temCoordenadaValida({ lat: -22.9, lng: null })).toBe(false);
  });
  it("rejeita (0,0) explicito", () => {
    expect(temCoordenadaValida({ lat: 0, lng: 0 })).toBe(false);
  });
  it("aceita coordenada real do Rio", () => {
    expect(temCoordenadaValida({ lat: -22.9, lng: -43.2 })).toBe(true);
  });
});

// REMOVIDO (achado real 31/07): deveAutoResolverRuaEstranha,
// calcularParadaToleranteSegundos e alertaElegivelParaAutoResolveRuaEstranha
// (e seus testes) foram removidos junto com a feature -- ver comentario em
// detectores.ts no ponto onde a auto-resolucao de rua-estreita existia.

describe("elegivelParaAcaoMassa (guard de idade minima pra acao em massa)", () => {
  const AGORA = new Date("2026-08-09T12:00:00.000Z");

  it("alerta com exatamente 5min de idade: elegivel (limite inclusivo)", () => {
    expect(elegivelParaAcaoMassa("2026-08-09T11:55:00.000Z", AGORA)).toBe(true);
  });

  it("alerta com 4min59s de idade: NAO elegivel (1s antes do limite)", () => {
    expect(elegivelParaAcaoMassa("2026-08-09T11:55:01.000Z", AGORA)).toBe(false);
  });

  it("alerta com 5min01s de idade: elegivel (1s depois do limite)", () => {
    expect(elegivelParaAcaoMassa("2026-08-09T11:54:59.000Z", AGORA)).toBe(true);
  });

  it("alerta recem-criado (idade zero): NAO elegivel", () => {
    expect(elegivelParaAcaoMassa("2026-08-09T12:00:00.000Z", AGORA)).toBe(false);
  });

  it("alerta antigo (varios dias): elegivel", () => {
    expect(elegivelParaAcaoMassa("2026-08-01T12:00:00.000Z", AGORA)).toBe(true);
  });

  it("caso real TTH-3C94 (nasceu as 12:17, acao em massa as 12:18:20 -- 80s depois): NAO elegivel", () => {
    const nascimento = "2026-08-08T15:17:00.000Z";
    const tentativaDeAcao = new Date("2026-08-08T15:18:20.000Z");
    expect(elegivelParaAcaoMassa(nascimento, tentativaDeAcao)).toBe(false);
  });
});

// BLOCKER 1 (revisao independente 27/07): mapaTiposSilenciados (route.ts)
// so deve contar linhas falso_positivo marcadas por acao HUMANA explicita
// -- linhas com contexto.auto_resolvido=true (geradas pelo mecanismo acima)
// nunca podem silenciar o tipo "desvio" fleet-wide por 2h.
describe("contaComoEventoDeSilenciamento", () => {
  it("conta uma linha falso_positivo humana normal (contexto null)", () => {
    expect(contaComoEventoDeSilenciamento(null)).toBe(true);
  });
  it("conta uma linha falso_positivo humana com outro contexto qualquer", () => {
    expect(contaComoEventoDeSilenciamento({ algumOutroCampo: true })).toBe(true);
  });
  it("NAO conta uma linha auto-resolvida (contexto.auto_resolvido=true)", () => {
    expect(contaComoEventoDeSilenciamento({ auto_resolvido: true, motivo: "parou sem area de risco por perto, dentro de 5min" })).toBe(false);
  });
  it("conta quando auto_resolvido esta presente mas false (defensivo)", () => {
    expect(contaComoEventoDeSilenciamento({ auto_resolvido: false })).toBe(true);
  });
});

// M1 (revisao independente round 3, 27/07): recalibrar-desvio/route.ts
// precisa de um predicado MAIS COMPLETO que contaComoEventoDeSilenciamento
// (que so cobre auto_resolvido) -- a calibracao tambem nao pode contar
// linhas fechadas pelo cron de retencao (contexto.auto_expirado=true,
// scripts/migrations/contabo/002_retencao.sql) como julgamento humano real.
describe("contaComoRotuloHumano", () => {
  it("conta uma linha falso_positivo humana normal (contexto null)", () => {
    expect(contaComoRotuloHumano(null)).toBe(true);
  });
  it("conta uma linha falso_positivo humana com outro contexto qualquer", () => {
    expect(contaComoRotuloHumano({ algumOutroCampo: true })).toBe(true);
  });
  it("NAO conta uma linha auto-resolvida (contexto.auto_resolvido=true)", () => {
    expect(
      contaComoRotuloHumano({ auto_resolvido: true, motivo: "parou sem area de risco por perto, dentro de 5min" })
    ).toBe(false);
  });
  it("conta quando auto_resolvido esta presente mas false (defensivo)", () => {
    expect(contaComoRotuloHumano({ auto_resolvido: false })).toBe(true);
  });
  it("NAO conta uma linha auto-expirada pelo cron de retencao (contexto.auto_expirado=true)", () => {
    expect(contaComoRotuloHumano({ auto_expirado: true })).toBe(false);
  });
  it("conta quando auto_expirado esta presente mas false (defensivo)", () => {
    expect(contaComoRotuloHumano({ auto_expirado: false })).toBe(true);
  });
  it("NAO conta quando ambos auto_resolvido e auto_expirado estao true", () => {
    expect(contaComoRotuloHumano({ auto_resolvido: true, auto_expirado: true })).toBe(false);
  });
});

describe("formatarProgressoDestino", () => {
  it("delta negativo = aproximando", () => {
    expect(formatarProgressoDestino(-120)).toEqual({
      texto: "aproximando de um destino (120m)",
      aproximando: true,
    });
  });

  it("delta positivo = ainda se afastando", () => {
    expect(formatarProgressoDestino(340)).toEqual({
      texto: "ainda se afastando (+340m)",
      aproximando: false,
    });
  });

  it("delta zero conta como ainda se afastando (nao aproximou)", () => {
    expect(formatarProgressoDestino(0)).toEqual({
      texto: "ainda se afastando (+0m)",
      aproximando: false,
    });
  });

  it("arredonda pra metro inteiro", () => {
    expect(formatarProgressoDestino(-119.6)).toEqual({
      texto: "aproximando de um destino (120m)",
      aproximando: true,
    });
  });
});

describe("formatarPlacarSombra (texto do placar sombra no card)", () => {
  it("nenhum componente ativo: so o numero, sem sufixo", () => {
    expect(formatarPlacarSombra(0, {})).toBe("Placar sombra: 0/100");
  });

  it("1 componente ativo: numero + 1 sinal", () => {
    expect(formatarPlacarSombra(8, { s1AfastandoDeTudo: 8 })).toBe("Placar sombra: 8/100 — sinais: afastando de tudo");
  });

  it("multiplos componentes ativos: todos listados na ordem das chaves", () => {
    expect(formatarPlacarSombra(2, { s5DiaEstagnado: 2, s2RumoDivergente: 6, d1ParadaPertoDeEntrega: -15, d3DestinoAlinhadoAproximando: -10 }))
      .toBe("Placar sombra: 2/100 — sinais: dia estagnado, rumo divergente, parado perto de entrega, destino alinhado e aproximando");
  });

  it("componente boolean false: excluido da lista", () => {
    expect(formatarPlacarSombra(0, { classeViariaSuprimida: false })).toBe("Placar sombra: 0/100");
  });

  it("chave de auditoria desconhecida (zeradoPorChegada): excluida por nao estar no mapa de labels", () => {
    expect(formatarPlacarSombra(0, { zeradoPorChegada: true })).toBe("Placar sombra: 0/100");
  });

  it("placar fracionario: arredondado no texto", () => {
    expect(formatarPlacarSombra(17.4, {})).toBe("Placar sombra: 17/100");
  });
});

describe("formatarConfiabilidadeDetector (texto de confiabilidade histórica no card)", () => {
  it("taxa -1 (sem dado de calibracao): retorna null, nao mostra numero inventado", () => {
    expect(formatarConfiabilidadeDetector(-1)).toBeNull();
  });

  it("taxa 0: retorna 0% de falso positivo", () => {
    expect(formatarConfiabilidadeDetector(0)).toBe("Histórico: 0% de falso positivo neste tipo de alerta");
  });

  it("taxa 0.661 (caso real classe_viaria): arredonda pra 66%", () => {
    expect(formatarConfiabilidadeDetector(0.661)).toBe("Histórico: 66% de falso positivo neste tipo de alerta");
  });

  it("taxa 0.092 (caso real afastando_de_tudo): arredonda pra 9%", () => {
    expect(formatarConfiabilidadeDetector(0.092)).toBe("Histórico: 9% de falso positivo neste tipo de alerta");
  });

  it("taxa 1 (100% falso positivo): retorna 100%", () => {
    expect(formatarConfiabilidadeDetector(1)).toBe("Histórico: 100% de falso positivo neste tipo de alerta");
  });
});
