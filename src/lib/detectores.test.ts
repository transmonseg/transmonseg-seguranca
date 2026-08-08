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
  PARADA_FORA_TAPETE_MIN,
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
  aplicarBonusClasseViaria,
  montarContextoDesvio,
  desvioInicioEfetivoParaContexto,
  zerarStreakDaOrigemVencedora,
  reancorarOrigemVencedora,
  viradaErradaSaindoDeParada,
  TIPOS_NAO_GERENCIADOS,
  temCoordenadaValida,
  contaComoEventoDeSilenciamento,
  contaComoRotuloHumano,
  deveAutoResolverAfastandoRotaConcluida,
  elegivelParaAutoResolveAfastando,
  elegivelParaAnotarPlacarSombra,
  origemMenorDistDestinoM,
  AFASTANDO_ROTA_CONCLUIDA_PARADO_MIN_MIN,
  deveAutoResolverAfastandoChegadaReal,
  MOTIVO_RUA_ESTRANHA,
  AFASTANDO_CHEGADA_REAL_PARADO_MIN_MIN,
  saiuParadaConfirmadaHaMenosDe,
  JANELA_SAIDA_PARADA_MIN,
  deveMarcarSaidaParadaConfirmada,
  razaoRetidaoRumo,
  limiarRazaoRetidaoRumo,
  RETIDAO_RUMO_LIQUIDO_MINIMO_M,
  rumoCoerenteComDestino,
  formatarProgressoDestino,
  formatarPlacarSombra,
  type Alerta,
} from "./detectores";
import { segmentoCalibracaoPreferido } from "./calibracao-desvio";
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
  //
  // desvioSoAfastandoOuForaDoTapete: false -- este bloco documenta o
  // comportamento das regras que a POLITICA DE PRODUCAO desligou em 01/08
  // (classe_viaria/rua estreita, saida_parada, rumo_diverge). Os testes
  // seguem valendo como registro do que essas regras fazem e como
  // reverter (ver DESVIO_SO_AFASTANDO_OU_FORA_DO_TAPETE em detectores.ts).
  // A politica de producao em si tem bloco proprio no fim do arquivo.
  const base = {
    desvioSoAfastandoOuForaDoTapete: false,
    distDestinosM: [6000, 8000, 12000],
    distDestinosAnteriorM: [5000, 7000, 11000],
    temPendentes: true,
    emOperacao: true,
    foraDaBase: true,
    entregasFeitas: 2,
    streak: 2,
    afastamentoAcumuladoM: 300,
    dentroTapete: null as boolean | null,
    familiarVeiculo: null as boolean | null,
    riscoAreaAtual: 0,
    foraTapeteStreak: 0,
    suspensoPorChegada: false,
    divergenciaRumoStreak: 0,
    saiuDoRaioAgora: false,
    divergenciaGrausAtual: null as number | null,
    quedaClasseViaria: false,
    saiuParadaConfirmadaRecentemente: false,
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
    expect(a?.origemDesvio).toBe("comportamental");
  });

  it("streak 4 escala pra critico mesmo dentro do tapete (persistencia longa)", () => {
    const a = detectarDesvio(emMov, { ...base, streak: 4, dentroTapete: true });
    expect(a?.nivel).toBe("critico");
    expect(a?.origemDesvio).toBe("comportamental");
  });

  it("desvio pequeno (afastamento acumulado de so 300m) ja dispara atencao", () => {
    const a = detectarDesvio(emMov, { ...base, afastamentoAcumuladoM: 300 });
    expect(a).not.toBeNull();
  });

  it("streak 1 NAO dispara mais (persistencia minima restaurada pra 2 ciclos em 21/07)", () => {
    // Restaurado de 1 pra 2 em 21/07, revertendo a baixa de 11/07 --
    // achado real desta sessao: 69 de 81 alertas "afastando-se"
    // dispararam com apenas 1 leitura, volume de ruido considerável.
    // Decisao consciente do usuario, avisado do trade-off (desvio real
    // pequeno leva ~1min a mais pra confirmar).
    expect(detectarDesvio(emMov, { ...base, streak: 1 })).toBeNull();
  });

  it("streak 0 e 1 nao disparam (abaixo do piso minimo de 2 ciclos)", () => {
    expect(detectarDesvio(emMov, { ...base, streak: 0 })).toBeNull();
    expect(detectarDesvio(emMov, { ...base, streak: 1 })).toBeNull();
  });

  it("streak 2 dispara (novo piso minimo)", () => {
    const a = detectarDesvio(emMov, { ...base, streak: 2 });
    expect(a).not.toBeNull();
    expect(a?.motivo).toContain("há 2 leituras");
  });

  it("parado nao dispara", () => {
    expect(detectarDesvio(posicaoBase({ velocidade: 0 }), base)).toBeNull();
  });

  // Achado real 11/07: o gate antigo bloqueava TOTAL, o dia inteiro, veiculos
  // de rota curta (1-3 entregas passam a maior parte do dia com 0 feitas).
  // 4 de 5 casos reais confirmados pela cerca virtual ("fora" de rota real)
  // nunca viraram alerta so por causa disso. Agora dispara igual: o DETECTOR
  // marca exigeConfirmacaoCorredor=true, mas route.ts decide fail-open/fail-closed
  // por tipo de alerta (ex: indisponivel faz fail-open). A estrada real supre
  // a falta de historico sem abrir mao de cautela.
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

  it("acima do novo teto (300km) MAS afastando de tudo: dispara alerta FRACO (achado 22/07)", () => {
    // Achado real 22/07 (auditoria): fecha o "ponto cego" documentado desde
    // 12/07 -- sequestro que passe do teto nao fica mais 100% invisivel,
    // vira alerta de baixa confianca (nivel atencao) em vez de silencio.
    const a = detectarDesvio(emMov, {
      ...base, distDestinosM: [350000, 355000], distDestinosAnteriorM: [349000, 354000],
    });
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("atencao");
    expect(a?.score).toBe(30);
    expect(a?.motivo).toContain("Muito além");
    expect(a?.origemDesvio).toBe("comportamental");
  });

  it("acima do novo teto (300km) e NAO afastando de tudo: continua silencioso", () => {
    // Viagem legitima >300km que esta se aproximando de algum destino nao
    // deve gerar ruido -- so o caso genuinamente suspeito (afastando de
    // tudo, sustentado) passa a alertar.
    const a = detectarDesvio(emMov, {
      ...base, distDestinosM: [350000, 355000], distDestinosAnteriorM: [351000, 356000],
    });
    expect(a).toBeNull();
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
    expect(a?.origemDesvio).toBe("comportamental");
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

  it("abaixo do piso minimo (2500m) nao dispara -- provavel manobra/estacionamento no destino", () => {
    const a = detectarDesvio(emMov, {
      ...base, distDestinosM: [2000, 2200], distDestinosAnteriorM: [1900, 2100],
    });
    expect(a).toBeNull();
  });

  it("exatamente no piso (2500m) ou logo acima: comportamento normal (nao bloqueado pelo piso)", () => {
    const a = detectarDesvio(emMov, {
      ...base, distDestinosM: [2500, 2700], distDestinosAnteriorM: [2400, 2600],
    });
    expect(a).not.toBeNull();
  });

  it("todo alerta de desvio comportamental tem origemDesvio='comportamental' (achado 22/07)", () => {
    const a = detectarDesvio(emMov, { ...base, streak: 2 });
    expect(a?.origemDesvio).toBe("comportamental");
  });

  // Achado real 25/07 (redesign): suspensoPorChegada substitui o
  // cancelamento por distancia como cancelador ABSOLUTO -- geofence real
  // (dentro do raio de um destino legitimo OU ponto_seguro), nao mais
  // tendencia de distancia.
  it("suspensoPorChegada=true: nunca dispara, mesmo com todos os outros sinais de desvio presentes", () => {
    const a = detectarDesvio(emMov, { ...base, suspensoPorChegada: true, divergenciaRumoStreak: 5 });
    expect(a).toBeNull();
  });

  it("divergencia de rumo streak suficiente (2), distancia caindo: dispara nivel atencao com origemDesvio proprio (Task 2, achado 28/07: antes era 'comportamental', misturado com afastando-de-tudo)", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 2,
      distDestinosM: [6300], distDestinosAnteriorM: [7000], // distancia caindo (aproximando)
    });
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("atencao");
    expect(a?.origemDesvio).toBe("rumo_diverge");
  });

  it("divergencia de rumo streak insuficiente (1): nao dispara so por isso", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 1,
      distDestinosM: [6300], distDestinosAnteriorM: [7000],
    });
    expect(a).toBeNull();
  });

  it("divergencia de rumo dispara igual mesmo com veiculo familiarizado com a area (SEM amortecimento, decisao revista 25/07)", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 2, familiarVeiculo: true,
      distDestinosM: [6300], distDestinosAnteriorM: [7000],
    });
    expect(a).not.toBeNull();
  });

  it("afastando de tudo AINDA dispara critico (comportamento existente preservado)", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 0,
      distDestinosM: [6300, 8300, 12300], distDestinosAnteriorM: [6000, 8000, 12000],
    });
    expect(a?.nivel).toBe("critico");
  });

  it("ponto cego do contorno de lagoa (achado real 25/07): aproximando em linha reta MAS divergencia de rumo alta -- dispara mesmo assim", () => {
    // Distancia liquida caindo (a versao antiga cancelaria aqui), mas
    // divergencia de rumo ja acumulou streak suficiente.
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 2, familiarVeiculo: null,
      distDestinosM: [5000], distDestinosAnteriorM: [5500],
    });
    expect(a).not.toBeNull();
  });

  // Achado real 26/07 (Fase 2): virada errada saindo de parada -- dispara
  // com 1 leitura so (sem streak) quando o veiculo acabou de sair do raio
  // de um destino legitimo E tomou direcao muito divergente (>140 graus).
  it("virada errada saindo de parada: saiuDoRaioAgora + divergencia alta (150), 1 leitura so, dispara atencao", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 0,
      saiuDoRaioAgora: true, divergenciaGrausAtual: 150,
      distDestinosM: [6300], distDestinosAnteriorM: [7000], // aproximando em linha reta (afastandoDeTudo=false)
    });
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("atencao");
    expect(a?.origemDesvio).toBe("saida_parada");
  });

  // Achado real 27/07 (fix(desvio): contexto/calibracao de saida_parada
  // nunca era salvo -- mesmo bug, mesmo padrao do fix aplicado hoje pra
  // origemDesvio="classe_viaria"): esta regra dispara com 1 leitura so
  // (ver acima), ANTES de qualquer streak de afastamento existir --
  // portanto desvioInicio (que so avanca via avancarStreaksDesvio, atrelado
  // a movimento de afastamento) tipicamente esta null em route.ts quando
  // ELA e' a causa primaria do alerta. route.ts usava `ehDesvio` (definido
  // so por tipo==="desvio" && desvioInicio!==null) pra decidir se contexto
  // era gravado -- sem o fix, contexto caia sempre em `{}`, perdendo pra
  // sempre o segmento de calibracao "origem:saida_parada" (pedido explicito
  // do usuario pra recalibrar-desvio aprender sozinha a taxa de falso
  // positivo desta regra). Nao ha harness de teste pra route.ts em si
  // (mesma limitacao que o fix de classe_viaria teve: commit 72e5a1e nao
  // adicionou nenhum teste novo, pelo mesmo motivo) -- estes dois testes
  // travam os ingredientes REAIS que route.ts combina pra decidir lat/lng/
  // contexto: a origem do alerta e a resolucao do segmento de calibracao.
  describe("saida_parada: contexto/calibracao nao pode se perder (mesmo bug e mesmo fix de classe_viaria, 27/07)", () => {
    it("alerta disparado tem nivel SEMPRE 'atencao' (nunca 'critico') -- e por isso que a escalacao pra critico em route.ts e' estruturalmente inalcancavel pra esta origem, igual classe_viaria", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, divergenciaRumoStreak: 0,
        saiuDoRaioAgora: true, divergenciaGrausAtual: 150,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a?.origemDesvio).toBe("saida_parada");
      expect(a?.nivel).toBe("atencao");
    });

    it("segmentoCalibracaoPreferido resolve o segmento proprio pra este alerta, independente do veredito de corredor -- o dado que route.ts agora grava no contexto (contextoSaidaParada) em vez de perder em `{}`", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, divergenciaRumoStreak: 0,
        saiuDoRaioAgora: true, divergenciaGrausAtual: 150,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).not.toBeNull();
      expect(segmentoCalibracaoPreferido(a!, null)).toBe("origem:saida_parada");
      expect(segmentoCalibracaoPreferido(a!, "fora")).toBe("origem:saida_parada");
    });
  });

  // Achado real 28/07 (Task 2 do plano de melhorias pos-baseline): rumo
  // diverge (divergenciaRumoDispara) usava origemDesvio="comportamental"
  // ate aqui, misturado com "afastando de tudo" no balde generico
  // tipo:desvio -- mesma familia de bug (segmento de calibracao proprio
  // perdido) ja corrigida pra saida_parada/classe_viaria acima.
  describe("rumo_diverge: segmento de calibracao proprio (Task 2, achado 28/07)", () => {
    it("origemDesvio da regra de divergencia de rumo e' 'rumo_diverge' (nao mais 'comportamental')", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, divergenciaRumoStreak: 2,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a?.origemDesvio).toBe("rumo_diverge");
    });

    it("segmentoCalibracaoPreferido resolve 'origem:rumo_diverge' pra este alerta, independente do veredito de corredor", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, divergenciaRumoStreak: 2,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).not.toBeNull();
      expect(segmentoCalibracaoPreferido(a!, null)).toBe("origem:rumo_diverge");
      expect(segmentoCalibracaoPreferido(a!, "fora")).toBe("origem:rumo_diverge");
    });
  });

  // Achado real 28/07 (Task 4, caso real TTK-4D14: 84-88km/h no momento do
  // disparo, perfil de rodovia -- bearing reto diverge de rota real que
  // curva): liga verificarCorredor (OSRM/Valhalla) na regra de rumo-diverge,
  // mesmo mecanismo ja usado pelas branches de "afastando de tudo".
  describe("rumo_diverge: corroboracao contra rota real (Task 4, achado 28/07)", () => {
    it("marca precisaVerificacaoCorredor=true (liga a verificacao de corredor real, mesmo mecanismo das branches de afastando-de-tudo)", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, divergenciaRumoStreak: 2,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a?.precisaVerificacaoCorredor).toBe(true);
    });

    it("NAO marca exigeConfirmacaoCorredor (decisao explicita, Step 3: sinal 'atencao' mais fraco -- corroboracao OPCIONAL, nao EXIGIDA -- nao deveria fail-closed se OSRM/Valhalla estiver indisponivel)", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, divergenciaRumoStreak: 2,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a?.exigeConfirmacaoCorredor).toBeUndefined();
    });

    it("NAO marca exigeConfirmacaoCorredor mesmo sem historico de entregas (entregasFeitas=0) -- diferente das branches de afastando-de-tudo, rumo_diverge nao usa semHistorico (nao tem o problema de 'cold start' que aquele campo compensa)", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, divergenciaRumoStreak: 2, entregasFeitas: 0,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a?.origemDesvio).toBe("rumo_diverge");
      expect(a?.exigeConfirmacaoCorredor).toBeUndefined();
    });
  });

  it("nao saiu do raio agora: NAO dispara so por divergencia alta numa leitura (precisa da regra geral, streak>=2)", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 0,
      saiuDoRaioAgora: false, divergenciaGrausAtual: 150,
      distDestinosM: [6300], distDestinosAnteriorM: [7000],
    });
    expect(a).toBeNull();
  });

  it("saiu do raio agora mas divergencia dentro do esperado: nao dispara", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 0,
      saiuDoRaioAgora: true, divergenciaGrausAtual: 30,
      distDestinosM: [6300], distDestinosAnteriorM: [7000],
    });
    expect(a).toBeNull();
  });

  it("suspensoPorChegada=true: nao dispara mesmo com saiuDoRaioAgora+divergencia alta (guard existente prevalece)", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: true, divergenciaRumoStreak: 0,
      saiuDoRaioAgora: true, divergenciaGrausAtual: 150,
      distDestinosM: [6300], distDestinosAnteriorM: [7000],
    });
    expect(a).toBeNull();
  });

  it("afastando de tudo: a regra critica existente prevalece (nao entra no branch novo)", () => {
    const a = detectarDesvio(emMov, {
      ...base, suspensoPorChegada: false, divergenciaRumoStreak: 0,
      saiuDoRaioAgora: true, divergenciaGrausAtual: 150,
      distDestinosM: [6300, 8300, 12300], distDestinosAnteriorM: [6000, 8000, 12000], // afastando de tudo
    });
    expect(a?.nivel).toBe("critico"); // branch de afastandoDeTudo, nao o novo
  });

  describe("queda de classe viaria dispara SOZINHA (achado 27/07, pedido explicito do usuario)", () => {
    it("quedaClasseViaria=true, aproximando (nao afastando de tudo), fora de chegada: dispara atencao", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        distDestinosM: [6300], distDestinosAnteriorM: [7000], // aproximando -- deveria disparar MESMO ASSIM
      });
      expect(a).not.toBeNull();
      expect(a?.nivel).toBe("atencao");
      expect(a?.origemDesvio).toBe("classe_viaria");
    });

    it("suspensoPorChegada=true (chegada real): NAO dispara mesmo com quedaClasseViaria=true", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: true, quedaClasseViaria: true,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).toBeNull();
    });

    it("quedaClasseViaria=false: nao dispara so por isso", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: false,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).toBeNull();
    });

    it("afastando de tudo: a regra critica existente prevalece (nao entra neste branch)", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        distDestinosM: [6300, 8300, 12300], distDestinosAnteriorM: [6000, 8000, 12000], // afastando de tudo
      });
      expect(a?.nivel).toBe("critico"); // veio de outro branch, nao do de classe viaria
    });

    // Achado do revisor (opus) + decisao explicita do usuario, task 2: o
    // branch acima herdava um piso de 2500m (DESVIO_MIN_M) por estar
    // posicionado DEPOIS do "if (menorDistM < DESVIO_MIN_M) return null;" --
    // so disparava se o veiculo estivesse a mais de 2,5km de QUALQUER
    // destino. Usuario nao quer esse piso pra esta regra: um roubo pode
    // acontecer bem perto do cliente (ex.: 100m depois de virar numa rua
    // errada). Estes dois testes cobrem os extremos (bem perto / bem longe)
    // que o piso e o teto bloqueavam antes da regra mudar de posicao.
    it("dispara mesmo com destino bem perto (200m, abaixo do piso de 2500m que protegia os OUTROS branches)", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        distDestinosM: [200], distDestinosAnteriorM: [250], // aproximando, mas bem perto -- sem piso agora
      });
      expect(a).not.toBeNull();
      expect(a?.nivel).toBe("atencao");
      expect(a?.origemDesvio).toBe("classe_viaria");
    });

    it("dispara mesmo com destino bem longe (500km, alem do teto de 300km), sem precisar do streak>=2 que o branch do teto exige pra ele mesmo", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true, streak: 1,
        distDestinosM: [500000], distDestinosAnteriorM: [500500], // aproximando, bem alem do teto -- sem teto agora
      });
      expect(a).not.toBeNull();
      expect(a?.nivel).toBe("atencao");
      expect(a?.origemDesvio).toBe("classe_viaria");
    });
  });

  describe("saiu de parada confirmada recentemente suprime rua-estreita (achado real 28/07, Task 6: 36% dos FP manuais de classe_viaria eram o veiculo saindo de uma parada de entrega legitima e pegando uma rua estreita logo em seguida)", () => {
    const agora = new Date("2026-07-28T12:00:00.000Z");

    it("saiuParadaConfirmadaHaMenosDe: nunca saiu de parada confirmada (null) -- false", () => {
      expect(saiuParadaConfirmadaHaMenosDe(null, agora)).toBe(false);
    });

    it("saiuParadaConfirmadaHaMenosDe: saiu ha 2min (dentro da janela de 5min) -- true", () => {
      const ha2min = new Date(agora.getTime() - 2 * 60_000).toISOString();
      expect(saiuParadaConfirmadaHaMenosDe(ha2min, agora)).toBe(true);
    });

    it("saiuParadaConfirmadaHaMenosDe: saiu ha 10min (fora da janela de 5min) -- false", () => {
      const ha10min = new Date(agora.getTime() - 10 * 60_000).toISOString();
      expect(saiuParadaConfirmadaHaMenosDe(ha10min, agora)).toBe(false);
    });

    it("saiuParadaConfirmadaHaMenosDe: exatamente no limite da janela (5min) -- true (<=, nao <)", () => {
      const noLimite = new Date(agora.getTime() - JANELA_SAIDA_PARADA_MIN * 60_000).toISOString();
      expect(saiuParadaConfirmadaHaMenosDe(noLimite, agora)).toBe(true);
    });

    it("veiculo em rua estreita SEM ter saido de parada recente: dispara normal", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        saiuParadaConfirmadaRecentemente: false,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).not.toBeNull();
      expect(a?.origemDesvio).toBe("classe_viaria");
    });

    it("veiculo saiu de parada confirmada ha 2min (dentro da janela): SUPRIME o alerta de rua-estreita", () => {
      const ha2min = new Date(agora.getTime() - 2 * 60_000).toISOString();
      const recente = saiuParadaConfirmadaHaMenosDe(ha2min, agora);
      expect(recente).toBe(true); // pre-condicao do teste
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        saiuParadaConfirmadaRecentemente: recente,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).toBeNull();
    });

    it("veiculo saiu de parada confirmada ha 10min (fora da janela): dispara normal de novo", () => {
      const ha10min = new Date(agora.getTime() - 10 * 60_000).toISOString();
      const recente = saiuParadaConfirmadaHaMenosDe(ha10min, agora);
      expect(recente).toBe(false); // pre-condicao do teste
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        saiuParadaConfirmadaRecentemente: recente,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).not.toBeNull();
      expect(a?.origemDesvio).toBe("classe_viaria");
    });

    it("suprime SO o branch de classe_viaria -- afastando de tudo continua disparando (critico) mesmo com saiuParadaConfirmadaRecentemente=true", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        saiuParadaConfirmadaRecentemente: true,
        distDestinosM: [6300, 8300, 12300], distDestinosAnteriorM: [6000, 8000, 12000], // afastando de tudo
      });
      expect(a?.nivel).toBe("critico"); // veio do branch de afastandoDeTudo, nao suprimido
    });
  });

  describe("classeViariaSuprimidaPorRumo suprime SEM early-return mascarar os branches seguintes (achado do revisor final 31/07: supressao pos-hoc em route.ts nao dava chance dos branches SEGUINTES, incluindo o critico de foraTapeteStreak, serem avaliados -- detectarDesvio ja tinha retornado. Fix: o proprio detectarDesvio deixa de retornar cedo quando suprimido, e cai pros proximos branches normalmente)", () => {
    it("classeViariaSuprimidaPorRumo=true, nada mais bate: cai pro fallthrough (null), NAO retorna o alerta de classe_viaria", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorRumo: true,
        distDestinosM: [6300], distDestinosAnteriorM: [7000], // aproximando -- sem isso disparia classe_viaria
      });
      expect(a).toBeNull();
    });

    it("classeViariaSuprimidaPorRumo=false (ou ausente): dispara normal, comportamento de hoje intacto", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorRumo: false,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).not.toBeNull();
      expect(a?.origemDesvio).toBe("classe_viaria");
    });

    it("suprime SO o branch de classe_viaria -- afastando de tudo continua disparando (critico), a mesma protecao que ja existia pra saiuParadaConfirmadaRecentemente", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorRumo: true,
        distDestinosM: [6300, 8300, 12300], distDestinosAnteriorM: [6000, 8000, 12000], // afastando de tudo
      });
      expect(a?.nivel).toBe("critico"); // veio do branch de afastandoDeTudo, nao mascarado pela supressao
    });

    it("o achado real que motivou o fix: classe_viaria suprimido + fora do tapete (CRITICO) no MESMO ciclo -- antes da correcao, o early-return de classe_viaria nunca deixava esse critico ser avaliado; agora dispara", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorRumo: true,
        distDestinosM: [6300], distDestinosAnteriorM: [7000], // aproximando (nao afastando de tudo)
        dentroTapete: false, foraTapeteStreak: 10, familiarVeiculo: false,
      });
      expect(a).not.toBeNull();
      expect(a?.nivel).toBe("critico");
      expect(a?.origemDesvio).toBe("comportamental");
    });
  });

  describe("classeViariaSuprimidaPorEntrega suprime SEM early-return mascarar os branches seguintes (redesign 01/08 pos-revisao-independente: a 1a versao do gate suprimia DEPOIS da arbitragem em route.ts, com limiar numerico de placar -- Critical 1: limiar inalcancavel na pratica nesse branch; Critical 2: supressao pos-hoc mascarava os branches seguintes, o MESMO anti-padrao ja documentado/corrigido acima pra classeViariaSuprimidaPorRumo; Critical 3: `alerta = null` sem re-arbitrar descartava candidatos empatados. Fix: mesmo padrao de classeViariaSuprimidaPorRumo -- entra como INPUT do ctx, detectarDesvio cai pros proximos branches normalmente)", () => {
    it("classeViariaSuprimidaPorEntrega=true, nada mais bate: cai pro fallthrough (null), NAO retorna o alerta de classe_viaria", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorEntrega: true,
        distDestinosM: [6300], distDestinosAnteriorM: [7000], // aproximando -- sem isso disparia classe_viaria
      });
      expect(a).toBeNull();
    });

    it("classeViariaSuprimidaPorEntrega=false (ou ausente): dispara normal, comportamento de hoje intacto", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorEntrega: false,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).not.toBeNull();
      expect(a?.origemDesvio).toBe("classe_viaria");
    });

    it("suprime SO o branch de classe_viaria -- afastando de tudo continua disparando (critico), a mesma protecao que ja existia pra saiuParadaConfirmadaRecentemente/classeViariaSuprimidaPorRumo", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorEntrega: true,
        distDestinosM: [6300, 8300, 12300], distDestinosAnteriorM: [6000, 8000, 12000], // afastando de tudo
      });
      expect(a?.nivel).toBe("critico"); // veio do branch de afastandoDeTudo, nao mascarado pela supressao
    });

    it("Critical 2 do revisor, travado: classe_viaria suprimido + fora do tapete (CRITICO, \"caminho nunca percorrido\") no MESMO ciclo -- a supressao pos-hoc antiga nunca deixava esse branch ser avaliado (detectarDesvio ja tinha retornado classe_viaria primeiro); com o gate na deteccao, o fallthrough alcanca o branch critico normalmente", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorEntrega: true,
        distDestinosM: [6300], distDestinosAnteriorM: [7000], // aproximando (nao afastando de tudo)
        dentroTapete: false, foraTapeteStreak: 10, familiarVeiculo: false,
      });
      expect(a).not.toBeNull();
      expect(a?.nivel).toBe("critico");
      expect(a?.origemDesvio).toBe("comportamental");
      expect(a?.motivo).toContain("caminho que a frota nunca percorreu antes");
    });

    it("classeViariaSuprimidaPorRumo E classeViariaSuprimidaPorEntrega juntos (independentes, qualquer um basta pra suprimir): ainda cai pro fallthrough", () => {
      const a = detectarDesvio(emMov, {
        ...base, suspensoPorChegada: false, quedaClasseViaria: true,
        classeViariaSuprimidaPorRumo: true,
        classeViariaSuprimidaPorEntrega: true,
        distDestinosM: [6300], distDestinosAnteriorM: [7000],
      });
      expect(a).toBeNull();
    });
  });

  describe("deveMarcarSaidaParadaConfirmada (achado da revisao independente, Task 6: condicao de transicao nunca tinha teste proprio)", () => {
    const ctxBase = { fresco: true, alvosApiOk: true, saiuDoRaioAgora: true, dwellAnteriorSegundos: 120 };

    it("saiu do raio + dwell suficiente (parada de verdade): marca", () => {
      expect(deveMarcarSaidaParadaConfirmada(ctxBase)).toBe(true);
    });

    it("dwell insuficiente (so passou, nao parou): NAO marca -- achado da revisao, mutante que removia este check passava nos 504 testes antigos", () => {
      expect(deveMarcarSaidaParadaConfirmada({ ...ctxBase, dwellAnteriorSegundos: 30 })).toBe(false);
    });

    it("nao saiu do raio agora: nao marca", () => {
      expect(deveMarcarSaidaParadaConfirmada({ ...ctxBase, saiuDoRaioAgora: false })).toBe(false);
    });

    it("posicao nao fresca: nao marca (evita marcar saida com dado atrasado/travado)", () => {
      expect(deveMarcarSaidaParadaConfirmada({ ...ctxBase, fresco: false })).toBe(false);
    });

    it("API de alvos fora do ar: nao marca -- achado da revisao (blip na API fazia saiuDoRaioAgora disparar por tabela)", () => {
      expect(deveMarcarSaidaParadaConfirmada({ ...ctxBase, alvosApiOk: false })).toBe(false);
    });

    it("aceita limiar de dwell customizado", () => {
      expect(deveMarcarSaidaParadaConfirmada({ ...ctxBase, dwellAnteriorSegundos: 50, dwellMinimoSegundos: 40 })).toBe(true);
      expect(deveMarcarSaidaParadaConfirmada({ ...ctxBase, dwellAnteriorSegundos: 30, dwellMinimoSegundos: 40 })).toBe(false);
    });
  });
});

