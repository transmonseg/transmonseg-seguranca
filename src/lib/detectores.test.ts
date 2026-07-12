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
  detectarDesvio,
  calcularRiscoArea,
  RISCO_AREA_LIMIAR,
  afastouDeTudo,
  avancarStreaksDesvio,
  devAvancarStreaksDesvio,
  detectarTiroteioProximo,
  detectarSaidaNaoAutorizada,
  foraDeRota,
  avaliar,
  formataDuracao,
  emHorarioOperacao,
  detectarBypassEntrega,
  type CtxBypassEntrega,
  detectarAnomaliaBaseline,
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

describe("detectarDesvio (v4: afastamento de TODOS os destinos, corrigido apos flood ao vivo 06/07)", () => {
  // 3 destinos (2 pendentes + 1 base) — cenario tipico com varias entregas.
  const base = {
    distDestinosM: [6000, 8000, 12000],
    distDestinosAnteriorM: [5000, 7000, 11000],
    temPendentes: true,
    emOperacao: true,
    foraDaBase: true,
    entregasFeitas: 2,
    streak: 2,
    afastamentoAcumuladoM: 300,
    dentroTapete: null as boolean | null,
    riscoAreaAtual: 0,
    foraTapeteStreak: 0,
  };
  const emMov = posicaoBase({ velocidade: 40 });

  it("streak 2 afastando de TODOS, via conhecida: critico (dispara rapido, sem piso de distancia)", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: true });
    expect(a?.nivel).toBe("critico");
    expect(a?.tipo).toBe("desvio");
  });

  it("streak 2 fora do tapete, Camada 3 ATIVA (religada 12/07): escala pra 80, motivo cita via desconhecida", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: false });
    expect(a?.nivel).toBe("critico");
    expect(a?.score).toBe(80);
    expect(a?.motivo).toContain("fora de via conhecida");
  });

  it("streak 4 escala pra critico mesmo dentro do tapete (persistencia longa)", () => {
    const a = detectarDesvio(emMov, { ...base, streak: 4, dentroTapete: true });
    expect(a?.nivel).toBe("critico");
  });

  it("desvio pequeno (afastamento acumulado de so 300m) ja dispara atencao", () => {
    const a = detectarDesvio(emMov, { ...base, afastamentoAcumuladoM: 300 });
    expect(a).not.toBeNull();
  });

  it("streak 1 DISPARA agora (persistencia minima baixada pra 1 ciclo, ~1min)", () => {
    // Baixado de 2 pra 1 em 11/07 (diretiva explicita do usuario: "pode ter
    // um desvio de 100 metros e ja SER um desvio" -- imediato, sem esperar
    // um 2o ciclo de confirmacao. Falso positivo aceitavel, prioridade
    // total e nunca perder desvio real).
    const a = detectarDesvio(emMov, { ...base, streak: 1 });
    expect(a).not.toBeNull();
    expect(a?.motivo).toContain("há 1 leituras");
  });

  it("streak 0 continua nao disparando (pelo menos 1 ciclo de confirmacao)", () => {
    expect(detectarDesvio(emMov, { ...base, streak: 0 })).toBeNull();
  });

  it("parado nao dispara", () => {
    expect(detectarDesvio(posicaoBase({ velocidade: 0 }), base)).toBeNull();
  });

  // Achado real 11/07: o gate antigo bloqueava TOTAL, o dia inteiro, veiculos
  // de rota curta (1-3 entregas passam a maior parte do dia com 0 feitas).
  // 4 de 5 casos reais confirmados pela cerca virtual ("fora" de rota real)
  // nunca viraram alerta so por causa disso. Agora dispara igual, mas exige
  // confirmacao do corredor pra sobreviver (nao fail-open) -- a estrada real
  // supre a falta de historico de comportamento sem abrir mao de cautela.
  it("indo para a primeira entrega (0 feitas com pendentes): dispara, mas exige confirmacao do corredor", () => {
    const a = detectarDesvio(emMov, { ...base, entregasFeitas: 0 });
    expect(a).not.toBeNull();
    expect(a?.precisaVerificacaoCorredor).toBe(true);
    expect(a?.exigeConfirmacaoCorredor).toBe(true);
  });

  it("ja com alguma entrega feita: NAO exige confirmacao extra (comportamento de hoje)", () => {
    const a = detectarDesvio(emMov, { ...base, entregasFeitas: 1 });
    expect(a?.exigeConfirmacaoCorredor).toBeUndefined();
  });

  it("ENTREGA NORMAL: aproximando so do 2o pendente (nao o mais proximo) NAO dispara — bug real corrigido", () => {
    // Motorista indo para o destino de 8000m (que ficou mais perto, 7200),
    // mesmo afastando do de 6000m (foi pra 6300) e da base (12000->12300).
    // O v3 anterior disparava aqui porque so olhava "o mais proximo" (6000);
    // o v4 exige afastar de TODOS, e aproximar de qualquer um cancela.
    const a = detectarDesvio(emMov, {
      ...base,
      distDestinosM: [6300, 7200, 12300],
      distDestinosAnteriorM: [6000, 8000, 12000],
    });
    expect(a).toBeNull();
  });

  it("afastando de TODOS os destinos ao mesmo tempo dispara", () => {
    const a = detectarDesvio(emMov, {
      ...base,
      distDestinosM: [6300, 8300, 12300],
      distDestinosAnteriorM: [6000, 8000, 12000],
    });
    expect(a).not.toBeNull();
  });

  it("entre o teto antigo (25km) e o novo (80km): dispara agora (rota longa legitima da Nutry, ex. Angra/Volta Redonda)", () => {
    const a = detectarDesvio(emMov, {
      ...base, distDestinosM: [40000, 42000], distDestinosAnteriorM: [39000, 41000],
    });
    expect(a).not.toBeNull();
  });

  it("entre o teto antigo (80km) e o novo (300km): dispara agora", () => {
    const a = detectarDesvio(emMov, {
      ...base, distDestinosM: [90000, 95000], distDestinosAnteriorM: [89000, 94000],
    });
    expect(a).not.toBeNull();
  });

  it("acima do novo teto de deslocamento interurbano (300km) nao dispara", () => {
    // Subido de 80km pra 300km em 12/07 (revisao linha por linha a pedido
    // do usuario): 80km ainda escondia desvio de verdade acima disso --
    // cobre confortavelmente qualquer entrega dentro do RJ e estados
    // vizinhos (SP, MG, ES), mantendo so um piso de sanidade contra GPS
    // corrompido.
    expect(detectarDesvio(emMov, {
      ...base, distDestinosM: [350000, 355000], distDestinosAnteriorM: [349000, 354000],
    })).toBeNull();
  });

  it("sem destinos (array vazio) nao dispara", () => {
    expect(detectarDesvio(emMov, { ...base, distDestinosM: [], distDestinosAnteriorM: [] })).toBeNull();
  });

  it("0 pendentes (fim de rota): unico destino e a base, mesma regra unificada", () => {
    const a = detectarDesvio(emMov, {
      ...base, temPendentes: false, distDestinosM: [12300], distDestinosAnteriorM: [12000], streak: 2,
    });
    expect(a?.nivel).toBe("critico");
  });

  it("dentro da base nao dispara", () => {
    expect(detectarDesvio(emMov, { ...base, foraDaBase: false })).toBeNull();
  });

  // Achado real 11/07: emOperacao=false sozinho NAO bloqueia mais quando ha
  // pendentes (rota manda, nao calendario -- ver describe de sabado acima
  // pro teste dedicado). Cobertura do fallback antigo (sem NENHUMA rota
  // carregada) tambem esta no describe de sabado.
  it("fora de operacao MAS com pendentes: dispara (rota manda)", () => {
    expect(detectarDesvio(emMov, { ...base, emOperacao: false })).not.toBeNull();
  });

  it("via CONHECIDA mas area de risco elevado (>= limiar): escala tao rapido quanto fora do tapete", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: true, riscoAreaAtual: RISCO_AREA_LIMIAR });
    expect(a?.nivel).toBe("critico");
    expect(a?.score).toBe(80);
    expect(a?.motivo).toContain("área de risco elevado");
  });

  it("via conhecida e area de risco BAIXO (abaixo do limiar): mantem escalonamento normal (score 45 no streak 2)", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: true, riscoAreaAtual: RISCO_AREA_LIMIAR - 1 });
    expect(a?.score).toBe(45);
  });

  it("area de risco 30 (entre o limiar antigo 40 e o novo 25): escala pra 80 agora", () => {
    // Baixado de 40 pra 25 em 11/07 (diretiva explicita: falso positivo
    // aceitavel, prioridade total) -- um sinal isolado de risco moderado
    // (ex. so RISCO_ROUBO_CARGA_ALTO=20 + fator horario) devia bastar pra
    // escalar rapido, nao so combinacoes fortes tipo favela/tiroteio (=40).
    const a = detectarDesvio(emMov, { ...base, dentroTapete: true, riscoAreaAtual: 30 });
    expect(a?.score).toBe(80);
  });

  it("risco de area nunca SUPRIME nem atrasa o alerta - so acelera", () => {
    // dentroTapete:false nao escala mais sozinho (CAMADA3_TAPETE_ATIVA=false,
    // ver describe "zumbi da Camada 3" abaixo) -- mas risco de area alto
    // (>=RISCO_AREA_LIMIAR) escala pro mesmo score 80 por si so, e continua
    // valendo mesmo com dentroTapete:false.
    const a = detectarDesvio(emMov, { ...base, dentroTapete: false, riscoAreaAtual: 100 });
    expect(a?.nivel).toBe("critico");
    expect(a?.score).toBe(80);
  });

  it("alvosApiOk=false (falha da API /alvos): nao dispara mesmo afastando de tudo", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: true, alvosApiOk: false });
    expect(a).toBeNull();
  });

  it("os 4 branches do fluxo principal marcam precisaVerificacaoCorredor=true", () => {
    // score 45 (base)
    expect(detectarDesvio(emMov, { ...base, dentroTapete: true })?.precisaVerificacaoCorredor).toBe(true);
    // score 68 (streak>=4)
    expect(detectarDesvio(emMov, { ...base, streak: 4, dentroTapete: true })?.precisaVerificacaoCorredor).toBe(true);
    // score 80 (area de risco)
    expect(
      detectarDesvio(emMov, { ...base, dentroTapete: true, riscoAreaAtual: RISCO_AREA_LIMIAR })?.precisaVerificacaoCorredor
    ).toBe(true);
    // score 45 (dentroTapete:false, zumbi fechado -- cai no branch base)
    expect(detectarDesvio(emMov, { ...base, dentroTapete: false })?.precisaVerificacaoCorredor).toBe(true);
  });

  it("alvosApiOk indefinido (comportamento de hoje, API ok): dispara normalmente", () => {
    const a = detectarDesvio(emMov, { ...base, dentroTapete: true });
    expect(a).not.toBeNull();
  });

  // Achado real 10/07 (forense historica): a frota se move DE VERDADE aos
  // sabados (sabado quase tao ativo quanto dia de semana em varios tipos de
  // alerta), mas o gate de calendario (seg-sex 6h-20h) deixava o desvio
  // 100% cego nesses dias. Se a Unitrac carregou rota pro veiculo HOJE, e
  // dia de trabalho DELE, independente do calendario.
  it("fora do calendario seg-sex, mas sabadoDiurnoComRota=true: dispara normalmente", () => {
    const a = detectarDesvio(emMov, { ...base, emOperacao: false, sabadoDiurnoComRota: true, dentroTapete: true });
    expect(a).not.toBeNull();
    expect(a?.tipo).toBe("desvio");
  });

  // Achado real 11/07 (diretiva explicita: falso positivo aceitavel,
  // prioridade total e nunca perder desvio real): calendario removido de
  // vez quando ha PENDENTES -- se a Unitrac carregou rota, e hora de
  // trabalho DESSE veiculo, ponto final, nao importa dia/hora. O fallback
  // por calendario so sobra pro caso sem NENHUMA rota carregada (evita
  // disparar pra veiculo em manutencao de madrugada sem nada pra fazer).
  it("fora do calendario e QUALQUER dia/hora, mas TEM pendentes: dispara (rota manda, nao calendario)", () => {
    const a = detectarDesvio(emMov, { ...base, emOperacao: false, sabadoDiurnoComRota: false, dentroTapete: true });
    expect(a).not.toBeNull();
    expect(a?.tipo).toBe("desvio");
  });

  it("fora do calendario e SEM pendentes: continua nao disparando (fallback preservado)", () => {
    expect(detectarDesvio(emMov, {
      ...base, emOperacao: false, sabadoDiurnoComRota: false, dentroTapete: true,
      temPendentes: false, distDestinosM: [12000], distDestinosAnteriorM: [11000],
    })).toBeNull();
  });
});

