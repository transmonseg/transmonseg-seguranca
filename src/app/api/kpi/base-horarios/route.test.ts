import { describe, it, expect } from "vitest";
import { acharSaidaEChegadaBase, calcularKmContinuo, filtrarJanelaRota, acharVisitasPorPonto } from "./route";

const BASE = { lat: -22.816007, lng: -43.277827 };
// ~50km da base -- claramente fora do raio de 500m.
const LONGE = { lat: -22.35, lng: -42.9 };

describe("acharSaidaEChegadaBase", () => {
  it("dia normal: dentro de manha, fora o dia todo, dentro de novo a noite -- saida e chegada corretas", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z" }, // dentro (madrugada BRT)
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:30:00.000Z" }, // ainda dentro
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z" }, // saiu
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T18:00:00.000Z" }, // ainda fora
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T21:00:00.000Z" }, // voltou
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:30:00.000Z"); // ULTIMA leitura dentro antes de sair
    expect(r.chegadaBase).toBe("2026-08-25T21:00:00.000Z"); // PRIMEIRA leitura dentro na volta
  });

  it("saiu de manha mas ainda nao voltou (dia em andamento): chegada fica null, nunca inventa", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z" },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z" },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T20:00:00.000Z" },
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:00:00.000Z");
    expect(r.chegadaBase).toBeNull();
  });

  it("veiculo nunca aparece dentro do raio da base o dia inteiro: os dois ficam null", () => {
    const posicoes = [
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T09:00:00.000Z" },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T20:00:00.000Z" },
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBeNull();
    expect(r.chegadaBase).toBeNull();
  });

  it("sem posicao nenhuma ou sem base cadastrada: os dois ficam null", () => {
    expect(acharSaidaEChegadaBase([], [BASE])).toEqual({ saidaBase: null, chegadaBase: null });
    expect(acharSaidaEChegadaBase([{ lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z" }], [])).toEqual({
      saidaBase: null,
      chegadaBase: null,
    });
  });

  it("volta rapida no meio do dia e sai de novo: saida guarda a PRIMEIRA do dia, chegada guarda a ULTIMA", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z" }, // dentro
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z" }, // 1a saida
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T13:00:00.000Z" }, // volta rapida no meio do dia
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T13:05:00.000Z" }, // sai de novo
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T21:00:00.000Z" }, // volta final
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:00:00.000Z"); // ULTIMA leitura dentro da 1a saida do dia, nao a do meio-dia
    expect(r.chegadaBase).toBe("2026-08-25T21:00:00.000Z"); // ultima chegada, nao a do meio-dia
  });

  it("aceita array de bases (2 garagens) -- conta como dentro se bater QUALQUER uma", () => {
    const campos = { lat: -21.6886, lng: -41.3113 };
    const posicoes = [
      { lat: campos.lat, lng: campos.lng, criado_em: "2026-08-25T09:00:00.000Z" },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z" },
      { lat: campos.lat, lng: campos.lng, criado_em: "2026-08-25T21:00:00.000Z" },
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE, campos]);
    expect(r.saidaBase).toBe("2026-08-25T09:00:00.000Z");
    expect(r.chegadaBase).toBe("2026-08-25T21:00:00.000Z");
  });
});