describe("detectarDesvio + Camada 3 (fora do tapete, RELIGADA em 12/07/2026 -- ver CAMADA3_TAPETE_ATIVA)", () => {
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
    familiarVeiculo: null as boolean | null,
    riscoAreaAtual: 0,
    suspensoPorChegada: false,
    divergenciaRumoStreak: 0,
    saiuDoRaioAgora: false,
    divergenciaGrausAtual: null as number | null,
    quedaClasseViaria: false,
    saiuParadaConfirmadaRecentemente: false,
  };
  const emMov2 = posicaoBase({ velocidade: 40 });

  it("fora do tapete por varias leituras, Camada 3 ATIVA (religada 12/07): dispara", () => {
    const a = detectarDesvio(emMov2, { ...baseAproximando, foraTapeteStreak: 8 });
    expect(a).not.toBeNull();
    expect(a?.motivo).toContain("nunca percorreu");
    expect(a?.origemDesvio).toBe("comportamental");
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

  it("veiculo familiar com a area (30+ celulas): NAO dispara com streak 3 (abaixo do limiar amortecido)", () => {
    const a = detectarDesvio(emMov2, {
      ...baseAproximando, foraTapeteStreak: 3, familiarVeiculo: true,
    });
    expect(a).toBeNull();
  });

  it("veiculo familiar com a area: dispara ao atingir o limiar amortecido (5)", () => {
    const a = detectarDesvio(emMov2, {
      ...baseAproximando, foraTapeteStreak: 5, familiarVeiculo: true,
    });
    expect(a).not.toBeNull();
    expect(a?.motivo).toContain("nunca percorreu");
  });

  it("veiculo SEM historico suficiente (familiarVeiculo null): usa o limiar padrao (2), nao o amortecido", () => {
    const a = detectarDesvio(emMov2, {
      ...baseAproximando, foraTapeteStreak: 2, familiarVeiculo: null,
    });
    expect(a).not.toBeNull();
  });

  it("veiculo explicitamente NAO familiar (familiarVeiculo false): usa o limiar padrao (2)", () => {
    const a = detectarDesvio(emMov2, {
      ...baseAproximando, foraTapeteStreak: 2, familiarVeiculo: false,
    });
    expect(a).not.toBeNull();
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

describe("montarCandidatosCore (candidatos crus, sem arbitrar -- extraido no fix do bug 12/07)", () => {
  it("avaliar() e equivalente a arbitrarCandidatos(montarCandidatosCore(...)) -- mesmo resultado", () => {
    const ctx = {
      ...ctxOp,
      distDestinosM: [6000, 9000],
      distDestinosAnteriorM: [5000, 8000],
      temPendentes: true,
      entregasFeitas: 3,
      desvioStreak: 4,
      afastamentoAcumuladoM: 1600,
    };
    const p = posicaoBase({ velocidade: 40 });
    expect(avaliar(p, ctx)).toEqual(arbitrarCandidatos(montarCandidatosCore(p, ctx)));
  });

  it("retorna os candidatos crus (nao arbitrados) -- jammer e desvio aparecem SEPARADOS quando ambos disparam", () => {
    const candidatos = montarCandidatosCore(
      posicaoBase({ ignicao: true, atraso: 60, velocidade: 40 }),
      {
        ...ctxOp,
        distDestinosM: [6000, 9000],
        distDestinosAnteriorM: [5000, 8000],
        temPendentes: true,
        entregasFeitas: 3,
        desvioStreak: 4,
        afastamentoAcumuladoM: 1600,
      }
    );
    expect(candidatos.some((c) => c.tipo === "jammer")).toBe(true);
    expect(candidatos.some((c) => c.tipo === "desvio")).toBe(true);
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

describe("detectarParadaSemMarcacao (achado real 28/07, cliente Nutry Max, caso TTM-7C13: parou 9min perto de cliente real mas fora do raio registrado, nenhum alerta disparou; redesenhado apos revisao independente BLOCK -- sinal de TRANSICAO na saida, mesmo padrao de detectarBypassEntrega, nao mais 'enquanto parado')", () => {
  const base: CtxParadaSemMarcacao = {
    saiuDaFaixaAgora: true,
    mesmoAlvoCodigo: true,
    dwellSegundosAcumulados: PARADA_SEM_MARCACAO_DWELL_MINIMO_SEGUNDOS + 30,
    entregaConfirmada: false,
  };

  it("saiu da faixa com dwell suficiente e sem confirmar entrega: dispara atencao", () => {
    const a = detectarParadaSemMarcacao(base);
    expect(a?.nivel).toBe("atencao");
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

describe("aplicarBonusClasseViaria", () => {
  const alertaBase = { nivel: "critico" as const, tipo: "desvio", motivo: "Afastando-se de tudo", score: 80 };

  it("sem alerta (null): continua null", () => {
    expect(aplicarBonusClasseViaria(null, true)).toBeNull();
  });

  it("alerta presente, quedaClasseViaria false: retorna o alerta intacto", () => {
    const r = aplicarBonusClasseViaria(alertaBase, false);
    expect(r).toEqual(alertaBase);
  });

  it("alerta presente, quedaClasseViaria true: soma o bonus ao score", () => {
    const r = aplicarBonusClasseViaria(alertaBase, true);
    expect(r?.score).toBe(95); // 80 + 15
    expect(r?.motivo).toContain("via principal");
  });

  it("bonus nao ultrapassa 100 (capado)", () => {
    const r = aplicarBonusClasseViaria({ ...alertaBase, score: 92 }, true);
    expect(r?.score).toBe(100);
  });
});

describe("aplicarBonusClasseViaria nao duplica quando origemDesvio ja e' classe_viaria", () => {
  it("alerta com origemDesvio=classe_viaria: nao aplica bonus de novo", () => {
    const alertaJaContado = { nivel: "atencao" as const, tipo: "desvio", motivo: "x", score: 40, origemDesvio: "classe_viaria" as const };
    const resultado = aplicarBonusClasseViaria(alertaJaContado, true);
    expect(resultado?.score).toBe(40); // sem bonus extra
    expect(resultado?.motivo).toBe("x"); // sem texto duplicado
  });

  it("alerta de OUTRA origem: continua aplicando o bonus normalmente (comportamento preexistente)", () => {
    const alertaOutraOrigem = { nivel: "critico" as const, tipo: "desvio", motivo: "y", score: 60, origemDesvio: "comportamental" as const };
    const resultado = aplicarBonusClasseViaria(alertaOutraOrigem, true);
    expect(resultado?.score).toBe(75);
  });
});

describe("montarContextoDesvio (achado 26/07: contexto expandido pra analise de falso positivo)", () => {
  const base = {
    desvioInicio: { lat: -22.9, lng: -43.2, ts: "2026-07-26T12:00:00.000Z", menor_dist_m: 500 },
    dentroTapete: false as boolean | null,
    corredorInfo: undefined as { veredito: string; bufferM: number } | undefined,
    distDestinosM: [6300, 8300],
    distDestinosAnteriorM: [6000, 8000],
    desvioStreak: 3,
    foraTapeteStreak: 2,
    divergenciaRumoStreak: 0,
    riscoAreaAtual: 15,
    familiarVeiculo: true as boolean | null,
    classeViaAtual: "estreita" as string | null,
    quedaClasseViaria: true,
    segmentoEspecifico: "corredor_veredito:fora" as string | null,
    taxaFp: 0.12 as number | undefined,
  };

  it("monta todos os campos esperados a partir do contexto do ciclo", () => {
    const c = montarContextoDesvio(base);
    expect(c.inicio_ts).toBe("2026-07-26T12:00:00.000Z");
    expect(c.fora_tapete).toBe(true);
    expect(c.dist_destinos_m).toEqual([6300, 8300]);
    expect(c.dist_destinos_anterior_m).toEqual([6000, 8000]);
    expect(c.desvio_streak).toBe(3);
    expect(c.fora_tapete_streak).toBe(2);
    expect(c.divergencia_rumo_streak).toBe(0);
    expect(c.risco_area_atual).toBe(15);
    expect(c.dentro_tapete).toBe(false);
    expect(c.familiar_veiculo).toBe(true);
    expect(c.classe_via_atual).toBe("estreita");
    expect(c.queda_classe_viaria).toBe(true);
    expect(c.calibracao).toEqual({ segmento: "corredor_veredito:fora", taxa_falso_positivo: 0.12 });
  });

  it("sem corredorInfo: nao inclui a chave corredor", () => {
    const c = montarContextoDesvio(base);
    expect(c).not.toHaveProperty("corredor");
  });

  it("com corredorInfo: inclui a chave corredor com o valor exato", () => {
    const c = montarContextoDesvio({ ...base, corredorInfo: { veredito: "fora", bufferM: 120 } });
    expect(c.corredor).toEqual({ veredito: "fora", bufferM: 120 });
  });

  it("sem segmentoEspecifico nem taxaFp: nao inclui a chave calibracao", () => {
    const c = montarContextoDesvio({ ...base, segmentoEspecifico: null, taxaFp: undefined });
    expect(c).not.toHaveProperty("calibracao");
  });

  it("dentroTapete=true: fora_tapete e false", () => {
    const c = montarContextoDesvio({ ...base, dentroTapete: true });
    expect(c.fora_tapete).toBe(false);
  });

  it("dentroTapete=null (sem tapete conhecido): fora_tapete e false, dentro_tapete e null", () => {
    const c = montarContextoDesvio({ ...base, dentroTapete: null });
    expect(c.fora_tapete).toBe(false);
    expect(c.dentro_tapete).toBeNull();
  });

  it("inclui o afastamento acumulado (menor_dist_m do desvioInicio) no contexto", () => {
    const ctx = montarContextoDesvio({
      desvioInicio: { lat: -22.9, lng: -43.2, ts: "2026-07-27T10:00:00.000Z", menor_dist_m: 5000 },
      dentroTapete: false,
      corredorInfo: undefined,
      distDestinosM: [8000],
      distDestinosAnteriorM: [7500],
      desvioStreak: 3,
      foraTapeteStreak: 0,
      divergenciaRumoStreak: 0,
      riscoAreaAtual: 0,
      familiarVeiculo: null,
      classeViaAtual: null,
      quedaClasseViaria: false,
      segmentoEspecifico: null,
      taxaFp: undefined,
    });
    expect(ctx.afastamento_acumulado_m).toBe(3000); // 8000 - 5000
  });
});

describe("desvioInicioEfetivoParaContexto (Task 3, REFEITO no Task 4b apos revisao independente: usa o anchor PROPRIO e sempre-real de rumo-diverge, ja nao sintetiza mais nada da posicao atual)", () => {
  const desvioInicioReal = { lat: -22.9, lng: -43.2, ts: "2026-07-28T11:55:00.000Z", menor_dist_m: 5000 };
  const divergenciaRumoInicioReal = { lat: -22.92, lng: -43.22, ts: "2026-07-28T11:58:00.000Z", menor_dist_m: 6300 };

  it("origemRumoDiverge=false (comportamental/cerca_virtual/etc.): retorna desvioInicio, ignora divergenciaRumoInicio (comportamento de hoje, inalterado)", () => {
    expect(desvioInicioEfetivoParaContexto(desvioInicioReal, false, divergenciaRumoInicioReal)).toBe(desvioInicioReal);
    expect(desvioInicioEfetivoParaContexto(null, false, divergenciaRumoInicioReal)).toBeNull();
  });

  it("origemRumoDiverge=true: retorna SEMPRE divergenciaRumoInicio, ignora desvioInicio (mesmo se este tambem estiver preenchido -- elimina a ambiguidade sintetico-vs-real achada pela revisao)", () => {
    expect(desvioInicioEfetivoParaContexto(desvioInicioReal, true, divergenciaRumoInicioReal)).toBe(divergenciaRumoInicioReal);
    expect(desvioInicioEfetivoParaContexto(null, true, divergenciaRumoInicioReal)).toBe(divergenciaRumoInicioReal);
  });

  it("origemRumoDiverge=true mas divergenciaRumoInicio null (nao deveria acontecer na pratica -- rumo-diverge so dispara com streak>=2, que garante o anchor -- defensivo): retorna null, NAO sintetiza mais nada da posicao atual", () => {
    expect(desvioInicioEfetivoParaContexto(desvioInicioReal, true, null)).toBeNull();
    expect(desvioInicioEfetivoParaContexto(null, true, null)).toBeNull();
  });

  // Step 6 (Task 4b): esta e' a REGRESSAO exata do achado CRITICO da revisao
  // independente. route.ts usa esta MESMA funcao pra decidir o `anchorCorredor`
  // que abre o gate de verificarCorredor (`... && anchorCorredor`, ver
  // route.ts). Antes do fix, o gate lia so desvioInicio (null neste cenario)
  // e a checagem de corredor NUNCA rodava pro caso exato que motivou a Task
  // 4 -- rumo-diverge disparando SEM nenhum episodio de "afastando de tudo"
  // (rodovia com curva, TTK-4D14: 84-88km/h, sem afastar de nada, so
  // divergindo em linha reta). Com o anchor proprio, o gate agora resolve
  // NAO-NULO neste cenario -- a checagem de corredor RODA de verdade.
  it("Step 6 -- cenario exato da Task 4 (TTK-4D14): rumo-diverge dispara SEM episodio de afastando-de-tudo (desvioInicio null); o anchor que abre o gate de verificarCorredor agora resolve NAO-NULO (antes do fix, o gate ficava morto)", () => {
    const desvioInicioAusente = null; // sem afastando-de-tudo em curso
    const anchorQueAbreOGate = desvioInicioEfetivoParaContexto(desvioInicioAusente, true, divergenciaRumoInicioReal);
    expect(anchorQueAbreOGate).not.toBeNull();
    expect(anchorQueAbreOGate).toBe(divergenciaRumoInicioReal);
  });

  it("o anchor real de rumo-diverge, passado pra montarContextoDesvio, preserva dist_destinos_m/divergencia_rumo_streak e calcula afastamento_acumulado_m a partir do anchor REAL (nao mais fixo em 0)", () => {
    const efetivo = desvioInicioEfetivoParaContexto(null, true, divergenciaRumoInicioReal)!;
    const ctx = montarContextoDesvio({
      desvioInicio: efetivo,
      dentroTapete: null,
      corredorInfo: undefined,
      distDestinosM: [6000, 9000],
      distDestinosAnteriorM: [7000, 9500],
      desvioStreak: 0,
      foraTapeteStreak: 0,
      divergenciaRumoStreak: 2,
      riscoAreaAtual: 0,
      familiarVeiculo: null,
      classeViaAtual: null,
      quedaClasseViaria: false,
      segmentoEspecifico: "origem:rumo_diverge",
      taxaFp: undefined,
    });
    expect(ctx.inicio_ts).toBe(divergenciaRumoInicioReal.ts);
    expect(ctx.afastamento_acumulado_m).toBe(6000 - divergenciaRumoInicioReal.menor_dist_m); // -300, real, nao mais 0 fixo
    expect(ctx.dist_destinos_m).toEqual([6000, 9000]);
    expect(ctx.dist_destinos_anterior_m).toEqual([7000, 9500]);
    expect(ctx.divergencia_rumo_streak).toBe(2);
    expect(ctx.calibracao).toEqual({ segmento: "origem:rumo_diverge", taxa_falso_positivo: -1 });
  });
});

// Step 6 (Task 4b): achado IMPORTANTE da revisao independente -- os
// vereditos "dentro"/"fora" da verificacao de corredor tem que mexer SO no
// streak/anchor da regra que efetivamente disparou o alerta verificado. Um
// alerta FRACO de rumo-diverge nao pode zerar/reescrever uma streak CRITICA
// de afastando-de-tudo em andamento em paralelo (e vice-versa).
describe("zerarStreakDaOrigemVencedora / reancorarOrigemVencedora (Task 4b, achado IMPORTANTE da revisao independente)", () => {
  const desvioInicioEmAndamento = { lat: -22.9, lng: -43.2, ts: "2026-07-28T11:50:00.000Z", menor_dist_m: 8000 };
  const divergenciaRumoInicioEmAndamento = { lat: -22.91, lng: -43.21, ts: "2026-07-28T11:58:00.000Z", menor_dist_m: 6300 };
  const estadoBase = {
    desvioStreak: 5,
    desvioInicio: desvioInicioEmAndamento,
    divergenciaRumoStreak: 3,
    divergenciaRumoInicio: divergenciaRumoInicioEmAndamento,
  };

  describe("zerarStreakDaOrigemVencedora (veredito 'dentro')", () => {
    it("origemRumoDiverge=true: zera SO divergenciaRumoStreak/divergenciaRumoInicio -- desvioStreak/desvioInicio (streak CRITICA de afastando-de-tudo em paralelo) ficam INTOCADOS", () => {
      const r = zerarStreakDaOrigemVencedora(true, estadoBase);
      expect(r.divergenciaRumoStreak).toBe(0);
      expect(r.divergenciaRumoInicio).toBeNull();
      expect(r.desvioStreak).toBe(5);
      expect(r.desvioInicio).toBe(desvioInicioEmAndamento);
    });

    it("origemRumoDiverge=false: zera SO desvioStreak/desvioInicio -- divergenciaRumoStreak/divergenciaRumoInicio (streak de rumo-diverge em paralelo) ficam INTOCADOS", () => {
      const r = zerarStreakDaOrigemVencedora(false, estadoBase);
      expect(r.desvioStreak).toBe(0);
      expect(r.desvioInicio).toBeNull();
      expect(r.divergenciaRumoStreak).toBe(3);
      expect(r.divergenciaRumoInicio).toBe(divergenciaRumoInicioEmAndamento);
    });
  });

  describe("reancorarOrigemVencedora (veredito 'fora')", () => {
    const novoAnchor = { lat: -22.95, lng: -43.25, ts: "2026-07-28T12:00:00.000Z", menor_dist_m: 4000 };

    it("origemRumoDiverge=true: reescreve SO divergenciaRumoInicio (nunca o streak em si) -- desvioStreak/desvioInicio ficam INTOCADOS", () => {
      const r = reancorarOrigemVencedora(true, estadoBase, novoAnchor);
      expect(r.divergenciaRumoInicio).toBe(novoAnchor);
      expect(r.divergenciaRumoStreak).toBe(3); // streak em si NUNCA mexido por este veredito
      expect(r.desvioStreak).toBe(5);
      expect(r.desvioInicio).toBe(desvioInicioEmAndamento);
    });

    it("origemRumoDiverge=false: reescreve SO desvioInicio -- divergenciaRumoStreak/divergenciaRumoInicio ficam INTOCADOS", () => {
      const r = reancorarOrigemVencedora(false, estadoBase, novoAnchor);
      expect(r.desvioInicio).toBe(novoAnchor);
      expect(r.desvioStreak).toBe(5);
      expect(r.divergenciaRumoStreak).toBe(3);
      expect(r.divergenciaRumoInicio).toBe(divergenciaRumoInicioEmAndamento);
    });
  });
});

describe("viradaErradaSaindoDeParada (achado 26/07, Fase 2: dispara com 1 leitura so saindo de parada)", () => {
  it("saiu do raio agora + divergencia bem acima do limiar (150): dispara", () => {
    expect(viradaErradaSaindoDeParada(true, 150)).toBe(true);
  });

  it("exatamente no limiar (140): NAO dispara (estrito >, nao >=)", () => {
    expect(viradaErradaSaindoDeParada(true, 140)).toBe(false);
  });

  it("saiu do raio agora mas divergencia baixa (rumo ok, ex: 50): nao dispara", () => {
    expect(viradaErradaSaindoDeParada(true, 50)).toBe(false);
  });

  it("NAO saiu do raio agora (fora da janela estreita), mesmo com divergencia altissima (179): nao dispara", () => {
    expect(viradaErradaSaindoDeParada(false, 179)).toBe(false);
  });

  it("divergencia null (velocidade abaixo do piso, ou bloqueada por guard de GPS congelado/salto implausivel): nao dispara mesmo saindo do raio", () => {
    expect(viradaErradaSaindoDeParada(true, null)).toBe(false);
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

describe("deveAutoResolverAfastandoRotaConcluida", () => {
  const tudoOk = {
    rotaConcluida: true,
    baseOcupada: true,
    baseElegivelAutoResolve: true,
    paradoMin: AFASTANDO_ROTA_CONCLUIDA_PARADO_MIN_MIN,
  };

  it("resolve quando rota concluida, chegou na base, base e' pequena o suficiente E ja parou de verdade", () => {
    expect(deveAutoResolverAfastandoRotaConcluida(tudoOk)).toBe(true);
  });
  it("NAO resolve se rota nao concluida (mesmo na base)", () => {
    expect(deveAutoResolverAfastandoRotaConcluida({ ...tudoOk, rotaConcluida: false })).toBe(false);
  });
  it("NAO resolve se ainda nao chegou na base (mesmo com rota concluida) -- protege contra mascarar coacao", () => {
    expect(deveAutoResolverAfastandoRotaConcluida({ ...tudoOk, baseOcupada: false })).toBe(false);
  });
  // FIX 1 (revisao independente 27/07, achado severo): Base Benassi —
  // CEASA-RJ e' um mercado publico de ~739 mil m² com vias reais e 96
  // veiculos distintos passando por dentro -- "dentro do poligono" la nao
  // significa "chegou numa instalacao segura". baseElegivelAutoResolve=false
  // representa esse caso (base grande demais, ver
  // BASE_AREA_MAX_M2_AUTORESOLVE_AFASTANDO) e tem que bloquear sozinho.
  it("NAO resolve se a base ocupada e' grande demais pra ser considerada patio fechado (ex.: CEASA-RJ)", () => {
    expect(deveAutoResolverAfastandoRotaConcluida({ ...tudoOk, baseElegivelAutoResolve: false })).toBe(false);
  });
  // FIX 2 (revisao independente 27/07): sem exigir parada de verdade, um
  // veiculo apenas TRANSITANDO pela base a qualquer velocidade satisfazia a
  // condicao antiga. paradoMin abaixo do minimo representa esse caso.
  it("NAO resolve se o veiculo ainda nao parou o suficiente (so transitou pela base)", () => {
    expect(
      deveAutoResolverAfastandoRotaConcluida({ ...tudoOk, paradoMin: AFASTANDO_ROTA_CONCLUIDA_PARADO_MIN_MIN - 1 })
    ).toBe(false);
  });
  it("NAO resolve com paradoMin=0 (veiculo em movimento)", () => {
    expect(deveAutoResolverAfastandoRotaConcluida({ ...tudoOk, paradoMin: 0 })).toBe(false);
  });
});

// Achado real 03/08 (KYK-8G07: 7 disparos do mesmo alerta num unico dia,
// fila de ativos reenchendo de 0 pra 84-85 em <24h) -- SEGUNDO caso de
// auto-resolucao de "afastando-se de todos", chegada real PARCIAL/mid-route
// (nao precisa esperar a rota inteira terminar, diferente do irmao acima).
describe("deveAutoResolverAfastandoChegadaReal", () => {
  // Achado CRITICO da revisao independente 03/08: o campo chama-se
  // "chegouEmDestino" (nao "suspensoPorChegada") de proposito -- o caller
  // (route.ts) tem que passar o calculo SEM o curto-circuito de
  // ponto_seguro (posto de gasolina), senao qualquer parada de 2min num dos
  // ~1.115 postos do RJ fecha um desvio confirmado sem nenhuma relacao com
  // a rota (caso real SRQ-9F05: 52km de afastamento, parou 3min num posto a
  // 124km da base). Este teste so cobre a aritmetica do predicado; a
  // exclusao de ponto_seguro em si vive em route.ts (chegouEmDestinoConhecido).
  it("NAO resolve se nao chegou de verdade (chegouEmDestino=false)", () => {
    expect(
      deveAutoResolverAfastandoChegadaReal({ chegouEmDestino: false, paradoMin: 10 })
    ).toBe(false);
  });
  it("NAO resolve se chegou mas ainda nao parou o suficiente (paradoMin=1)", () => {
    expect(
      deveAutoResolverAfastandoChegadaReal({ chegouEmDestino: true, paradoMin: 1 })
    ).toBe(false);
  });
  it("resolve no limiar exato (paradoMin=2)", () => {
    expect(
      deveAutoResolverAfastandoChegadaReal({ chegouEmDestino: true, paradoMin: AFASTANDO_CHEGADA_REAL_PARADO_MIN_MIN })
    ).toBe(true);
  });
  it("resolve com parada bem acima do minimo (paradoMin=10)", () => {
    expect(
      deveAutoResolverAfastandoChegadaReal({ chegouEmDestino: true, paradoMin: 10 })
    ).toBe(true);
  });
});

describe("elegivelParaAutoResolveAfastando (wiring)", () => {
  it("exige tipo desvio, motivo 'Afastando-se de todos', status ativo", () => {
    const base = { tipo: "desvio", motivo: "Afastando-se de todos os 5 destinos há 3 leituras seguidas (~3min), +1,0km acumulado", status: "ativo" };
    expect(elegivelParaAutoResolveAfastando(base)).toBe(true);
    expect(elegivelParaAutoResolveAfastando({ ...base, status: "reconhecido" })).toBe(false);
    expect(elegivelParaAutoResolveAfastando({ ...base, tipo: "parada_fora_tapete" })).toBe(false);
    expect(elegivelParaAutoResolveAfastando({ ...base, motivo: "Direção do movimento diverge da rota esperada" })).toBe(false);
  });
});

describe("elegivelParaAnotarPlacarSombra (anotação do placar sombra no card)", () => {
  const base = { tipo: "desvio", motivo: "Afastando-se de todos os 3 destinos", status: "ativo" };

  it("motivo afastando_de_tudo, ativo, tipo desvio: elegivel", () => {
    expect(elegivelParaAnotarPlacarSombra(base)).toBe(true);
  });

  it("motivo rua estranha exato, ativo, tipo desvio: elegivel", () => {
    expect(elegivelParaAnotarPlacarSombra({ ...base, motivo: MOTIVO_RUA_ESTRANHA })).toBe(true);
  });

  it("motivo de corredor (fora da rota esperada): nao elegivel", () => {
    expect(elegivelParaAnotarPlacarSombra({ ...base, motivo: "Fora da rota esperada (500m da estrada real até o próximo ponto, buffer 120m)" })).toBe(false);
  });

  it("status resolvido: nao elegivel mesmo com motivo certo", () => {
    expect(elegivelParaAnotarPlacarSombra({ ...base, status: "falso_positivo" })).toBe(false);
  });

  it("tipo diferente de desvio: nao elegivel mesmo com motivo certo", () => {
    expect(elegivelParaAnotarPlacarSombra({ ...base, tipo: "parada_fora_tapete" })).toBe(false);
  });
});

describe("origemMenorDistDestinoM (fix round 2, achado da re-review do fix round 1: origem REAL do desvio, nao o instante de criacao do alerta)", () => {
  it("contexto com dist_destinos_m e afastamento_acumulado_m: retorna o minimo do array MENOS o acumulado", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: [6300, 8300, 4100], afastamento_acumulado_m: 1500 })).toBe(2600);
  });

  it("afastamento_acumulado_m negativo (veiculo ja se aproximava antes do alerta nascer): soma em vez de subtrair", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: [4100], afastamento_acumulado_m: -300 })).toBe(4400);
  });

  it("afastamento_acumulado_m zero (alerta nasceu no exato instante do desvio comecar): equivale ao minimo puro", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: [6300, 4100], afastamento_acumulado_m: 0 })).toBe(4100);
  });

  it("array com 1 elemento: retorna esse elemento menos o acumulado", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: [500], afastamento_acumulado_m: 100 })).toBe(400);
  });

  it("contexto null: retorna null (nao 0)", () => {
    expect(origemMenorDistDestinoM(null)).toBeNull();
  });

  it("contexto sem a chave dist_destinos_m (alerta antigo, ex: classe_viaria): retorna null", () => {
    expect(origemMenorDistDestinoM({ classe_via_atual: "estreita" })).toBeNull();
  });

  it("dist_destinos_m array vazio: retorna null", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: [], afastamento_acumulado_m: 0 })).toBeNull();
  });

  it("dist_destinos_m nao e array (formato inesperado): retorna null", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: "6300", afastamento_acumulado_m: 0 })).toBeNull();
  });

  it("dist_destinos_m com elemento nao-numerico: retorna null (nao explode nem mente)", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: [6300, null, 4100], afastamento_acumulado_m: 0 })).toBeNull();
  });

  it("contexto nao e objeto (string/numero): retorna null", () => {
    expect(origemMenorDistDestinoM("nao-objeto")).toBeNull();
    expect(origemMenorDistDestinoM(42)).toBeNull();
  });

  it("dist_destinos_m valido mas afastamento_acumulado_m ausente (alerta anterior ao fix round 1): retorna null, nao 0", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: [6300, 4100] })).toBeNull();
  });

  it("afastamento_acumulado_m com tipo invalido (string, NaN): retorna null", () => {
    expect(origemMenorDistDestinoM({ dist_destinos_m: [4100], afastamento_acumulado_m: "1500" })).toBeNull();
    expect(origemMenorDistDestinoM({ dist_destinos_m: [4100], afastamento_acumulado_m: NaN })).toBeNull();
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

describe("razaoRetidaoRumo", () => {
  it("calcula a razão caminho/líquido normalmente", () => {
    expect(razaoRetidaoRumo(22944, 19521)).toBeCloseTo(1.1753, 3);
  });

  it("retorna null quando o deslocamento líquido é menor que o piso mínimo", () => {
    expect(razaoRetidaoRumo(2829, 100)).toBeNull();
  });

  it("aceita o piso mínimo exato (não é 'menor que')", () => {
    expect(razaoRetidaoRumo(200, RETIDAO_RUMO_LIQUIDO_MINIMO_M)).toBe(1);
  });

  it("caso real TTI-6D27 (desvio confirmado manualmente): razão alta", () => {
    expect(razaoRetidaoRumo(7720, 2461)).toBeCloseTo(3.1373, 3);
  });

  it("caso real TUL-1H29 (falso positivo de rodovia): razão baixa", () => {
    expect(razaoRetidaoRumo(25767, 25319)).toBeCloseTo(1.0177, 3);
  });
});

describe("limiarRazaoRetidaoRumo", () => {
  it("usa o limiar de destino curto abaixo de 10km", () => {
    expect(limiarRazaoRetidaoRumo(2505)).toBe(1.9);
  });

  it("usa o limiar de destino longo a partir de 10km (inclusive)", () => {
    expect(limiarRazaoRetidaoRumo(10_000)).toBe(1.4);
  });

  it("usa o limiar de destino longo bem acima de 10km", () => {
    expect(limiarRazaoRetidaoRumo(33_113)).toBe(1.4);
  });
});

describe("montarContextoDesvio — retidao_rumo_sombra", () => {
  it("inclui retidao_rumo_sombra quando fornecido", () => {
    const ctx = montarContextoDesvio({
      desvioInicio: { lat: -22.9, lng: -43.2, ts: "2026-07-30T12:00:00.000Z", menor_dist_m: 5000 },
      dentroTapete: null,
      distDestinosM: [4800],
      distDestinosAnteriorM: [5000],
      desvioStreak: 0,
      foraTapeteStreak: 0,
      divergenciaRumoStreak: 2,
      riscoAreaAtual: 0,
      familiarVeiculo: null,
      classeViaAtual: null,
      quedaClasseViaria: false,
      segmentoEspecifico: null,
      taxaFp: undefined,
      retidaoRumoSombra: {
        caminhoM: 6478, liquidoM: 4677, razao: 1.385, limiar: 1.4, veredito_suprimiria: true,
      },
    });
    expect(ctx.retidao_rumo_sombra).toEqual({
      caminho_m: 6478, liquido_m: 4677, razao: 1.385, limiar: 1.4, veredito_suprimiria: true,
    });
  });

  it("omite retidao_rumo_sombra quando não fornecido (undefined) ou null", () => {
    const base = {
      desvioInicio: { lat: -22.9, lng: -43.2, ts: "2026-07-30T12:00:00.000Z", menor_dist_m: 5000 },
      dentroTapete: null,
      distDestinosM: [4800],
      distDestinosAnteriorM: [5000],
      desvioStreak: 0,
      foraTapeteStreak: 0,
      divergenciaRumoStreak: 2,
      riscoAreaAtual: 0,
      familiarVeiculo: null,
      classeViaAtual: null,
      quedaClasseViaria: false,
      segmentoEspecifico: null,
      taxaFp: undefined,
    };
    expect(montarContextoDesvio(base)).not.toHaveProperty("retidao_rumo_sombra");
    expect(montarContextoDesvio({ ...base, retidaoRumoSombra: null })).not.toHaveProperty("retidao_rumo_sombra");
  });
});

describe("rumoCoerenteComDestino", () => {
  it("divergencia baixa (rumo alinhado com o destino): coerente, suprimiria", () => {
    expect(rumoCoerenteComDestino(10, 100)).toBe(true);
  });

  it("divergencia exatamente no limiar: coerente (inclusive)", () => {
    expect(rumoCoerenteComDestino(100, 100)).toBe(true);
  });

  it("divergencia acima do limiar: nao coerente, mantem o alerta", () => {
    expect(rumoCoerenteComDestino(150, 100)).toBe(false);
  });

  it("divergencia null (sem sinal confiavel): mantem o alerta -- erra pro lado seguro", () => {
    expect(rumoCoerenteComDestino(null, 100)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// POLITICA DE PRODUCAO desde 01/08: DESVIO_SO_AFASTANDO_OU_FORA_DO_TAPETE
//
// Regra do usuario, textual: "ta se afastando dos clientes, e desvio. ta
// indo em direcao, nao e desvio. mas pode nao estar se afastando e estar
// indo pra um lugar sem sentido -- ai e desvio."
//
// Duas condicoes disparam, e SO elas. Estes testes rodam SEM override,
// exercitando o default real de producao.
// ───────────────────────────────────────────────────────────────────────
describe("politica de producao 01/08: so afastando-de-todos ou lugar-sem-sentido", () => {
  // Veiculo APROXIMANDO de todos os destinos (distancia caindo) -- pela
  // regra do usuario, isso nao e desvio, aconteca o que acontecer.
  const aproximando = {
    distDestinosM: [5000, 7000, 11000],
    distDestinosAnteriorM: [6000, 8000, 12000],
    temPendentes: true,
    emOperacao: true,
    foraDaBase: true,
    entregasFeitas: 2,
    streak: 0,
    afastamentoAcumuladoM: 0,
    dentroTapete: null as boolean | null,
    familiarVeiculo: null as boolean | null,
    riscoAreaAtual: 0,
    foraTapeteStreak: 0,
    suspensoPorChegada: false,
    divergenciaRumoStreak: 0,
    saiuDoRaioAgora: false,
    divergenciaGrausAtual: null as number | null,
    quedaClasseViaria: false,
    saiuParadaConfirmadaRecentemente: false,
  };
  const emMov = posicaoBase({ velocidade: 40 });

  it("rua estreita RELIGADA em 03/08: sem prova de entrega (D1/D3) no ciclo, dispara normal", () => {
    // Achado 03/08: no mes inteiro de clique individual, rua estreita
    // sozinha pegou 16 casos REAIS confirmados (incluindo RQV-6C22 e
    // TUC-1D15, os que o cliente confirmou por telefone) -- desligar ela
    // junto com rumo_diverge/saida_parada (so 1 e 0 reais) jogou fora sinal
    // de verdade sem necessidade. Volta a disparar, mas continua filtrada
    // pelo D1/D3 (proximo teste).
    const a = detectarDesvio(emMov, { ...aproximando, quedaClasseViaria: true });
    expect(a).not.toBeNull();
    expect(a?.tipo).toBe("desvio");
    expect(a?.origemDesvio).toBe("classe_viaria");
  });

  it("rua estreita COM prova de entrega (classeViariaSuprimidaPorEntrega=true): continua suprimida", () => {
    expect(
      detectarDesvio(emMov, { ...aproximando, quedaClasseViaria: true, classeViariaSuprimidaPorEntrega: true })
    ).toBeNull();
  });

  it("direcao divergente indo em direcao ao cliente: NAO e desvio (era 37 alertas/3 dias, ZERO marcado real)", () => {
    expect(detectarDesvio(emMov, { ...aproximando, divergenciaRumoStreak: 5 })).toBeNull();
  });

  it("virada errada saindo de parada, indo em direcao: NAO e desvio", () => {
    expect(
      detectarDesvio(emMov, { ...aproximando, saiuDoRaioAgora: true, divergenciaGrausAtual: 150 })
    ).toBeNull();
  });

  it("CONDICAO 1 -- afastando de TODOS os destinos com streak>=2: E desvio", () => {
    const a = detectarDesvio(emMov, {
      ...aproximando,
      distDestinosM: [6000, 8000, 12000],
      distDestinosAnteriorM: [5000, 7000, 11000],
      streak: 2,
      afastamentoAcumuladoM: 300,
      dentroTapete: true,
    });
    expect(a).not.toBeNull();
    expect(a?.tipo).toBe("desvio");
  });

  it("CONDICAO 2 -- lugar sem sentido: aproximando MAS por caminho que a frota nunca percorreu: E desvio (critico)", () => {
    const a = detectarDesvio(emMov, { ...aproximando, foraTapeteStreak: 3 });
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("critico");
    expect(a?.motivo).toContain("caminho que a frota nunca percorreu");
  });

  it("reversibilidade: desvioSoAfastandoOuForaDoTapete continua controlando rumo_diverge (classe_viaria religada 03/08 nao depende mais desta flag)", () => {
    // rumo_diverge so teve 1 caso real no mes inteiro (97% falso) --
    // CONTINUA desligada por padrao. false restaura o comportamento antigo
    // pra quem precisar comparar/depurar.
    expect(detectarDesvio(emMov, { ...aproximando, divergenciaRumoStreak: 5 })).toBeNull();
    const a = detectarDesvio(emMov, {
      ...aproximando,
      divergenciaRumoStreak: 5,
      desvioSoAfastandoOuForaDoTapete: false,
    });
    expect(a?.origemDesvio).toBe("rumo_diverge");
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