describe("detectarDesvio + Camada 3 (fora do tapete, DESATIVADA em 09/07/2026 -- ver CAMADA3_TAPETE_ATIVA)", () => {
  // Aproximando (nao afastando de tudo) -- so assim a Camada 3 entraria em jogo.
  const baseAproximando = {
    distDestinosM: [4000],
    distDestinosAnteriorM: [4500],
    temPendentes: true,
    emOperacao: true,
    foraDaBase: true,
    entregasFeitas: 2,
    streak: 0,
    afastamentoAcumuladoM: 0,
    dentroTapete: null as boolean | null,
    riscoAreaAtual: 0,
  };
  const emMov2 = posicaoBase({ velocidade: 40 });

  it("fora do tapete por varias leituras, Camada 3 ATIVA (religada 12/07): dispara", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 8 });
    expect(a).not.toBeNull();
    expect(a?.motivo).toContain("nunca percorreu");
  });

  it("aproximando e DENTRO do tapete (streak 0): nao dispara", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 0 });
    expect(a).toBeNull();
  });

  it("fora do tapete so 1 leitura (abaixo do minimo): nao dispara ainda", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 1 });
    expect(a).toBeNull();
  });

  it("afastando de tudo (Camada 1) tem prioridade -- fora do tapete nao importa nesse caso", () => {
    const a = detectarDesvio(emMov2, {
      ...baseAproximando,
      distDestinosM: [6300], distDestinosAnteriorM: [6000], streak: 2,
      foraTapeteStreak: 5,
    });
    expect(a?.motivo).not.toContain("nunca percorreu");
  });
});

