// Cenarios sinteticos de desvio de rota — simulacao de sequencias MULTI-CICLO
// (nao so parametros isolados como em detectores.test.ts), usando haversineM
// real e coordenadas reais do Rio de Janeiro. Objetivo: injetar desvio
// sintetico num trajeto plausivel e medir em quantos ciclos o detector reage
// (ou nao reage, nos casos que NAO devem disparar) — pratica de validacao
// recomendada pela pesquisa 07/07 (injecao sintetica / red-team) quando nao
// ha historico rotulado de roubo real suficiente pra backtest formal.
//
// Nao mexe em banco de dados — funcoes puras, dado 100% sintetico.
import { describe, it, expect } from "vitest";
import { detectarDesvio, afastouDeTudo, avancarStreaksDesvio, calcularRiscoArea, type CtxDesvio } from "./detectores";
import { haversineM } from "./unitrac";
import type { PosicaoNormalizada } from "./unitrac";

function posicaoBase(overrides: Partial<PosicaoNormalizada> = {}): PosicaoNormalizada {
  return {
    cv: "9999", placa: "SIM-0001", lat: 0, lng: 0, velocidade: 40,
    ignicao: true, atraso: 0, fresco: true, panico: false, situacao: 0,
    ...overrides,
  } as PosicaoNormalizada;
}

// Coordenadas reais usadas como ancora nos cenarios (nao sao segredo, sao
// bairros publicos do Rio ja citados na pesquisa/sessao).
const MANGUINHOS = { lat: -22.8698, lng: -43.2358 };
const REALENGO = { lat: -22.8797, lng: -43.4356 };
const JACAREPAGUA = { lat: -22.9647, lng: -43.3648 };
const BASE_NUTRY = { lat: -22.9256, lng: -43.2311 }; // ponto de partida generico

type Ciclo = {
  lat: number; lng: number; velocidade?: number;
  dentroTapete?: boolean | null; riscoAreaAtual?: number;
  foraTapeteStreak?: number;
};

// Ponto a "passo" graus de distancia de origem, na direcao que se AFASTA de
// destino (extrapola o vetor destino->origem) — evita erro de "chutar" lat/lng
// a mao sem checar se o rumo realmente afasta do destino (bug real encontrado
// aqui: MANGUINHOS->REALENGO por exemplo NAO e na direcao lat-0.01/lng-0.01).
function afastarDe(origem: { lat: number; lng: number }, destino: { lat: number; lng: number }, passo: number) {
  const dLat = origem.lat - destino.lat;
  const dLng = origem.lng - destino.lng;
  const mag = Math.sqrt(dLat * dLat + dLng * dLng) || 1;
  return { lat: origem.lat + (dLat / mag) * passo, lng: origem.lng + (dLng / mag) * passo };
}

// Ponto a "fracao" (0..1+) do caminho de origem ate destino — garante reducao
// monotonica de distancia a destino, sem precisar calcular ponto medio a mao.
function aproximarDe(origem: { lat: number; lng: number }, destino: { lat: number; lng: number }, fracao: number) {
  return { lat: origem.lat + (destino.lat - origem.lat) * fracao, lng: origem.lng + (destino.lng - origem.lng) * fracao };
}