describe("calcularKmContinuo", () => {
  it("soma haversine entre CADA leitura consecutiva, nao so entre paradas -- pega o trajeto real entre elas", () => {
    // ~111km por grau de latitude no equador (aprox) -- 3 pontos em linha
    // reta na mesma longitude, 0.1 grau de latitude entre cada um. 8min
    // entre leituras (nao 1min) -- ~83km/h, velocidade plausivel pro
    // filtro de glitch (ver describe "filtro de velocidade..." abaixo).
    const posicoes = [
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z" },
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T09:08:00.000Z" },
      { lat: -22.2, lng: -43.0, criado_em: "2026-08-25T09:16:00.000Z" },
    ];
    const km = calcularKmContinuo(posicoes);
    expect(km).not.toBeNull();
    expect(km!).toBeGreaterThan(20);
    expect(km!).toBeLessThan(24);
  });

  it("menos de 2 posicoes: null, nao zero (sem dado != km zero)", () => {
    expect(calcularKmContinuo([])).toBeNull();
    expect(calcularKmContinuo([{ lat: -22, lng: -43, criado_em: "2026-08-25T09:00:00.000Z" }])).toBeNull();
  });

  it("veiculo parado o dia inteiro (mesma posicao repetida): km fica proximo de zero, nao inventa distancia", () => {
    const posicoes = Array.from({ length: 10 }, (_, i) => ({
      lat: -22.816007,
      lng: -43.277827,
      criado_em: `2026-08-25T09:0${i}:00.000Z`,
    }));
    const km = calcularKmContinuo(posicoes);
    expect(km).not.toBeNull();
    expect(km!).toBeLessThan(0.01);
  });

  describe("filtro de velocidade plausivel (achado real 27/08, grupo KPI AJUSTES: 'quilometragem de cada carro está errada')", () => {
    it("salto fisicamente impossivel (13.71km em 40s, ~1234km/h -- caso real RBI-0J25) e descartado, nao soma ao km", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T18:17:27.821Z" },
        { lat: -22.1233, lng: -43.0, criado_em: "2026-08-25T18:18:08.228Z" }, // ~13.71km depois, 40s
      ];
      const km = calcularKmContinuo(posicoes);
      expect(km).not.toBeNull();
      expect(km!).toBeLessThan(0.01); // descartado, nao os ~13.71km do salto
    });

    it("mesma distancia, tempo suficiente pra ser plausivel: soma normal (nao descarta deslocamento real por rodovia)", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T18:00:00.000Z" },
        { lat: -22.1233, lng: -43.0, criado_em: "2026-08-25T18:10:00.000Z" }, // ~13.71km em 10min = ~82km/h
      ];
      const km = calcularKmContinuo(posicoes);
      expect(km).not.toBeNull();
      expect(km!).toBeGreaterThan(13);
      expect(km!).toBeLessThan(14);
    });

    it("um salto descartado no meio da rota nao derruba os segmentos plausiveis antes/depois", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z" },
        { lat: -22.05, lng: -43.0, criado_em: "2026-08-25T09:08:00.000Z" }, // ~5.55km em 8min, plausivel
        { lat: -22.1733, lng: -43.0, criado_em: "2026-08-25T09:08:40.000Z" }, // salto de glitch, 40s depois
        { lat: -22.2233, lng: -43.0, criado_em: "2026-08-25T09:16:40.000Z" }, // ~5.55km em 8min de volta a plausivel
      ];
      const km = calcularKmContinuo(posicoes);
      expect(km).not.toBeNull();
      // Só os 2 segmentos plausíveis (~5.55km cada, ~11.1km total) -- o
      // salto de glitch no meio (~13.7km) não entra na soma.
      expect(km!).toBeGreaterThan(10);
      expect(km!).toBeLessThan(12.5);
    });
  });

  describe("leituras com posicao repetida (achado real 28/08, comparacao contra relatorio oficial Unitrac, caso TTK-9B93 26/08)", () => {
    it("Unitrac so atualiza a cada ~5-6min, polling insere 1 leitura/min repetindo a mesma coordenada -- salto real na atualizacao nao e' comparado so contra o ultimo minuto", () => {
      const posicoes = [
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:21:20.000Z" },
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:22:35.000Z" },
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:23:53.000Z" },
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:24:44.000Z" },
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:26:16.000Z" },
        // ~7.3km de deslocamento real -- Unitrac so atualizou agora, ~5min
        // depois da primeira leitura repetida (nao 1min desde a ultima).
        { lat: -21.8692, lng: -41.5567, criado_em: "2026-08-26T13:27:17.000Z" },
      ];
      const km = calcularKmContinuo(posicoes);
      expect(km).not.toBeNull();
      // Sem o fix, isso comparava contra 13:26:16->13:27:17 (~1min) =
      // velocidade implicita muito acima do limiar, descartado como
      // "glitch". Com o dedupe, compara contra 13:21:20->13:27:17 (~6min),
      // velocidade plausivel, soma os ~6km reais.
      expect(km!).toBeGreaterThan(5.5);
      expect(km!).toBeLessThan(6.5);
    });

    it("veiculo genuinamente parado (posicao repetida o dia todo): continua proximo de zero, nao muda o caso ja coberto", () => {
      const posicoes = Array.from({ length: 10 }, (_, i) => ({
        lat: -22.816007,
        lng: -43.277827,
        criado_em: `2026-08-25T09:0${i}:00.000Z`,
      }));
      const km = calcularKmContinuo(posicoes);
      expect(km).not.toBeNull();
      expect(km!).toBe(0);
    });
  });
});