describe("calcularRiscoArea", () => {
  it("sem nenhum sinal de risco: score 0 (mesmo com fator horario alto)", () => {
    expect(calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, fatorHorario: 1.6,
    })).toBe(0);
  });

  it("dentro de favela sozinho ja atinge o limiar de escalonamento (fator horario neutro)", () => {
    const score = calcularRiscoArea({
      emFavela: true, tiroteioRecentePertoM: null, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, fatorHorario: 1,
    });
    expect(score).toBeGreaterThanOrEqual(RISCO_AREA_LIMIAR);
  });

  it("tiroteio recente proximo (<=1500m) sozinho ja atinge o limiar", () => {
    const score = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: 800, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, fatorHorario: 1,
    });
    expect(score).toBeGreaterThanOrEqual(RISCO_AREA_LIMIAR);
  });

  it("tiroteio longe demais (>1500m) nao conta", () => {
    const score = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: 5000, rouboCargaCispTotal: null,
      emCorredorRodoviaRisco: false, fatorHorario: 1,
    });
    expect(score).toBe(0);
  });

  it("roubo de carga alto no CISP (>=15 em 12 meses) soma mais que medio", () => {
    const alto = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 20,
      emCorredorRodoviaRisco: false, fatorHorario: 1,
    });
    const medio = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 3,
      emCorredorRodoviaRisco: false, fatorHorario: 1,
    });
    expect(alto).toBeGreaterThan(medio);
    expect(medio).toBeGreaterThan(0);
  });

  it("fator horario e MULTIPLICATIVO: amplifica proporcionalmente um sinal espacial ja existente", () => {
    const base = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 3, // medio = 10
      emCorredorRodoviaRisco: false, fatorHorario: 1,
    });
    const amplificado = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 3,
      emCorredorRodoviaRisco: false, fatorHorario: 1.6,
    });
    expect(base).toBe(10);
    expect(amplificado).toBe(16); // 10 * 1.6, nao 10 + bonus fixo
  });

  it("combinacao de sinais fracos pode somar acima do limiar", () => {
    const score = calcularRiscoArea({
      emFavela: false, tiroteioRecentePertoM: null, rouboCargaCispTotal: 20,
      emCorredorRodoviaRisco: true, fatorHorario: 1,
    });
    expect(score).toBeGreaterThanOrEqual(RISCO_AREA_LIMIAR);
  });

  it("nunca passa de 100 mesmo com todos os sinais ativos e fator horario maximo", () => {
    const score = calcularRiscoArea({
      emFavela: true, tiroteioRecentePertoM: 100, rouboCargaCispTotal: 999,
      emCorredorRodoviaRisco: true, fatorHorario: 1.6,
    });
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("afastouDeTudo", () => {
  it("true quando TODAS as distancias cresceram alem da margem de 50m", () => {
    expect(afastouDeTudo([6000, 8000], [5000, 7000])).toBe(true);
  });
  it("false quando aproxima de QUALQUER destino (entrega normal a um pendente distante)", () => {
    expect(afastouDeTudo([6300, 7200], [6000, 8000])).toBe(false);
  });
  it("false quando o crescimento fica dentro da margem de ruido de GPS", () => {
    expect(afastouDeTudo([5030, 7040], [5000, 7000])).toBe(false);
  });
  it("false sem destinos ou com arrays de tamanhos diferentes", () => {
    expect(afastouDeTudo([], [])).toBe(false);
    expect(afastouDeTudo([5000], [])).toBe(false);
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

describe("avancarStreaksDesvio (histerese: 1 aproximacao congela, 2 zeram)", () => {
  it("afastando: incrementa desvioStreak e zera aproximandoStreak", () => {
    expect(avancarStreaksDesvio(true, { desvioStreak: 2, aproximandoStreak: 1 }))
      .toEqual({ desvioStreak: 3, aproximandoStreak: 0, zerou: false });
  });

  it("1 leitura de aproximacao isolada: CONGELA o desvioStreak (nao zera, nao incrementa)", () => {
    expect(avancarStreaksDesvio(false, { desvioStreak: 3, aproximandoStreak: 0 }))
      .toEqual({ desvioStreak: 3, aproximandoStreak: 1, zerou: false });
  });

  it("2 leituras consecutivas de aproximacao: zera o desvioStreak", () => {
    expect(avancarStreaksDesvio(false, { desvioStreak: 3, aproximandoStreak: 1 }))
      .toEqual({ desvioStreak: 0, aproximandoStreak: 2, zerou: true });
  });

  it("cenario de serra (afasta, afasta, aproxima 1x por curva, afasta): acumula em vez de recomecar", () => {
    let s: { desvioStreak: number; aproximandoStreak: number } = { desvioStreak: 0, aproximandoStreak: 0 };
    s = avancarStreaksDesvio(true, s);   // 1
    s = avancarStreaksDesvio(true, s);   // 2
    s = avancarStreaksDesvio(false, s);  // curva: congela em 2
    s = avancarStreaksDesvio(true, s);   // 3 -- antes da histerese seria 1
    expect(s.desvioStreak).toBe(3);
  });
});

describe("devAvancarStreaksDesvio (posicao congelada nao conta como aproximacao)", () => {
  it("posicao praticamente identica ao ciclo anterior (<10m): NAO avanca (congela)", () => {
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: false, distanciaAoAnteriorM: 3, velocidade: 40,
    })).toBe(false);
  });

  it("movimento real (>=10m): avanca normalmente", () => {
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: false, distanciaAoAnteriorM: 50, velocidade: 40,
    })).toBe(true);
  });

  it("sem posicao anterior: nao avanca (nada a comparar)", () => {
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: false, distanciaAoAnteriorM: null, velocidade: 40,
    })).toBe(false);
  });

  it("nao fresco ou salto implausivel: nao avanca (regras existentes preservadas)", () => {
    expect(devAvancarStreaksDesvio({
      fresco: false, saltoImplausivel: false, distanciaAoAnteriorM: 50, velocidade: 40,
    })).toBe(false);
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: true, distanciaAoAnteriorM: 50, velocidade: 40,
    })).toBe(false);
  });

  it("velocidade 0 (genuinamente parado, posicao real): nao avanca", () => {
    expect(devAvancarStreaksDesvio({
      fresco: true, saltoImplausivel: false, distanciaAoAnteriorM: 50, velocidade: 0,
    })).toBe(false);
  });
});

