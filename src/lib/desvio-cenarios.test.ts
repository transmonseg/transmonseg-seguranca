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
import { detectarDesvio, afastouDeTudo, avancarStreaksDesvio, calcularRiscoArea, detectarParadaForaTapete, PARADA_FORA_TAPETE_MIN, TIPOS_NAO_GERENCIADOS, type CtxDesvio } from "./detectores";
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
  foraTapeteStreak?: number; familiarVeiculo?: boolean | null;
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
      familiarVeiculo: c.familiarVeiculo ?? null,
      riscoAreaAtual: c.riscoAreaAtual ?? 0,
      foraTapeteStreak: c.foraTapeteStreak ?? 0,
      // Achado real 25/07 (redesign): campos novos de CtxDesvio, neutros
      // aqui de proposito -- este arquivo isola o mecanismo de afastamento
      // (nao exercita suspensao por chegada nem divergencia de rumo).
      suspensoPorChegada: false,
      divergenciaRumoStreak: 0,
      // Achado real 26/07 (Fase 2): campos novos de CtxDesvio, neutros aqui
      // de proposito -- este arquivo nao exercita viradaErradaSaindoDeParada.
      saiuDoRaioAgora: false,
      divergenciaGrausAtual: null,
      // Achado real 27/07: campo novo de CtxDesvio, neutro aqui de proposito
      // -- este arquivo nao exercita o branch de classe viaria.
      quedaClasseViaria: false,
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
    // indice 0: streak 0 (baseline, sem anterior, nunca dispara). Persistencia
    // minima RESTAURADA pra 2 ciclos em 21/07 (revertendo a baixa de 11/07
    // pra 1 ciclo -- achado real desta sessao: 69 de 81 alertas
    // "afastando-se" dispararam com so 1 leitura) -- indice 1 (streak 1)
    // fica abaixo do piso agora, so indice 2 (streak 2) dispara. indice 4: streak 4.
    expect(resultados[0]).toBeNull();
    expect(resultados[1]).toBeNull(); // streak 1, abaixo do novo piso de 2
    expect(resultados[2]?.score).toBe(45); // streak 2, 1o disparo agora
    expect(resultados[4]?.score).toBe(68); // streak 4
  });

  it("fora do tapete, Camada 3 ATIVA (religada 12/07): escala pra 80", () => {
    const ciclos: Ciclo[] = Array.from({ length: 4 }, (_, i) => ({
      ...afastarDe(MANGUINHOS, REALENGO, i * 0.01),
      dentroTapete: false,
      riscoAreaAtual: 0,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[1]).toBeNull(); // streak 1, abaixo do novo piso de 2 (21/07)
    expect(resultados[2]?.score).toBe(80); // streak 2, 1o disparo agora
    expect(resultados[3]?.score).toBe(80);
    expect(resultados[3]?.motivo).toContain("fora de via conhecida");
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

  it("CORRECAO DE ROTA: ciclo se afastando, depois volta a se aproximar — dispara ao atingir o streak minimo, checagem do ciclo atual bloqueia na correcao", () => {
    // Persistencia minima RESTAURADA pra 2 ciclos em 21/07 (revertendo a
    // baixa de 11/07) -- agora precisa de 2 ciclos de afastamento seguidos
    // pra disparar. O 3o ciclo aproxima de verdade NESTE ciclo -- a
    // checagem propria do ciclo atual (linha ~610, "nao confia so no
    // streak pre-computado") bloqueia na hora, independente do streak
    // congelado pela historese (avancarStreaksDesvio) pro PROXIMO ciclo.
    const ciclos: Ciclo[] = [
      { ...MANGUINHOS, dentroTapete: true },
      { ...afastarDe(MANGUINHOS, REALENGO, 0.01), dentroTapete: true }, // afasta -> streak=1, abaixo do piso
      { ...afastarDe(MANGUINHOS, REALENGO, 0.02), dentroTapete: true }, // afasta mais -> streak=2, DISPARA
      { ...afastarDe(MANGUINHOS, REALENGO, 0.01), dentroTapete: true }, // se aproxima de novo -> bloqueado neste ciclo
    ];
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[0]).toBeNull();
    expect(resultados[1]).toBeNull();
    expect(resultados[2]?.score).toBe(45);
    expect(resultados[3]).toBeNull();
  });

  it("cenario de serra via simular(): 1 aproximacao isolada (curva) NAO reseta o streak pro proximo ciclo -- ja dispara no 1o afastamento", () => {
    // Achado real 09/07 (docs/analise-deteccao.md secao 5): em estrada de
    // serra a distancia em linha reta oscila a cada curva. A reimplementacao
    // simplificada que este arquivo usava ate 10/07 zerava o streak nesse
    // ciclo 2, exigindo 2 ciclos NOVOS de afastamento pra disparar de novo
    // (so no ciclo 4). Com a historese real, o streak fica congelado em 1
    // (nao zerado) pro ciclo 3, que ja chega em streak 2.
    // Persistencia minima RESTAURADA pra 2 ciclos em 21/07 (revertendo a
    // baixa de 11/07) -- o ciclo 1 (streak 1) fica abaixo do piso agora. O
    // ciclo 2 (curva, aproximando NESTE ciclo) e bloqueado pela checagem do
    // ciclo atual (linha ~610), mas a historese NAO reseta o streak (so 2
    // leituras CONSECUTIVAS de aproximacao zeram, 1 isolada congela) -- o
    // ciclo 3 retoma de streak 1 (nao de 0) e chega em streak 2, disparando.
    const ciclos: Ciclo[] = [
      { ...MANGUINHOS, dentroTapete: true },                              // 0: baseline
      { ...afastarDe(MANGUINHOS, REALENGO, 0.01), dentroTapete: true },   // 1: afasta -> streak 1, abaixo do piso
      { ...afastarDe(MANGUINHOS, REALENGO, 0.007), dentroTapete: true },  // 2: curva (mais perto que o ciclo 1) -> bloqueado neste ciclo, mas congela streak em 1 pro proximo
      { ...afastarDe(MANGUINHOS, REALENGO, 0.02), dentroTapete: true },   // 3: afasta de novo -> streak 2 (nao zerou no ciclo 2), DISPARA
    ];
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[0]).toBeNull();
    expect(resultados[1]).toBeNull(); // streak 1, abaixo do novo piso de 2
    expect(resultados[2]).toBeNull(); // bloqueado neste ciclo (aproximando agora), mas nao reseta o streak
    expect(resultados[3]?.score).toBe(45); // streak chegou a 2 sem precisar reiniciar do zero -- dispara agora aqui
  });

  it("RUIDO DE GPS de 1 ciclo isolado (jitter): NAO dispara mais (persistencia minima de 2 ciclos absorve ruido de 1 leitura)", () => {
    // Persistencia minima RESTAURADA pra 2 ciclos em 21/07 (revertendo a
    // baixa de 11/07) -- achado real desta sessao: 69 de 81 alertas
    // "afastando-se" dispararam com so 1 leitura, exatamente esse tipo de
    // ruido isolado de GPS. Com o piso de 2 ciclos, uma unica leitura de
    // ruido nunca cruza o streak minimo -- o cenario inteiro fica null.
    const ciclos: Ciclo[] = [
      { ...MANGUINHOS, dentroTapete: true },
      { ...afastarDe(MANGUINHOS, REALENGO, 0.003), dentroTapete: true }, // 1 ciclo de ruido -> streak 1, abaixo do piso
      { ...aproximarDe(MANGUINHOS, REALENGO, 0.02), dentroTapete: true }, // volta a se aproximar do destino -> zera
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
      emAreaRiscoCliente: false,
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
      emAreaRiscoCliente: false,
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
    // Persistencia minima RESTAURADA pra 2 ciclos em 21/07 (revertendo a
    // baixa de 11/07) -- streak 1 (indice 1) fica abaixo do piso agora, so
    // o streak 2 (indice 2) dispara.
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
        streak, afastamentoAcumuladoM: 0, dentroTapete: false, familiarVeiculo: null, riscoAreaAtual: 100,
        // foraTapeteStreak 0 (nao 5): este teste isola o gate de historico
        // da Camada 1, nao quer exercitar a Camada 3 (religada 12/07), que
        // senao dispararia ja no ciclo 0 (antes do proprio gate de streak
        // comportamental que o teste pretende provar).
        foraTapeteStreak: 0,
        suspensoPorChegada: false,
        divergenciaRumoStreak: 0,
        saiuDoRaioAgora: false,
        divergenciaGrausAtual: null,
        quedaClasseViaria: false,
      }));
      anteriorDist = distDestinosM;
    }
    expect(resultados[0]).toBeNull(); // streak 0
    expect(resultados[1]).toBeNull(); // streak 1: abaixo do novo piso de 2, nao dispara mais
    expect(resultados[2]).not.toBeNull(); // streak 2: dispara
    expect(resultados[2]?.exigeConfirmacaoCorredor).toBe(true);
  });

  it("DESLOCAMENTO INTERURBANO legitimo (destino > 300km) AFASTANDO COM STREAK 2: dispara alerta FRACO (achado 22/07)", () => {
    // Achado real 22/07 (auditoria): fecha o "ponto cego" de silencio total
    // acima do teto -- agora dispara alerta FRACO quando ha streak >= 2 e esta
    // afastando de tudo, mesmo acima de 300km. Isto e uma mudança intencional:
    // viagem legitima >300km que esteja APROXIMANDO de algo continua silenciosa
    // (validar com o teste seguinte), so o caso genuinamente suspeito
    // (afastando, sustentado) passa a alertar.
    const destinoLonge = { lat: MANGUINHOS.lat + 3.0, lng: MANGUINHOS.lng + 3.0 }; // ~450km
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: MANGUINHOS.lat - i * 0.01, lng: MANGUINHOS.lng - i * 0.01, dentroTapete: false,
    }));
    const resultados = simular(destinoLonge, ciclos);
    expect(resultados[0]).toBeNull(); // streak 0: nao dispara
    expect(resultados[1]).toBeNull(); // streak 1: abaixo do piso de 2, nao dispara
    expect(resultados[2]).not.toBeNull(); // streak 2: dispara alerta FRACO
    expect(resultados[2]?.nivel).toBe("atencao");
    expect(resultados[2]?.score).toBe(30);
  });

  it("DESLOCAMENTO INTERURBANO legitimo (destino > 300km) APROXIMANDO: continua silencioso mesmo com streak", () => {
    // Contraprova: viagem legitima >300km que esteja se aproximando de algum
    // destino (ou ao menos nao se afastando de TODOS) nao dispara nem com
    // streak >= 2 -- so o genuinamente suspeito (afastando persistente) gera
    // ruido.
    const destinoLonge = { lat: MANGUINHOS.lat + 3.0, lng: MANGUINHOS.lng + 3.0 }; // ~450km
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      // Agora movemento em direcao ao destino (fracao crescente do caminho)
      ...aproximarDe(MANGUINHOS, destinoLonge, i * 0.1),
      dentroTapete: false,
    }));
    const resultados = simular(destinoLonge, ciclos);
    expect(resultados.every(r => r === null)).toBe(true); // Todos silenciosos
  });

  it("DESLOCAMENTO legitimo antigo (destino ~120km, entre o teto velho 80km e o novo 300km): dispara agora", () => {
    // Camada 3 ja ativa (Tarefa 4): dentroTapete=false escala pra score 80,
    // nao mais 45 -- so verificamos que ALGUM alerta dispara, sem fixar score.
    const destinoMedio = { lat: MANGUINHOS.lat + 0.8, lng: MANGUINHOS.lng + 0.8 }; // ~120km
    const ciclos: Ciclo[] = Array.from({ length: 3 }, (_, i) => ({
      lat: MANGUINHOS.lat - i * 0.01, lng: MANGUINHOS.lng - i * 0.01, dentroTapete: false,
    }));
    const resultados = simular(destinoMedio, ciclos);
    expect(resultados.some(r => r !== null)).toBe(true);
  });
});