describe("filtrarJanelaRota (achado real 27/08, usuario: km deve ser so' saida->chegada, nao o dia inteiro)", () => {
  it("recorta posicoes de antes da saida e de depois da chegada -- so' sobra a janela da rota", () => {
    const posicoes = [
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T06:00:00.000Z" }, // antes de sair (patio)
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z" }, // dentro da rota
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T12:00:00.000Z" }, // dentro da rota
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T20:00:00.000Z" }, // depois de voltar (patio)
    ];
    const r = filtrarJanelaRota(posicoes, "2026-08-25T09:00:00.000Z", "2026-08-25T12:00:00.000Z");
    expect(r).toEqual([posicoes[1], posicoes[2]]);
  });

  it("chegada nula (rota em andamento): recorta so' o inicio, mantem ate a ultima leitura", () => {
    const posicoes = [
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T06:00:00.000Z" },
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z" },
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T12:00:00.000Z" },
    ];
    const r = filtrarJanelaRota(posicoes, "2026-08-25T09:00:00.000Z", null);
    expect(r).toEqual([posicoes[1], posicoes[2]]);
  });

  it("sem saida (nunca saiu da base no dia): devolve tudo sem filtrar -- nao ha janela de rota", () => {
    const posicoes = [
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T06:00:00.000Z" },
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T12:00:00.000Z" },
    ];
    expect(filtrarJanelaRota(posicoes, null, null)).toEqual(posicoes);
  });

  it("caso real: km cai quando recorta patio pos-chegada com deriva de GPS (achado 27/08)", () => {
    const posicoes = [
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z" }, // saida
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T09:08:00.000Z" }, // rota real, ~11.1km
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T12:00:00.000Z" }, // chegada de volta
      // apos a chegada: 6h de deriva/manobra no patio, "andando" 50m a cada leitura
      ...Array.from({ length: 20 }, (_, i) => ({
        lat: -22.1 + i * 0.0005,
        lng: -43.0,
        criado_em: `2026-08-25T${String(13 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00.000Z`,
      })),
    ];
    const janela = filtrarJanelaRota(posicoes, "2026-08-25T09:00:00.000Z", "2026-08-25T12:00:00.000Z");
    const kmComJanela = calcularKmContinuo(janela)!;
    const kmSemJanela = calcularKmContinuo(posicoes)!;
    expect(kmComJanela).toBeGreaterThan(10);
    expect(kmComJanela).toBeLessThan(12);
    expect(kmSemJanela).toBeGreaterThan(kmComJanela);
  });
});

