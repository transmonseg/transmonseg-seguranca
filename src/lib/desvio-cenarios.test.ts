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
import { detectarDesvio, afastouDeTudo, calcularRiscoArea, type CtxDesvio } from "./detectores";
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
  desvioTrajetoM?: number | null;
  perfilRotaMedia?: number | null; perfilRotaDesvioPadrao?: number | null; perfilRotaAmostras?: number;
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
// UM destino fixo, acumulando streak/afastamento exatamente como motor.ts
// faz — mas aqui em memoria, sem tocar em banco nem em Supabase.
function simular(destino: { lat: number; lng: number }, ciclos: Ciclo[]): (ReturnType<typeof detectarDesvio>)[] {
  let streak = 0;
  let menorDistInicio = 0;
  let anteriorDist: number[] | null = null;
  let desvioTrajetoAnteriorM: number | null = null;
  const resultados: ReturnType<typeof detectarDesvio>[] = [];

  for (const c of ciclos) {
    const velocidade = c.velocidade ?? 40;
    const distDestinosM = [haversineM(c.lat, c.lng, destino.lat, destino.lng)];

    if (anteriorDist && velocidade > 0) {
      if (afastouDeTudo(distDestinosM, anteriorDist)) {
        streak += 1;
        if (streak === 1) menorDistInicio = Math.min(...anteriorDist);
      } else {
        streak = 0;
      }
    }
    const menorAgora = Math.min(...distDestinosM);
    const afastamentoAcumuladoM = streak > 0 ? menorAgora - menorDistInicio : 0;
    const desvioTrajetoM = c.desvioTrajetoM ?? null;

    const ctx: CtxDesvio = {
      distDestinosM,
      distDestinosAnteriorM: anteriorDist ?? [],
      temPendentes: true,
      emOperacao: true,
      foraDaBase: true,
      entregasFeitas: 2,
      streak,
      afastamentoAcumuladoM,
      dentroTapete: c.dentroTapete ?? null,
      riscoAreaAtual: c.riscoAreaAtual ?? 0,
      desvioTrajetoM,
      desvioTrajetoAnteriorM,
      perfilRotaMedia: c.perfilRotaMedia ?? null,
      perfilRotaDesvioPadrao: c.perfilRotaDesvioPadrao ?? null,
      perfilRotaAmostras: c.perfilRotaAmostras ?? 0,
    };
    resultados.push(detectarDesvio(posicaoBase({ velocidade }), ctx));
    anteriorDist = distDestinosM;
    desvioTrajetoAnteriorM = desvioTrajetoM;
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

  it("DESVIO INJETADO fora do tapete: dispara IMEDIATO (score 80) mesmo em area sem risco", () => {
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: false,
      riscoAreaAtual: 0,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[2]?.score).toBe(80); // streak chega a 2 no indice 2
    expect(resultados[2]?.motivo).toContain("fora de via conhecida");
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
    // afasta de TUDO). Este cenario nao passa desvioTrajetoM (fica null),
    // entao a checagem complementar de trajeto perpendicular (ver describe
    // "desvioTrajetoM" abaixo) tambem fica inativa aqui de proposito — o
    // objetivo deste teste e isolar so o mecanismo de afastamento.
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

  it("CORRECAO DE ROTA: ciclo se afastando, depois volta a se aproximar — streak zera e NAO dispara", () => {
    const ciclos: Ciclo[] = [
      { ...MANGUINHOS, dentroTapete: true },
      { ...afastarDe(MANGUINHOS, REALENGO, 0.01), dentroTapete: true }, // afasta (streak=1, ainda nao dispara)
      { ...afastarDe(MANGUINHOS, REALENGO, 0.005), dentroTapete: true }, // se aproxima de novo (metade do afastamento anterior) -> reseta
    ];
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
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

  it("PRIMEIRA ENTREGA DO DIA (sem historico de comportamento): nao dispara mesmo com desvio claro", () => {
    let anteriorDist: number[] | null = null;
    let streak = 0;
    const resultados: (ReturnType<typeof detectarDesvio>)[] = [];
    for (let i = 0; i < 3; i++) {
      const lat = MANGUINHOS.lat - i * 0.01, lng = MANGUINHOS.lng - i * 0.01;
      const distDestinosM = [haversineM(lat, lng, REALENGO.lat, REALENGO.lng)];
      if (anteriorDist && afastouDeTudo(distDestinosM, anteriorDist)) streak += 1; else streak = 0;
      resultados.push(detectarDesvio(posicaoBase({ velocidade: 40 }), {
        distDestinosM, distDestinosAnteriorM: anteriorDist ?? [],
        temPendentes: true, emOperacao: true, foraDaBase: true,
        entregasFeitas: 0, // 0 feitas ainda, com pendentes -> sem referencia de comportamento
        streak, afastamentoAcumuladoM: 0, dentroTapete: false, riscoAreaAtual: 100,
        desvioTrajetoM: null, desvioTrajetoAnteriorM: null,
        perfilRotaMedia: null, perfilRotaDesvioPadrao: null, perfilRotaAmostras: 0,
      }));
      anteriorDist = distDestinosM;
    }
    expect(resultados.every(r => r === null)).toBe(true);
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

describe("desvioTrajetoM — fecha parte do ponto cego (aproxima do destino mas por caminho implausivel)", () => {
  it("aproximando do destino mas trajeto fica >=3km fora de qualquer caminho direto por 2 leituras seguidas: dispara score 65 SEM esperar streak", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f) => ({
      ...aproximarDe(MANGUINHOS, REALENGO, f),
      desvioTrajetoM: 4000,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[0]).toBeNull(); // 1o ciclo: ainda sem leitura anterior
    expect(resultados[1]?.score).toBe(65); // 2a leitura ruim seguida: dispara na hora, nao espera streak>=2
    expect(resultados[1]?.motivo).toContain("4,0km fora de qualquer caminho direto plausível");
  });

  it("aproximando por caminho plausivel (desvioTrajetoM abaixo do limiar de 3km): nao dispara", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f) => ({
      ...aproximarDe(MANGUINHOS, REALENGO, f),
      desvioTrajetoM: 500,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("so a leitura ATUAL esta ruim, a anterior nao foi calculada ainda (null): exige 2 leituras, nao dispara", () => {
    const ciclos: Ciclo[] = [
      { ...aproximarDe(MANGUINHOS, REALENGO, 0) }, // desvioTrajetoM null (nao calculado)
      { ...aproximarDe(MANGUINHOS, REALENGO, 0.3), desvioTrajetoM: 5000 }, // so essa e ruim
    ];
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("desvioTrajetoM nunca calculado (null, ex.: sem base/destino valido pra tracar segmento): fluxo normal, sem crash", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f) => ({ ...aproximarDe(MANGUINHOS, REALENGO, f) }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados.every(r => r === null)).toBe(true);
  });

  it("gatilho normal por AFASTAMENTO continua funcionando normalmente mesmo com desvioTrajetoM baixo (nao interfere)", () => {
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: true,
      riscoAreaAtual: 0,
      desvioTrajetoM: 100,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[2]?.score).toBe(45); // streak 2, via conhecida, sem risco de area — fluxo normal intacto
  });
});