describe("foraTapeteStreak — Camada 3, RELIGADA em 12/07/2026 (ver CAMADA3_TAPETE_ATIVA)", () => {
  // Regressao do caso real TUK-0H45 (08/07/2026): veiculo a ~4,2km de uma
  // entrega pendente real, indo na direcao dela (Camada 1 nao dispara), mas
  // chegando por uma via que a frota nunca usou antes — o antigo calculo por
  // linha reta base->destino degenerava pra "distancia crua ate a entrega"
  // (base ficava a 45km, ver design doc) e disparava em toda aproximacao
  // fora do eixo perfeito. A Camada 3 (tapete) resolveria isso, mas foi
  // DESATIVADA no mesmo dia: virou metade do ruido de desvio em rotas rurais
  // com tapete pouco coberto (TTM-7C14/TTM-2G01/TUS-1A47, achado ao vivo).
  it("fora do tapete por varias leituras seguidas, Camada 3 ATIVA (religada 12/07): dispara ao atingir o minimo", () => {
    const fracoes = [0, 0.3, 0.6];
    const ciclos: Ciclo[] = fracoes.map((f, i) => ({
      ...aproximarDe(MANGUINHOS, REALENGO, f),
      foraTapeteStreak: i,
    }));
    const resultados = simular(REALENGO, ciclos);
    expect(resultados[0]).toBeNull(); // foraTapeteStreak 0
    expect(resultados[1]).toBeNull(); // foraTapeteStreak 1, abaixo do minimo (2)
    expect(resultados[2]).not.toBeNull(); // foraTapeteStreak 2, atinge o minimo
    expect(resultados[2]?.motivo).toContain("nunca percorreu");
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

// Gatilho RAPIDO "parada fora do tapete" (Fix 1, achado real 27/07, caso
// TTK-4D14) -- ver docs/superpowers/specs/2026-07-27-parada-fora-tapete-e-fix-lat-escalacao-design.md.
// Cobre o "buraco" que detectarDesvio nunca fecha sozinho: devAvancarStreaksDesvio
// exige velocidade>0 pra avancar QUALQUER streak de desvio (anti-jitter de GPS
// parado, intencional, achado 10/07) -- um veiculo que desvia e PARA antes de
// streak>=2 nunca dispara nada por aquela familia inteira de regras. Detector
// de ciclo unico (posicao ESTATICA), por isso testado direto (sem o helper
// `simular`, que so faz sentido pra sequencias em movimento).
describe("detectarParadaForaTapete — gatilho rapido 'desviou e parou' (Fix 1, 27/07)", () => {
  const base = {
    paradoMin: PARADA_FORA_TAPETE_MIN,
    emOperacao: true,
    foraDaBase: true,
    noCliente: false,
    dentroTapete: false as boolean | null,
    temPOIProximo: false,
    vizinhosParados: 0,
    riscoAreaAtual: 0,
  };

  it("parado poucos minutos FORA do tapete, sem POI/congestionamento: dispara (nivel atencao, area sem risco)", () => {
    const a = detectarParadaForaTapete(base);
    expect(a).not.toBeNull();
    // Tipo PROPRIO desde a revisao adversarial de 27/07 (caso TTK-4D14) --
    // antes reusava tipo="desvio" + origemDesvio="parada_fora_tapete", o
    // que fazia este alerta ocupar a mesma vaga 1-por-veiculo-por-tipo da
    // familia de desvio comportamental (risco de bloquear um desvio real
    // subsequente, ver detectores.ts). Agora tipo e origemDesvio sao
    // independentes: nunca mais "desvio", nunca mais seta origemDesvio.
    expect(a?.tipo).toBe("parada_fora_tapete");
    expect(a?.origemDesvio).toBeUndefined();
    expect(a?.nivel).toBe("atencao");
    expect(a?.motivo).toContain("fora de qualquer via conhecida da frota");
  });

  it("area de risco elevado (riscoAreaAtual >= limiar): escala pra critico", () => {
    const a = detectarParadaForaTapete({ ...base, riscoAreaAtual: 30 });
    expect(a).not.toBeNull();
    expect(a?.nivel).toBe("critico");
  });

  it("abaixo do piso de tempo (PARADA_FORA_TAPETE_MIN - 1 min): NAO dispara ainda", () => {
    expect(detectarParadaForaTapete({ ...base, paradoMin: PARADA_FORA_TAPETE_MIN - 1 })).toBeNull();
  });

  it("parado DENTRO do tapete (dentroTapete=true): nunca dispara, mesmo parado ha muito tempo", () => {
    expect(detectarParadaForaTapete({ ...base, dentroTapete: true, paradoMin: 20 })).toBeNull();
  });

  it("dentroTapete=null (cobertura minima do tapete ainda nao confirmada, cold-start): nao dispara", () => {
    expect(detectarParadaForaTapete({ ...base, dentroTapete: null })).toBeNull();
  });

  it("fora do tapete mas com POI perto (posto/apoio): suprime, mesma regra anti-FP de detectarParadaAnomala", () => {
    expect(detectarParadaForaTapete({ ...base, temPOIProximo: true })).toBeNull();
  });

  it("2+ outros veiculos da frota parados perto (congestionamento/transito): suprime", () => {
    expect(detectarParadaForaTapete({ ...base, vizinhosParados: 2 })).toBeNull();
  });

  it("1 vizinho parado por perto ainda dispara (nao e aglomeracao, mesma regra de detectarParadaAnomala)", () => {
    expect(detectarParadaForaTapete({ ...base, vizinhosParados: 1 })).not.toBeNull();
  });

  it("no cliente (dentro do raio de entrega): nunca dispara, mesmo fora do tapete", () => {
    expect(detectarParadaForaTapete({ ...base, noCliente: true })).toBeNull();
  });

  it("dentro da base (foraDaBase=false): nunca dispara", () => {
    expect(detectarParadaForaTapete({ ...base, foraDaBase: false })).toBeNull();
  });

  it("fora de horario de operacao: nunca dispara", () => {
    expect(detectarParadaForaTapete({ ...base, emOperacao: false })).toBeNull();
  });

  // Auto-resolve (achado real 27/07, revisao adversarial, caso TTK-4D14):
  // tipo proprio "parada_fora_tapete" participa do auto-resolve generico de
  // route.ts (alertasGerenciados) exatamente como parada_anomala ja
  // participa -- NAO fica preso ate acao manual/cron de 7 dias como
  // "desvio" ficaria. route.ts fecha o alerta sozinho assim que
  // avaliar()/montarCandidatosCore param de retornar candidato pra este
  // veiculo; os dois testes abaixo confirmam que o DETECTOR realmente para
  // de disparar nas duas formas de "condicao deixou de valer" citadas no
  // pedido (voltou pro tapete / saiu andando), que e' a precondicao pro
  // auto-resolve de route.ts acontecer.
  it("episodio completo: dispara parado fora do tapete, depois para de disparar quando o veiculo volta a andar POR DENTRO do tapete conhecido", () => {
    const cicloParado = detectarParadaForaTapete(base);
    expect(cicloParado).not.toBeNull();
    expect(cicloParado?.tipo).toBe("parada_fora_tapete");

    const cicloVoltouTapete = detectarParadaForaTapete({ ...base, dentroTapete: true });
    expect(cicloVoltouTapete).toBeNull();
  });

  it("episodio completo: dispara parado fora do tapete, depois para de disparar quando o veiculo sai andando (paradoMin volta a 0)", () => {
    const cicloParado = detectarParadaForaTapete(base);
    expect(cicloParado).not.toBeNull();

    // route.ts zera parado_desde assim que velocidade>0 e' reportada de
    // novo -- paradoMin volta a 0 no ciclo seguinte.
    const cicloAndando = detectarParadaForaTapete({ ...base, paradoMin: 0 });
    expect(cicloAndando).toBeNull();
  });
});

// Issue C da revisao adversarial de 27/07 (caso TTK-4D14): sob o design
// ORIGINAL (tipo="desvio" + origemDesvio="parada_fora_tapete"), um
// parada_fora_tapete critico (riscoAreaAtual>=25) ocupava a MESMA vaga
// 1-por-veiculo-por-tipo que um desvio comportamental real usaria depois.
// route.ts so ESCALA a linha existente numa transicao nao-critico->critico
// (ver "achado real 22/07" no proprio route.ts) -- com a linha ja critica
// por causa da parada, um desvio real subsequente do MESMO veiculo (tambem
// critico) nunca criaria linha nova (jaExiste=true) nem escalaria (nivel
// nao muda), entao motivo/lat/lng/score do desvio real JAMAIS chegariam ao
// banco: o operador continuaria vendo o texto antigo "parou fora do
// tapete" enquanto um sequestro em andamento passava batido. Tipo proprio
// resolve isso por construcao -- os testes abaixo confirmam a base do
// argumento (tipos distintos, dedup de route.ts chaveia por tipo exato).
describe("parada_fora_tapete nao bloqueia/engole um desvio comportamental real (issue C da revisao adversarial 27/07)", () => {
  it("parada_fora_tapete critico e desvio comportamental critico do MESMO veiculo tem tipos DIFERENTES -- nunca competem pela mesma linha em route.ts", () => {
    // Ciclo 1: veiculo parado fora do tapete, em area de risco -- critico.
    const alertaParada = detectarParadaForaTapete({
      paradoMin: PARADA_FORA_TAPETE_MIN,
      emOperacao: true,
      foraDaBase: true,
      noCliente: false,
      dentroTapete: false,
      temPOIProximo: false,
      vizinhosParados: 0,
      riscoAreaAtual: 30,
    });
    expect(alertaParada?.nivel).toBe("critico");
    expect(alertaParada?.tipo).toBe("parada_fora_tapete");

    // Ciclo posterior, MESMO veiculo: retomou o movimento e se afastou de
    // TODOS os destinos, fora de qualquer via conhecida -- desvio
    // comportamental critico de verdade (Camada 3, streak>=2).
    const ctxDesvio: CtxDesvio = {
      distDestinosM: [10000, 12000],
      distDestinosAnteriorM: [8000, 10000],
      temPendentes: true,
      emOperacao: true,
      foraDaBase: true,
      streak: 2,
      afastamentoAcumuladoM: 2000,
      dentroTapete: false,
      familiarVeiculo: null,
      suspensoPorChegada: false,
      divergenciaRumoStreak: 0,
      saiuDoRaioAgora: false,
      divergenciaGrausAtual: null,
      quedaClasseViaria: false,
      riscoAreaAtual: 0,
      foraTapeteStreak: 0,
    };
    const alertaDesvio = detectarDesvio(posicaoBase({ velocidade: 40 }), ctxDesvio);
    expect(alertaDesvio?.nivel).toBe("critico");
    expect(alertaDesvio?.tipo).toBe("desvio");

    // O ponto central da correcao: tipos DIFERENTES. route.ts identifica
    // "ja existe alerta deste tipo pro veiculo" com
    // `alertasAbertos.find(a => a.tipo === alerta.tipo)` -- com tipos
    // diferentes, o desvio real sempre cria/atualiza SUA PROPRIA linha,
    // nunca esbarra na linha (ja critica) da parada_fora_tapete.
    expect(alertaDesvio?.tipo).not.toBe(alertaParada?.tipo);
  });

  it("desvio permanece fora do auto-resolve (TIPOS_NAO_GERENCIADOS); parada_fora_tapete nao herda essa exclusao", () => {
    expect(TIPOS_NAO_GERENCIADOS.has("desvio")).toBe(true);
    expect(TIPOS_NAO_GERENCIADOS.has("parada_fora_tapete")).toBe(false);
  });
});
