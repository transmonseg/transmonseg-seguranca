import { describe, it, expect } from "vitest";
import { acharSaidaEChegadaBase, calcularKmContinuo, filtrarJanelaRota, acharVisitasPorPonto } from "./route";

const BASE = { lat: -22.816007, lng: -43.277827 };
// ~50km da base -- claramente fora do raio de 500m.
const LONGE = { lat: -22.35, lng: -42.9 };

describe("acharSaidaEChegadaBase", () => {
  it("dia normal: dentro de manha, fora o dia todo, dentro de novo a noite -- saida e chegada corretas", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 }, // dentro (madrugada BRT)
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:30:00.000Z", velocidade: 0 }, // ainda dentro
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z", velocidade: 0 }, // saiu
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T18:00:00.000Z", velocidade: 0 }, // ainda fora
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T21:00:00.000Z", velocidade: 0 }, // voltou
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:30:00.000Z"); // ULTIMA leitura dentro antes de sair
    expect(r.chegadaBase).toBe("2026-08-25T21:00:00.000Z"); // PRIMEIRA leitura dentro na volta
  });

  it("saiu de manha mas ainda nao voltou (dia em andamento): chegada fica null, nunca inventa", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z", velocidade: 0 },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T20:00:00.000Z", velocidade: 0 },
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:00:00.000Z");
    expect(r.chegadaBase).toBeNull();
  });

  it("veiculo nunca aparece dentro do raio da base o dia inteiro: os dois ficam null", () => {
    const posicoes = [
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T20:00:00.000Z", velocidade: 0 },
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBeNull();
    expect(r.chegadaBase).toBeNull();
  });

  it("sem posicao nenhuma ou sem base cadastrada: os dois ficam null", () => {
    expect(acharSaidaEChegadaBase([], [BASE])).toEqual({ saidaBase: null, chegadaBase: null });
    expect(acharSaidaEChegadaBase([{ lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 }], [])).toEqual({
      saidaBase: null,
      chegadaBase: null,
    });
  });

  it("volta rapida no meio do dia e sai de novo: saida guarda a PRIMEIRA do dia, chegada guarda a ULTIMA", () => {
    const posicoes = [
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 }, // dentro
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z", velocidade: 0 }, // 1a saida
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T13:00:00.000Z", velocidade: 0 }, // volta rapida no meio do dia
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T13:05:00.000Z", velocidade: 0 }, // sai de novo
      { lat: BASE.lat, lng: BASE.lng, criado_em: "2026-08-25T21:00:00.000Z", velocidade: 0 }, // volta final
    ];
    const r = acharSaidaEChegadaBase(posicoes, [BASE]);
    expect(r.saidaBase).toBe("2026-08-25T09:00:00.000Z"); // ULTIMA leitura dentro da 1a saida do dia, nao a do meio-dia
    expect(r.chegadaBase).toBe("2026-08-25T21:00:00.000Z"); // ultima chegada, nao a do meio-dia
  });

  it("aceita array de bases (2 garagens) -- conta como dentro se bater QUALQUER uma", () => {
    const campos = { lat: -21.6886, lng: -41.3113 };
    const posicoes = [
      { lat: campos.lat, lng: campos.lng, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 },
      { lat: LONGE.lat, lng: LONGE.lng, criado_em: "2026-08-25T10:00:00.000Z", velocidade: 0 },
      { lat: campos.lat, lng: campos.lng, criado_em: "2026-08-25T21:00:00.000Z", velocidade: 0 },
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
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 },
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T09:08:00.000Z", velocidade: 0 },
      { lat: -22.2, lng: -43.0, criado_em: "2026-08-25T09:16:00.000Z", velocidade: 0 },
    ];
    const km = calcularKmContinuo(posicoes);
    expect(km).not.toBeNull();
    expect(km!).toBeGreaterThan(20);
    expect(km!).toBeLessThan(24);
  });

  it("menos de 2 posicoes: null, nao zero (sem dado != km zero)", () => {
    expect(calcularKmContinuo([])).toBeNull();
    expect(calcularKmContinuo([{ lat: -22, lng: -43, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 }])).toBeNull();
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
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T18:17:27.821Z", velocidade: 0 },
        { lat: -22.1233, lng: -43.0, criado_em: "2026-08-25T18:18:08.228Z", velocidade: 0 }, // ~13.71km depois, 40s
      ];
      const km = calcularKmContinuo(posicoes);
      expect(km).not.toBeNull();
      expect(km!).toBeLessThan(0.01); // descartado, nao os ~13.71km do salto
    });

    it("mesma distancia, tempo suficiente pra ser plausivel: soma normal (nao descarta deslocamento real por rodovia)", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T18:00:00.000Z", velocidade: 0 },
        { lat: -22.1233, lng: -43.0, criado_em: "2026-08-25T18:10:00.000Z", velocidade: 0 }, // ~13.71km em 10min = ~82km/h
      ];
      const km = calcularKmContinuo(posicoes);
      expect(km).not.toBeNull();
      expect(km!).toBeGreaterThan(13);
      expect(km!).toBeLessThan(14);
    });

    it("um salto descartado no meio da rota nao derruba os segmentos plausiveis antes/depois", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 },
        { lat: -22.05, lng: -43.0, criado_em: "2026-08-25T09:08:00.000Z", velocidade: 0 }, // ~5.55km em 8min, plausivel
        { lat: -22.1733, lng: -43.0, criado_em: "2026-08-25T09:08:40.000Z", velocidade: 0 }, // salto de glitch, 40s depois
        { lat: -22.2233, lng: -43.0, criado_em: "2026-08-25T09:16:40.000Z", velocidade: 0 }, // ~5.55km em 8min de volta a plausivel
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
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:21:20.000Z", velocidade: 0 },
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:22:35.000Z", velocidade: 0 },
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:23:53.000Z", velocidade: 0 },
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:24:44.000Z", velocidade: 0 },
        { lat: -21.8376, lng: -41.509, criado_em: "2026-08-26T13:26:16.000Z", velocidade: 0 },
        // ~7.3km de deslocamento real -- Unitrac so atualizou agora, ~5min
        // depois da primeira leitura repetida (nao 1min desde a ultima).
        { lat: -21.8692, lng: -41.5567, criado_em: "2026-08-26T13:27:17.000Z", velocidade: 0 },
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
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T06:00:00.000Z", velocidade: 0 }, // antes de sair (patio)
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 }, // dentro da rota
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T12:00:00.000Z", velocidade: 0 }, // dentro da rota
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T20:00:00.000Z", velocidade: 0 }, // depois de voltar (patio)
    ];
    const r = filtrarJanelaRota(posicoes, "2026-08-25T09:00:00.000Z", "2026-08-25T12:00:00.000Z");
    expect(r).toEqual([posicoes[1], posicoes[2]]);
  });

  it("chegada nula (rota em andamento): recorta so' o inicio, mantem ate a ultima leitura", () => {
    const posicoes = [
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T06:00:00.000Z", velocidade: 0 },
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 },
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T12:00:00.000Z", velocidade: 0 },
    ];
    const r = filtrarJanelaRota(posicoes, "2026-08-25T09:00:00.000Z", null);
    expect(r).toEqual([posicoes[1], posicoes[2]]);
  });

  it("sem saida (nunca saiu da base no dia): devolve tudo sem filtrar -- nao ha janela de rota", () => {
    const posicoes = [
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T06:00:00.000Z", velocidade: 0 },
      { lat: -22.816, lng: -43.2778, criado_em: "2026-08-25T12:00:00.000Z", velocidade: 0 },
    ];
    expect(filtrarJanelaRota(posicoes, null, null)).toEqual(posicoes);
  });

  it("caso real: km cai quando recorta patio pos-chegada com deriva de GPS (achado 27/08)", () => {
    const posicoes = [
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 }, // saida
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T09:08:00.000Z", velocidade: 0 }, // rota real, ~11.1km
      { lat: -22.1, lng: -43.0, criado_em: "2026-08-25T12:00:00.000Z", velocidade: 0 }, // chegada de volta
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
      { lat: -23.0, lng: -44.0, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 }, // longe
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T10:00:00.000Z", velocidade: 0 }, // chegou em LOJA_A
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T10:15:00.000Z", velocidade: 0 }, // ainda la
      { lat: -23.0, lng: -44.0, criado_em: "2026-08-25T10:30:00.000Z", velocidade: 0 }, // saiu
    ];
    const [visitaA, visitaB] = acharVisitasPorPonto(posicoes, [LOJA_A, LOJA_B]);
    expect(visitaA).toEqual({ id: "NF1", chegada: "2026-08-25T10:00:00.000Z", saida: "2026-08-25T10:15:00.000Z" });
    expect(visitaB).toEqual({ id: "NF2", chegada: null, saida: null }); // nunca visitado
  });

  it("2 blocos de visita no mesmo ponto (passou, foi embora, voltou): fica com o de MAIOR duracao", () => {
    const posicoes = [
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:00:00.000Z", velocidade: 0 }, // bloco 1: 2min (curto)
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T09:02:00.000Z", velocidade: 0 },
      { lat: -23.0, lng: -44.0, criado_em: "2026-08-25T09:05:00.000Z", velocidade: 0 }, // saiu
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T14:00:00.000Z", velocidade: 0 }, // bloco 2: 20min (longo, a entrega de verdade)
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T14:20:00.000Z", velocidade: 0 },
      { lat: -23.0, lng: -44.0, criado_em: "2026-08-25T14:25:00.000Z", velocidade: 0 }, // saiu de novo
    ];
    const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
    expect(visita).toEqual({ id: "NF1", chegada: "2026-08-25T14:00:00.000Z", saida: "2026-08-25T14:20:00.000Z" });
  });

  it("2 pontos proximos, 2 entregas na MESMA parada fisica: os 2 detectam a visita, sem 'roubar' um do outro", () => {
    const pontoVizinho = { id: "NF3", lat: -22.0001, lng: -43.0001 }; // ~15m de LOJA_A, dentro do raio de 300m
    const posicoes = [
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T10:00:00.000Z", velocidade: 0 },
      { lat: -22.0, lng: -43.0, criado_em: "2026-08-25T10:10:00.000Z", velocidade: 0 },
    ];
    const [visitaA, visitaVizinho] = acharVisitasPorPonto(posicoes, [LOJA_A, pontoVizinho]);
    expect(visitaA.chegada).toBe("2026-08-25T10:00:00.000Z");
    expect(visitaVizinho.chegada).toBe("2026-08-25T10:00:00.000Z"); // detecta igual, nao compete por cluster
  });

  it("sem posicao nenhuma: todos os pontos ficam null", () => {
    expect(acharVisitasPorPonto([], [LOJA_A])).toEqual([{ id: "NF1", chegada: null, saida: null }]);
  });

  describe("corroboracao por vizinhanca (achado real 30/08, bucket 500m-2km: 27% eram 1 parada real servindo varios clientes vizinhos -- ex. TTM-2G02/Rocinha)", () => {
    // ~600m de LOJA_A -- dentro do RAIO_VIZINHANCA_M (800m), mas fora do
    // RAIO_ENTREGA_M direto (500m) por desenho do teste.
    const LOJA_VIZINHA = { id: "NF_VIZINHA", lat: -22.0054, lng: -43.0 };

    // Achado real 06/09 (RAIO_AMPLIADO_M, ver comentario la): as mesmas
    // posicoes que confirmam LOJA_A (~600m de LOJA_VIZINHA) TAMBEM caem no
    // raio ampliado (800m) do PROPRIO LOJA_VIZINHA -- dwell direto (mesmo
    // que so' no raio ampliado) tem prioridade sobre emprestar do vizinho.
    it("ponto com dwell so' no raio AMPLIADO (nao no normal): confirma marcado viaRaioAmpliado, nao viaVizinhanca", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-30T10:00:00.000Z", velocidade: 0 }, // confirma LOJA_A
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-30T10:15:00.000Z", velocidade: 0 },
      ];
      const [, visitaVizinha] = acharVisitasPorPonto(posicoes, [LOJA_A, LOJA_VIZINHA]);
      expect(visitaVizinha).toEqual({
        id: "NF_VIZINHA",
        chegada: "2026-08-30T10:00:00.000Z",
        saida: "2026-08-30T10:15:00.000Z",
        viaRaioAmpliado: true,
      });
    });

    // Separacao limpa entre viaRaioAmpliado (contra as POSICOES cruas) e
    // viaVizinhanca (contra o PONTO do vizinho ja confirmado) exige que a
    // posicao que confirma o vizinho NAO coincida exatamente com o ponto
    // dele (a maioria dos testes acima usa posicao==ponto de proposito,
    // pra simplificar -- mas isso torna as duas distancias identicas e
    // esconde a diferenca entre os dois raios). Aqui LOJA_D confirma a
    // ~450m das suas PROPRIAS posicoes (raio normal), e o alvo fica a
    // ~700m do PONTO de LOJA_D (dentro da vizinhanca) mas a ~833m das
    // POSICOES de LOJA_D (fora do proprio raio ampliado) -- geometria em
    // 2 eixos (lat+lng) pra desacoplar as duas distancias de proposito.
    it("vizinho confirmado por perto, mas fora dos 800m das POSICOES do vizinho: ainda herda por vizinhanca (ponto do vizinho, nao a posicao)", () => {
      const LOJA_D = { id: "NF_D", lat: -22.0, lng: -43.0 };
      const ALVO_SO_VIZINHANCA = { id: "NF_ALVO", lat: -22.0063, lng: -43.0 }; // ~700m do PONTO de LOJA_D
      const posicoes = [
        { lat: -22.0, lng: -43.00437, criado_em: "2026-08-30T10:00:00.000Z", velocidade: 0 }, // ~450m de LOJA_D -- confirma LOJA_D no raio NORMAL
        { lat: -22.0, lng: -43.00437, criado_em: "2026-08-30T10:15:00.000Z", velocidade: 0 },
      ];
      const [visitaD, visitaAlvo] = acharVisitasPorPonto(posicoes, [LOJA_D, ALVO_SO_VIZINHANCA]);
      expect(visitaD).toEqual({ id: "NF_D", chegada: "2026-08-30T10:00:00.000Z", saida: "2026-08-30T10:15:00.000Z" });
      expect(visitaAlvo).toEqual({
        id: "NF_ALVO",
        chegada: "2026-08-30T10:00:00.000Z",
        saida: "2026-08-30T10:15:00.000Z",
        viaVizinhanca: true,
      });
    });

    it("vizinho fora do raio de vizinhanca (LOJA_B, ~77km): nao herda nada, continua null sem a marcacao", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-30T10:00:00.000Z", velocidade: 0 },
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-30T10:15:00.000Z", velocidade: 0 },
      ];
      const [, visitaB] = acharVisitasPorPonto(posicoes, [LOJA_A, LOJA_B]);
      expect(visitaB).toEqual({ id: "NF2", chegada: null, saida: null });
    });

    it("visita direta tem prioridade sobre vizinhanca: ponto com dwell proprio nao herda de ninguem, mesmo com vizinho confirmado por perto", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-30T10:00:00.000Z", velocidade: 0 }, // LOJA_A
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-30T10:15:00.000Z", velocidade: 0 },
        { lat: -22.0054, lng: -43.0, criado_em: "2026-08-30T11:00:00.000Z", velocidade: 0 }, // LOJA_VIZINHA, visita PROPRIA
        { lat: -22.0054, lng: -43.0, criado_em: "2026-08-30T11:05:00.000Z", velocidade: 0 },
      ];
      const [, visitaVizinha] = acharVisitasPorPonto(posicoes, [LOJA_A, LOJA_VIZINHA]);
      expect(visitaVizinha).toEqual({ id: "NF_VIZINHA", chegada: "2026-08-30T11:00:00.000Z", saida: "2026-08-30T11:05:00.000Z" });
    });
  });

  describe("dwell minimo (achado real 27/08, grupo KPI AJUSTES: 'tempo em loja com certeza tá errado')", () => {
    it("UM UNICO ping de GPS dentro do raio (chegada===saida, 0min -- caso real PAULO M DA SILVA MERCEARIA) nao confirma visita", () => {
      const posicoes = [
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:00:00.000Z", velocidade: 0 }, // longe
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:01:00.000Z", velocidade: 0 }, // 1 unico ping dentro do raio
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:02:00.000Z", velocidade: 0 }, // ja saiu de novo
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: null, saida: null });
    });

    it("bloco de 2 leituras mas ainda curto (< 60s de intervalo real): tambem nao confirma", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:00:00.000Z", velocidade: 0 },
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:00:40.000Z", velocidade: 0 }, // so 40s depois
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:01:00.000Z", velocidade: 0 },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: null, saida: null });
    });

    it("bloco de exatamente 60s ou mais: confirma normalmente", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:00:00.000Z", velocidade: 0 },
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:01:00.000Z", velocidade: 0 }, // 60s depois, no limiar
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:02:00.000Z", velocidade: 0 },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: "2026-08-27T09:00:00.000Z", saida: "2026-08-27T09:01:00.000Z" });
    });

    it("bloco curto (ping isolado) E bloco longo no mesmo ponto: fica com o longo, o curto nao interfere (ja seria descartado por duracao mesmo sem o filtro)", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T09:00:00.000Z", velocidade: 0 }, // ping isolado, 0min
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T09:01:00.000Z", velocidade: 0 },
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T14:00:00.000Z", velocidade: 0 }, // visita real, 20min
        { lat: -22.0, lng: -43.0, criado_em: "2026-08-27T14:20:00.000Z", velocidade: 0 },
        { lat: -23.0, lng: -44.0, criado_em: "2026-08-27T14:25:00.000Z", velocidade: 0 },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: "2026-08-27T14:00:00.000Z", saida: "2026-08-27T14:20:00.000Z" });
    });
  });

  describe("exigencia de velocidade baixa (achado real 11/09, KPI Nutry Max, NF 2365070/TRIBUNAL RESTAURANTE)", () => {
    // Caso real: TTH6G37 passou reto a 368-757m do cliente a 49-53km/h --
    // nunca parou -- mas o raio ampliado (800m) + DWELL_MINIMO_MS (so' 1min)
    // bastavam pra virar "confirmado" so' por distancia, sem checar
    // velocidade. A 50km/h da pra atravessar 800m de raio em bem menos de
    // 1min, e leituras a cada ~30-40s ficam "dentro" por varios ciclos
    // mesmo em movimento constante.
    it("veiculo em movimento (velocidade alta) dentro do raio: NAO confirma, mesmo com bloco >=60s", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:00:00.000Z", velocidade: 50 },
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:01:00.000Z", velocidade: 53 },
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:02:00.000Z", velocidade: 49 },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: null, saida: null });
    });

    it("veiculo realmente parado (velocidade 0) dentro do raio: confirma normalmente", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:00:00.000Z", velocidade: 0 },
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:01:00.000Z", velocidade: 0 },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: "2026-09-11T09:00:00.000Z", saida: "2026-09-11T09:01:00.000Z" });
    });

    it("velocidade baixa mas nao-zero (deriva de GPS parado, ate 5km/h): ainda confirma", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:00:00.000Z", velocidade: 3 },
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:01:00.000Z", velocidade: 5 },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: "2026-09-11T09:00:00.000Z", saida: "2026-09-11T09:01:00.000Z" });
    });

    it("comeca rapido e para de verdade: so' o trecho parado conta, chegada/saida refletem so' o dwell real", () => {
      const posicoes = [
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:00:00.000Z", velocidade: 45 }, // passando, nao conta
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:01:00.000Z", velocidade: 0 }, // parou
        { lat: -22.0, lng: -43.0, criado_em: "2026-09-11T09:05:00.000Z", velocidade: 0 }, // ainda parado
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [LOJA_A]);
      expect(visita).toEqual({ id: "NF1", chegada: "2026-09-11T09:01:00.000Z", saida: "2026-09-11T09:05:00.000Z" });
    });
  });

  // Achado real 08/09 (KPI Nutry Max, placa RQV5F67/KINHA BAR): caminhao
  // ficou parado na PROPRIA BASE a noite inteira (81m do centro dela) --
  // nunca saiu pra rua -- mas o cliente fica coincidentemente a ~508m da
  // base (mesmo bairro), dentro do raio de confirmacao. Sem excluir
  // posicoes DENTRO da base, qualquer cliente perto o bastante do CD
  // "confirma entrega" toda noite so' pelo caminhao estar na garagem.
  describe("exclusao de posicoes dentro da base (achado real 08/09, placa RQV5F67/KINHA BAR)", () => {
    // Cliente a ~508m da base (mesma geometria do caso real: distancia
    // logo ACIMA do raio de base de 500m, mas dentro do raio de entrega).
    const CLIENTE_PERTO_DA_BASE = { id: "NF_BASE", lat: -22.816007, lng: -43.2725 };

    it("caminhao so' esteve DENTRO da base a noite toda: NAO confirma cliente proximo, mesmo com posicoes dentro do raio de entrega dele", () => {
      const posicoesNaBase = [
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T02:00:00.000Z", velocidade: 0 }, // 0m da base
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T05:00:00.000Z", velocidade: 0 }, // 3h depois, ainda na base
      ];
      const [visita] = acharVisitasPorPonto(posicoesNaBase, [CLIENTE_PERTO_DA_BASE], [BASE]);
      expect(visita).toEqual({ id: "NF_BASE", chegada: null, saida: null });
    });

    it("mesmo cenario SEM passar basesCentro (parametro opcional): comportamento antigo preservado, confirma (potencialmente errado, mas e' o default documentado)", () => {
      const posicoesNaBase = [
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T02:00:00.000Z", velocidade: 0 },
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T05:00:00.000Z", velocidade: 0 },
      ];
      const [visita] = acharVisitasPorPonto(posicoesNaBase, [CLIENTE_PERTO_DA_BASE]);
      expect(visita.chegada).not.toBeNull();
    });

    it("caminhao sai da base e faz uma parada real perto do cliente: confirma normalmente (a exclusao so' remove o trecho DENTRO da base)", () => {
      const posicoes = [
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T02:00:00.000Z", velocidade: 0 }, // na base
        { lat: -22.816007, lng: -43.2725, criado_em: "2026-08-27T08:00:00.000Z", velocidade: 0 }, // saiu, parou perto do cliente (mesmo ponto do cliente)
        { lat: -22.816007, lng: -43.2725, criado_em: "2026-08-27T08:15:00.000Z", velocidade: 0 },
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T20:00:00.000Z", velocidade: 0 }, // voltou pra base
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [CLIENTE_PERTO_DA_BASE], [BASE]);
      expect(visita).toEqual({ id: "NF_BASE", chegada: "2026-08-27T08:00:00.000Z", saida: "2026-08-27T08:15:00.000Z" });
    });
  });

  // Achado real 09/09 (auditoria do fix acima, cruzando o cache de
  // geocodificacao com as coordenadas das 2 bases da Nutry Max): a base da
  // Penha fica no meio de um bairro industrial ("Penha Circular") com
  // varios clientes reais cadastrados a MENOS de 500m dela (ex.: "RUA DO
  // FEIJAO, 760" a so' 16m do centro da base). O filtro CEGO por raio
  // absoluto (remover toda posicao a <=500m de QUALQUER base antes de
  // checar qualquer ponto) tornava esses clientes estruturalmente
  // inconfirmaveis -- os 2 circulos de 500m (base e cliente) praticamente
  // coincidem quando a distancia entre eles e' so' de dezenas de metros,
  // entao nenhuma posicao real de entrega sobrava. Corrigido pra
  // comparacao relativa (`estaMaisPertoDaBaseQueDoPonto`): so' descarta a
  // posicao se ela estiver mais perto da base do que do proprio ponto.
  describe("cliente muito perto da base (achado real 09/09, bairro Penha Circular)", () => {
    // ~273m da base -- DENTRO do raio de exclusao de base (500m), geometria
    // real observada no cache de geocodificacao (varios clientes entre 16m
    // e 500m da base da Penha).
    const CLIENTE_MUITO_PERTO_DA_BASE = { id: "NF_VIZINHO_BASE", lat: -22.816007, lng: -43.275163 };

    it("caminhao para literalmente na porta do cliente (mais perto dele que da base): confirma, mesmo a posicao caindo dentro do raio de exclusao de base", () => {
      const posicoes = [
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T02:00:00.000Z", velocidade: 0 }, // na base
        { lat: -22.816007, lng: -43.275163, criado_em: "2026-08-27T09:00:00.000Z", velocidade: 0 }, // parou exatamente no cliente
        { lat: -22.816007, lng: -43.275163, criado_em: "2026-08-27T09:10:00.000Z", velocidade: 0 },
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T20:00:00.000Z", velocidade: 0 }, // voltou pra base
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [CLIENTE_MUITO_PERTO_DA_BASE], [BASE]);
      expect(visita).toEqual({ id: "NF_VIZINHO_BASE", chegada: "2026-08-27T09:00:00.000Z", saida: "2026-08-27T09:10:00.000Z" });
    });

    it("caminhao so' fica na base a noite toda (nunca chega mais perto do cliente do que da base): NAO confirma", () => {
      const posicoes = [
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T02:00:00.000Z", velocidade: 0 },
        { lat: -22.816007, lng: -43.277827, criado_em: "2026-08-27T05:00:00.000Z", velocidade: 0 },
      ];
      const [visita] = acharVisitasPorPonto(posicoes, [CLIENTE_MUITO_PERTO_DA_BASE], [BASE]);
      expect(visita).toEqual({ id: "NF_VIZINHO_BASE", chegada: null, saida: null });
    });
  });
});