describe("acharVisitasPorPonto", () => {
  const LOJA_A = { id: "NF1", lat: -22.0, lng: -43.0 };
  const LOJA_B = { id: "NF2", lat: -22.5, lng: -43.5 }; // longe de LOJA_A e de qualquer posicao dos testes abaixo

  it("veiculo entra e sai do raio do ponto: chegada = 1a leitura dentro, saida = ultima antes de sair", () => {
    const posicoes = [
      { lat: -23.0, lng: -44.0, criado_em: "2026-08-25T09:00:00.000Z" }, // longe
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T10:00:00.000Z" }, // chegou em LOJA_A
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T10:15:00.000Z" }, // ainda la
      { lat: -23.0, lng: -44.0, criado_em: "2026-08-25T10:30:00.000Z" }, // saiu
    ];
    const [visitaA, visitaB] = acharVisitasPorPonto(posicoes, [LOJA_A, LOJA_B]);
    expect(visitaA).toEqual({ id: "NF1", chegada: "2026-08-25T10:00:00.000Z", saida: "2026-08-25T10:15:00.000Z" });
    expect(visitaB).toEqual({ id: "NF2", chegada: null, saida: null }); // nunca visitado
  });

  it("2 blocos de visita no mesmo ponto (passou, foi embora, voltou): fica com o de MAIOR duracao", () => {
    const posicoes = [
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z" }, // bloco 1: 2min (curto)
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:02:00.000Z" },
      { lat: -23.0, lng: -44.0, criado_em: "2026-08-25T09:05:00.000Z" }, // saiu
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T14:00:00.000Z" }, // bloco 2: 20min (longo, a entrega de verdade)
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T14:20:00.000Z" },
      { lat: -23.0, lng: -44.0, criado_em: "2026-08-25T14:25:00.000Z" }, // saiu de novo
    ];
    const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
    expect(visita).toEqual({ id: "NF1", chegada: "2026-08-25T14:00:00.000Z", saida: "2026-08-25T14:20:00.000Z" });
  });

  it("2 pontos proximos, 2 entregas na MESMA parada fisica: os 2 detectam a visita, sem 'roubar' um do outro", () => {
    const pontoVizinho = { id: "NF3", lat: -22.0001, lng: -43.0001 }; // ~15m de LOJA_A, dentro do raio de 300m
    const posicoes = [
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T10:00:00.000Z" },
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T10:10:00.000Z" },
    ];
    const [visitaA, visitaVizinho] = acharVisitasPorPonto(posicoes, [LOJA_A, pontoVizinho]);
    expect(visitaA.chegada).toBe("2026-08-25T10:00:00.000Z");
    expect(visitaVizinho.chegada).toBe("2026-08-25T10:00:00.000Z"); // detecta igual, nao compete por cluster
  });

  it("sem posicao nenhuma: todos os pontos ficam null", () => {
    expect(acharVisitasPorPonto([], [LOJA_A])).toEqual([{ id: "NF1", chegada: null, saida: null }]);
  });

  describe("dwell minimo (achado real 27/08, grupo KPI AJUSTES: 'tempo em loja com certeza tá errado')", () => {
    it("UM UNICO ping de GPS dentro do raio (chegada===saida, 0min -- caso real PAULO M DA SILVA MERCEARIA) nao confirma visita", () => {
      const posicoes = [
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:00:00.000Z" }, // longe
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:01:00.000Z" }, // 1 unico ping dentro do raio
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:02:00.000Z" }, // ja saiu de novo
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: null, saida: null });
    });

    it("bloco de 2 leituras mas ainda curto (< 60s de intervalo real): tambem nao confirma", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:00:00.000Z" },
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:00:40.000Z" }, // so 40s depois
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:01:00.000Z" },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: null, saida: null });
    });

    it("bloco de exatamente 60s ou mais: confirma normalmente", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:00:00.000Z" },
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:01:00.000Z" }, // 60s depois, no limiar
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:02:00.000Z" },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: "2026-08-27T09:00:00.000Z", saida: "2026-08-27T09:01:00.000Z" });
    });

    it("bloco curto (ping isolado) E bloco longo no mesmo ponto: fica com o longo, o curto nao interfere (ja seria descartado por duracao mesmo sem o filtro)", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:00:00.000Z" }, // ping isolado, 0min
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:01:00.000Z" },
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T14:00:00.000Z" }, // visita real, 20min
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T14:20:00.000Z" },
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T14:25:00.000Z" },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: "2026-08-27T14:00:00.000Z", saida: "2026-08-27T14:20:00.000Z" });
    });
  });
});