describe("foraDeRota (v2: menor distancia a qualquer destino OU aproximacao sustentada)", () => {
  const p = posicaoBase();
  it("mantem alerta enquanto longe de todos os destinos e sem aproximacao sustentada", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 3000, foraDaBase: true, aproximandoStreak: 0 })).toBe(true);
  });
  it("resolve quando volta a menos de 2,5km de algum destino", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 1000, foraDaBase: true, aproximandoStreak: 0 })).toBe(false);
  });
  it("resolve dentro da base", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 9000, foraDaBase: false, aproximandoStreak: 0 })).toBe(false);
  });

  // Achado real 10/07 (deep-dive de resolucao do alerta): !emOperacao fechava
  // QUALQUER desvio ativo assim que a proxima posicao fresca chegasse fora
  // do horario 6h-20h seg-sex (ou fim de semana), sem checar nenhum
  // comportamento -- confirmado com dado real (3 alertas com <30min de vida
  // fechados exatamente as 20h, so esse caminho explica). emOperacao
  // continua controlando CRIACAO de alerta novo (detectarDesvio), nunca
  // mais o fechamento -- removido do contrato de foraDeRota.
  it("fora de horario de operacao NAO fecha mais sozinho (so o comportamento decide)", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 9000, foraDaBase: true, aproximandoStreak: 0 })).toBe(true);
  });

  // Achado real 09/07 (TUL-1C38, ver docs/analise-deteccao.md secao 7.2):
  // veiculo aproximando MONOTONICAMENTE da base por 10 leituras (8,26km ->
  // 2,12km) ficou com o alerta "ativo" o trajeto inteiro, porque o resolve
  // so olhava distancia absoluta. Mesma regua do disparo (Camada 1: streak
  // >=2 de comportamento) agora tambem resolve: aproximacao SUSTENTADA
  // (>=2 leituras consecutivas sem afastar de tudo) encerra o alerta, nao
  // precisa esperar chegar fisicamente perto.
  it("resolve com aproximacao sustentada (streak>=2) mesmo longe de tudo", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 8260, foraDaBase: true, aproximandoStreak: 2 })).toBe(false);
  });
  it("NAO resolve com so 1 leitura de aproximacao (evita limpar alerta com 1 blip)", () => {
    expect(foraDeRota(p, { menorDistDestinoM: 8260, foraDaBase: true, aproximandoStreak: 1 })).toBe(true);
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
  it("desvio entra na avaliacao quando ha destinos (distDestinosM definido)", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 40 }), {
      ...ctxOp,
      distDestinosM: [6000, 9000],
      distDestinosAnteriorM: [5000, 8000],
      temPendentes: true,
      entregasFeitas: 3,
      desvioStreak: 4,
      afastamentoAcumuladoM: 1600,
    });
    expect(alerta?.tipo).toBe("desvio");
    expect(alerta?.nivel).toBe("critico");
  });
  it("sem destinos (distDestinosM ausente) NAO avalia desvio", () => {
    expect(avaliar(posicaoBase({ velocidade: 40 }), ctxOp)).toBeNull();
  });
  it("panico tem prioridade sobre desvio", () => {
    const alerta = avaliar(posicaoBase({ velocidade: 40, panico: true }), {
      ...ctxOp,
      distDestinosM: [6000, 9000],
      distDestinosAnteriorM: [5000, 8000],
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
  it("fora da base, sem rota, ignicao ligada e PARADO retorna critico", () => {
    const a = detectarSaidaNaoAutorizada(
      posicaoBase({ ignicao: true, fresco: true, velocidade: 0 }),
      { foraDaBase: true, temPendentes: false, entregasTotal: 0 }
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