// Simula uma sequencia de ciclos do motor pra UM veiculo indo em direcao a
// UM destino fixo, acumulando streak/afastamento com a HISTERESE REAL
// (avancarStreaksDesvio) -- mesma funcao pura usada por route.ts, nao mais
// uma reimplementacao simplificada. Achado real 10/07 (auditoria de teste):
// a versao anterior zerava o streak na hora ao primeiro sinal de
// aproximacao, diferente da producao (so 2 leituras CONSECUTIVAS zeram, 1
// isolada congela) -- os "cenarios reais" deste arquivo nao validavam a
// historese de verdade. Em memoria, sem tocar em banco nem em Supabase.
function simular(destino: { lat: number; lng: number }, ciclos: Ciclo[]): (ReturnType<typeof detectarDesvio>)[] {
  let desvioStreak = 0;
  let aproximandoStreak = 0;
  let menorDistInicio = 0;
  let anteriorDist: number[] | null = null;
  const resultados: ReturnType<typeof detectarDesvio>[] = [];

  for (const c of ciclos) {
    const velocidade = c.velocidade ?? 40;
    const distDestinosM = [haversineM(c.lat, c.lng, destino.lat, destino.lng)];

    if (anteriorDist && velocidade > 0) {
      const r = avancarStreaksDesvio(afastouDeTudo(distDestinosM, anteriorDist), { desvioStreak, aproximandoStreak });
      if (r.desvioStreak === 1 && desvioStreak === 0) {
        menorDistInicio = Math.min(...anteriorDist);
      }
      desvioStreak = r.desvioStreak;
      aproximandoStreak = r.aproximandoStreak;
    }
    const menorAgora = Math.min(...distDestinosM);
    const afastamentoAcumuladoM = desvioStreak > 0 ? menorAgora - menorDistInicio : 0;

    const ctx: CtxDesvio = {
      distDestinosM,
      distDestinosAnteriorM: anteriorDist ?? [],
      temPendentes: true,
      emOperacao: true,
      foraDaBase: true,
      entregasFeitas: 2,
      streak: desvioStreak,
      afastamentoAcumuladoM,
      dentroTapete: c.dentroTapete ?? null,
      riscoAreaAtual: c.riscoAreaAtual ?? 0,
      foraTapeteStreak: c.foraTapeteStreak ?? 0,
    };
    resultados.push(detectarDesvio(posicaoBase({ velocidade }), ctx));
    anteriorDist = distDestinosM;
  }
  return resultados;
}

describe("cenarios sinteticos de desvio — trajeto real perturbado (validacao sem dataset rotulado)", () => {
  it("ENTREGA NORMAL: caminho reto ate o destino, nunca dispara em nenhum ciclo", () => {
    // 5 pontos interpolados entre Manguinhos e Realengo, se aproximando sempre.
    const ciclos: Ciclo[] = Array.from({ length: 5 }, (_, i) => {
      const t = i / 4;
      return {
        lat: MANGUINHOS.lat + (REALENGO.lat - MANGUINHOS.lat) * t,
        lng: MANGUINHOS.lng + (REALENGO.lng - MANGUINHOS.lng) * t,
        dentroTapete: true,
      };
    });
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("DESVIO INJETADO em via conhecida, area SEM risco: dispara devagar (score 45, depois 68 com streak 4)", () => {
    // Vai se afastando do destino por 5 ciclos seguidos (desvio sustentado).
    const ciclos: Ciclo[] = Array.from({ length: 5 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: true,
      riscoAreaAtual: 0,
    }));
    const resultados = simular(REALENGO, ciclos);
    // indice 0: streak 0 (baseline, sem anterior). indice 1: streak 1 (ainda
    // nao dispara, exige >=2). indice 2: streak 2 (1o disparo). indice 4: streak 4.
    expect(resultados[0]).toBeNull();
    expect(resultados[1]).toBeNull();
    expect(resultados[2]?.score).toBe(45); // streak 2
    expect(resultados[4]?.score).toBe(68); // streak 4
  });

  it("fora do tapete, mas CAMADA3_TAPETE_ATIVA=false: nao escala, segue escalonamento normal (score 45)", () => {
    // Achado real 10/07: este branch escalava pra 80 mesmo com a Camada 3
    // "desativada" -- o mesmo sintoma do incidente de 09/07 (mesmo motivo,
    // mesma origem de dado) sobrevivia por nao estar atras da flag.
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: false,
      riscoAreaAtual: 0,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[2]?.score).toBe(45); // streak chega a 2 no indice 2
    expect(resultados[2]?.motivo).not.toContain("fora de via conhecida");
  });

  it("DESVIO INJETADO em via CONHECIDA mas area de risco alto: dispara IMEDIATO (score 80) — o caso que o v4 antigo perdia", () => {
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: JACAREPAGUA.lat - i * 0.01,
      lng: JACAREPAGUA.lng - i * 0.01,
      dentroTapete: true, // via CONHECIDA
      riscoAreaAtual: 55, // favela + tiroteio, por exemplo
    }));
    const resultados = simular(BASE_NUTRY, ciclos);
    expect(resultados[2]?.score).toBe(80);
    expect(resultados[2]?.motivo).toContain("área de risco elevado");
  });

  it("PONTO CEGO do gatilho por AFASTAMENTO (identificado pela pesquisa): caminho indireto (fora do tapete) mas que se aproxima do destino a cada ciclo NAO dispara so por afastamento", () => {
    // Fracoes crescentes de 0 a 1 no caminho MANGUINHOS->REALENGO: cada ciclo
    // fica estritamente mais perto do destino que o anterior (verificado
    // abaixo), mesmo com dentroTapete=false no meio do caminho — o gatilho
    // por afastamento (v4) nao pega isso por design (so reage a quem se
    // afasta de TUDO). Este cenario nao passa foraTapeteStreak (fica 0),
    // entao a Camada 3 (ver describe "foraTapeteStreak" abaixo) tambem fica
    // inativa aqui de proposito — o objetivo deste teste e isolar so o
    // mecanismo de afastamento.
    const fracoes = [0, 0.3, 0.6, 1.0];
    const pontos = fracoes.map(f => aproximarDe(MANGUINHOS, REALENGO, f));
    // Confirma a premissa do cenario antes de testar o detector: cada ponto
    // tem que estar mais perto de REALENGO que o anterior.
    for (let i = 1; i < pontos.length; i++) {
      const distAnterior = haversineM(pontos[i - 1].lat, pontos[i - 1].lng, REALENGO.lat, REALENGO.lng);
      const distAgora = haversineM(pontos[i].lat, pontos[i].lng, REALENGO.lat, REALENGO.lng);
      expect(distAgora).toBeLessThan(distAnterior);
    }
    const ciclos: Ciclo[] = pontos.map((p, i) => ({ ...p, dentroTapete: i === 0 || i === 3 ? true : false }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("CORRECAO DE ROTA: ciclo se afastando, depois volta a se aproximar — streak nao dispara (poucos ciclos pra completar a historese)", () => {
    // Com a historese real (avancarStreaksDesvio), 1 aproximacao isolada
    // CONGELA o streak em vez de zerar -- mas com so 3 ciclos aqui, o streak
    // nunca chega a 2 de qualquer forma (congelado em 1). O teste dedicado
    // de historese abaixo ("cenario de serra via simular()") e o que prova
    // a diferenca de comportamento com mais ciclos.
    const ciclos: Ciclo[] = [
      { ...MANGUINHOS, dentroTapete: true },
      { ...afastarDe(MANGUINHOS, REALENGO, 0.01), dentroTapete: true }, // afasta (streak=1, ainda nao dispara)
      { ...afastarDe(MANGUINHOS, REALENGO, 0.005), dentroTapete: true }, // se aproxima de novo (metade do afastamento anterior) -> congela em 1
    ];
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("cenario de serra via simular(): 1 aproximacao isolada (curva) NAO reseta o streak -- dispara 1 ciclo mais cedo do que a reimplementacao simplificada disparava", () => {
    // Achado real 09/07 (docs/analise-deteccao.md secao 5): em estrada de
    // serra a distancia em linha reta oscila a cada curva. A reimplementacao
    // simplificada que este arquivo usava ate 10/07 zerava o streak nesse
    // ciclo 2, exigindo 2 ciclos NOVOS de afastamento pra disparar de novo
    // (so no ciclo 4). Com a historese real, o streak congela no ciclo 2 e
    // so precisa de MAIS 1 ciclo de afastamento pra disparar -- no ciclo 3.
    const ciclos: Ciclo[] = [
      { ...MANGUINHOS, dentroTapete: true },                              // 0: baseline
      { ...afastarDe(MANGUINHOS, REALENGO, 0.01), dentroTapete: true },   // 1: afasta -> streak 1
      { ...afastarDe(MANGUINHOS, REALENGO, 0.007), dentroTapete: true },  // 2: curva (mais perto que o ciclo 1) -> congela em 1, NAO zera
      { ...afastarDe(MANGUINHOS, REALENGO, 0.02), dentroTapete: true },   // 3: afasta de novo -> streak 2, DISPARA aqui
    ];
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[1]).toBeNull();
    expect(resultados[2]).toBeNull(); // congelado em 1, ainda nao dispara
    expect(resultados[3]?.score).toBe(45); // streak chegou a 2 -- deteccao rapida, nao atrasada
  });

  it("RUIDO DE GPS de 1 ciclo isolado (jitter): nao acumula streak suficiente, nao dispara", () => {
    const ciclos: Ciclo[] = [
      { ...MANGUINHOS, dentroTapete: true },
      { ...afastarDe(MANGUINHOS, REALENGO, 0.003), dentroTapete: true }, // 1 ciclo de ruido (afasta um pouco)
      { ...aproximarDe(MANGUINHOS, REALENGO, 0.02), dentroTapete: true }, // volta a se aproximar do destino
    ];
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("VEICULO PARADO durante o desvio aparente: nunca dispara (velocidade=0)", () => {
    const ciclos: Ciclo[] = Array.from({ length: 4 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      velocidade: 0, dentroTapete: false, riscoAreaAtual: 80,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("SINAIS FRACOS COMBINADOS amplificados pelo fator horario cruzam o limiar 40 (corredor 20 + CISP medio 10 = 30, x1.6 = 48): dispara imediato", () => {
    const score = calcularRiscoArea({
      emFavela: false,
      tiroteioRecentePertoM: null,
      rouboCargaCispTotal: 5, // medio (>0, <15)
      emCorredorRodoviaRisco: true,
      fatorHorario: 1.6, // hora de maior risco historico (Fogo Cruzado)
    });
    expect(score).toBe(48); // (20+10) * 1.6 — multiplicativo, nao bonus fixo
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: JACAREPAGUA.lat - i * 0.01, lng: JACAREPAGUA.lng - i * 0.01,
      dentroTapete: true, riscoAreaAtual: score,
    }));
    const resultados = simular(BASE_NUTRY, ciclos);
    expect(resultados[2]?.score).toBe(80);
  });

  it("SINAL FRACO isolado NAO cruza o limiar mesmo no horario de maior risco (CISP medio 10 x1.6 = 16): dispara devagar, nao acelera", () => {
    const score = calcularRiscoArea({
      emFavela: false,
      tiroteioRecentePertoM: null,
      rouboCargaCispTotal: 5,
      emCorredorRodoviaRisco: false,
      fatorHorario: 1.6,
    });
    expect(score).toBe(16);
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: JACAREPAGUA.lat - i * 0.01, lng: JACAREPAGUA.lng - i * 0.01,
      dentroTapete: true, riscoAreaAtual: score,
    }));
    const resultados = simular(BASE_NUTRY, ciclos);
    expect(resultados[2]?.score).toBe(45); // NAO e 80 — risco insuficiente pra acelerar
  });

  // Achado real 11/07: o gate antigo bloqueava TOTAL o dia inteiro pra
  // veiculos de rota curta (1-3 entregas passam a maior parte do dia com 0
  // feitas) -- 4 de 5 casos reais confirmados pela cerca virtual como "fora"
  // de rota real nunca viraram alerta so por isso. Agora dispara igual, mas
  // marca exigeConfirmacaoCorredor -- so route.ts (fora do escopo deste
  // teste puro) decide se sobrevive com base no veredito real do corredor.
  it("PRIMEIRA ENTREGA DO DIA (sem historico de comportamento): dispara, marcado pra exigir corredor", () => {
    // Correcao 11/07: a versao anterior usava MANGUINHOS.lat/lng - i*0.01,
    // que na verdade APROXIMA de REALENGO (direcao errada) -- o streak nunca
    // chegava a 2 e o teste so passava (todos null) por acidente de
    // geometria, nao pelo gate que alegava testar. afastarDe() garante
    // afastamento de verdade, mesmo padrao dos outros cenarios do arquivo.
    let anteriorDist: number[] | null = null;
    let streak = 0;
    const resultados: (ReturnType<typeof detectarDesvio>)[] = [];
    for (let i = 0; i < 3; i++) {
      const { lat, lng } = afastarDe(MANGUINHOS, REALENGO, i * 0.01);
      const distDestinosM = [haversineM(lat, lng, REALENGO.lat, REALENGO.lng)];
      if (anteriorDist && afastouDeTudo(distDestinosM, anteriorDist)) streak += 1; else streak = 0;
      resultados.push(detectarDesvio(posicaoBase({ velocidade: 40 }), {
        distDestinosM, distDestinosAnteriorM: anteriorDist ?? [],
        temPendentes: true, emOperacao: true, foraDaBase: true,
        entregasFeitas: 0, // 0 feitas ainda, com pendentes -> sem referencia de comportamento
        streak, afastamentoAcumuladoM: 0, dentroTapete: false, riscoAreaAtual: 100,
        foraTapeteStreak: 5,
      }));
      anteriorDist = distDestinosM;
    }
    expect(resultados[0]).toBeNull(); // streak 0
    expect(resultados[1]).toBeNull(); // streak 1, ainda nao dispara
    expect(resultados[2]).not.toBeNull(); // streak 2: dispara
    expect(resultados[2]?.exigeConfirmacaoCorredor).toBe(true);
  });

  it("DESLOCAMENTO INTERURBANO legitimo (destino > 25km): nao dispara mesmo se afastando", () => {
    const destinoLonge = { lat: MANGUINHOS.lat + 0.3, lng: MANGUINHOS.lng + 0.3 }; // ~45km
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: MANGUINHOS.lat - i * 0.01, lng: MANGUINHOS.lng - i * 0.01, dentroTapete: false,
    }));
    const resultados = simular(destinoLonge, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });
});

describe("foraTapeteStreak — Camada 3, DESATIVADA em 09/07/2026 (ver CAMADA3_TAPETE_ATIVA)", () => {
  // Regressao do caso real TUK-0H45 (08/07/2026): veiculo a ~4,2km de uma
  // entrega pendente real, indo na direcao dela (Camada 1 nao dispara), mas
  // chegando por uma via que a frota nunca usou antes — o antigo calculo por
  // linha reta base->destino degenerava pra "distancia crua ate a entrega"
  // (base ficava a 45km, ver design doc) e disparava em toda aproximacao
  // fora do eixo perfeito. A Camada 3 (tapete) resolveria isso, mas foi
  // DESATIVADA no mesmo dia: virou metade do ruido de desvio em rotas rurais
  // com tapete pouco coberto (TTM-7C14/TTM-2G01/TUS-1A47, achado ao vivo).
  it("mesmo fora do tapete por varias leituras seguidas: NAO dispara enquanto CAMADA3_TAPETE_ATIVA=false", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f, i) => ({
      ...aproximarDe(MANGUINHOS, REALENGO, f),
      foraTapeteStreak: i,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("aproximando e DENTRO do tapete (foraTapeteStreak sempre 0): nao dispara — caso real TUK-0H45/TTM-2G01 corrigido", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f) => ({
      ...aproximarDe(MANGUINHOS, REALENGO, f),
      dentroTapete: true,
      foraTapeteStreak: 0,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("foraTapeteStreak nunca setado (0, default): fluxo normal, sem crash", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f) => ({ ...aproximarDe(MANGUINHOS, REALENGO, f) }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("gatilho normal por AFASTAMENTO continua funcionando normalmente mesmo com foraTapeteStreak baixo (nao interfere)", () => {
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: true,
      riscoAreaAtual: 0,
      foraTapeteStreak: 1,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[2]?.score).toBe(45); // streak 2, via conhecida, sem risco de area — fluxo normal intacto
  });
});
