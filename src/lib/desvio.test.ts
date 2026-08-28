import { describe, it, expect } from "vitest";
import {
  avaliarAfastandoDeTudo,
  avaliarRuaRara,
  montarAlertaDesvio,
  ehSaltoDeReconciliacaoDeAtraso,
} from "./desvio";

describe("ehSaltoDeReconciliacaoDeAtraso", () => {
  it("caso real TTJ-9I18 (28/08): congelado com atraso 20, reconcilia com atraso 1 e salta 20,8km em 68s (1101 km/h implícitos)", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 1, 20798, 68)).toBe(true);
  });

  it("caso real RQV-6I51 (28/08): atraso 15 -> 1, salto de 16,4km em 62s (950 km/h implícitos)", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(15, 1, 16355, 62)).toBe(true);
  });

  it("caso real TTJ-9I18 (21/08, status `resolvido`): 7342m em 69s = 383 km/h -- continua DENTRO do gate, o par é fisicamente impossível mesmo sendo de um desvio real (validado por simulação: o alerta sai 1 leitura depois)", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(16, 1, 7342, 69)).toBe(true);
  });

  // REGRESSÃO (1a revisão independente, 28/08): a versão atraso-only do gate
  // suprimia este caso. RQU-5G33, 22/08, status `resolvido` -- desvio REAL.
  // Assinatura de atraso idêntica à dos alvos (27 -> 1), mas 327m em 62s: é
  // um ciclo NORMAL com a telemetria se normalizando.
  it("NÃO dispara quando o atraso caiu mas a posição quase não mudou -- caso real RQU-5G33 (desvio REAL, atraso 27 -> 1 em 327m/62s)", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(27, 1, 327, 62)).toBe(false);
  });

  // REGRESSÃO (2a revisão independente, 28/08): distância bruta sem olhar o
  // intervalo suprimia ciclos LONGOS mas fisicamente plausíveis -- rodovia de
  // verdade, não artefato.
  it("NÃO dispara em ciclo longo com velocidade plausível -- casos reais RQU-4B93 (5446m/260s = 75 km/h) e RBI-0J25 (4644m/145s = 115 km/h)", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(11, 2, 5446, 260)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(26, 2, 4644, 145)).toBe(false);
  });

  it("NÃO dispara com deslocamento de ciclo saudável mesmo com atraso alto caindo (p50=464m, p95=1517m, p99=2548m no dado real)", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(27, 2, 464, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 1, 1517, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 1, 2548, 60)).toBe(false);
    // RQU-6E83 (26/08, falso_positivo): atraso 27 -> 2, mas só 1229m.
    expect(ehSaltoDeReconciliacaoDeAtraso(27, 2, 1229, 83)).toBe(false);
  });

  it("NÃO dispara com telemetria saudável o tempo todo (ruído genuíno de geometria de estrada, categoria já coberta por LIMIAR_MOVIMENTO_MINIMO_M / streak)", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(1, 1, 20000, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(3, 2, 20000, 60)).toBe(false);
  });

  it("NÃO dispara se o atraso continua alto (telemetria ainda não reconciliou -- o ponto ainda está congelado)", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 19, 20000, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 4, 20000, 60)).toBe(false);
  });

  it("NÃO dispara acima de 60min de atraso anterior -- reconciliação depois de muito tempo sem comunicação é outra categoria (jammer), e no dado real de 21-28/08 os únicos 2 casos (TML-3B11 atraso 132, RQV-3J99 atraso 66) foram classificados como reais pelo operador", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(61, 1, 20000, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(132, 2, 8045, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(66, 2, 13395, 60)).toBe(false);
  });

  it("limites exatos dos limiares calibrados (atraso >=10 e <=60, atual <=3, salto >=4000m, velocidade implícita >=150 km/h)", () => {
    // 4000m em 96s = 150,0 km/h exatos: os dois limiares no fio.
    expect(ehSaltoDeReconciliacaoDeAtraso(10, 3, 4000, 96)).toBe(true);
    expect(ehSaltoDeReconciliacaoDeAtraso(60, 3, 4000, 96)).toBe(true);
    expect(ehSaltoDeReconciliacaoDeAtraso(10, 3, 3999, 96)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(9, 1, 20000, 60)).toBe(false);
    // 4000m em 97s = 148,5 km/h: abaixo do piso de velocidade.
    expect(ehSaltoDeReconciliacaoDeAtraso(10, 3, 4000, 97)).toBe(false);
  });

  it("sem dado de atraso, de movimento ou de intervalo (cold-start, coluna nula, sem anterior) nunca suprime -- na dúvida, avalia", () => {
    expect(ehSaltoDeReconciliacaoDeAtraso(null, 1, 20000, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(20, null, 20000, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 1, null, 60)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 1, 20000, null)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 1, 20000, 0)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(20, 1, 20000, -5)).toBe(false);
    expect(ehSaltoDeReconciliacaoDeAtraso(undefined, undefined, undefined, undefined)).toBe(false);
  });
});

describe("avaliarAfastandoDeTudo", () => {
  it("não acumula streak sem destinos (guard 0 pendentes)", () => {
    const r = avaliarAfastandoDeTudo([], [], 2);
    expect(r).toEqual({ streak: 0, disparou: false, aproximandoAlgum: false });
  });

  it("não acumula streak se o conjunto de destinos mudou de tamanho (entrega confirmada no meio do streak)", () => {
    const r = avaliarAfastandoDeTudo([1000, 2000], [900], 2);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });

  it("decai o streak em 1 (não zera) se aproximou de PELO MENOS UM destino -- achado real 13/08, distância real de rua não é perfeitamente monótona nem numa divergência real (ruído de geometria de estrada não pode apagar streak todo)", () => {
    const r = avaliarAfastandoDeTudo([1100, 900], [1000, 1000], 2);
    expect(r.streak).toBe(1);
    expect(r.disparou).toBe(false); // limiar=2 (16/08b) -- streak=1 ainda não dispara
    expect(r.aproximandoAlgum).toBe(true);
  });

  it("decai até 0 (nunca negativo) com streak já em 0", () => {
    const r = avaliarAfastandoDeTudo([1100, 900], [1000, 1000], 0);
    expect(r.streak).toBe(0);
  });

  it("não dispara na 1a leitura (limiar=2, 16/08b) -- streak=1 só acumula", () => {
    const r = avaliarAfastandoDeTudo([1100, 2100], [1000, 2000], 0);
    expect(r.streak).toBe(1);
    expect(r.disparou).toBe(false);
    expect(r.aproximandoAlgum).toBe(false);
  });

  it("dispara na 2a leitura seguida afastando de todos -- limiar=2, valor escolhido 16/08b apos simulacao real mostrar que streak=1 explodia (14014 disparos/dia) contra distancia real de rua via OSRM", () => {
    const r = avaliarAfastandoDeTudo([1100, 2100], [1000, 2000], 1);
    expect(r.streak).toBe(2);
    expect(r.aproximandoAlgum).toBe(false);
    expect(r.disparou).toBe(true);
  });

  it("não acumula streak em trânsito longo (destino mais próximo além do teto de 300km) -- ruído de rodovia/alça de acesso", () => {
    const r = avaliarAfastandoDeTudo([300_100_100, 300_200_100], [300_100_000, 300_200_000], 2);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });

  it("dispara na 2a leitura assim que o destino mais próximo entra no teto de trânsito de 300km", () => {
    const r = avaliarAfastandoDeTudo([299_900, 300_100], [299_800, 300_000], 1);
    expect(r.streak).toBe(2);
    expect(r.disparou).toBe(true);
  });

  it("aceita teto de trânsito customizado", () => {
    const r = avaliarAfastandoDeTudo([6000], [5000], 2, { limiarTransitoLongoM: 5500 });
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });
});

describe("avaliarRuaRara", () => {
  it("não acumula se a célula é comum (acima do limiar de visitas)", () => {
    const r = avaliarRuaRara(50, false, 1);
    expect(r).toEqual({ streak: 0, disparou: false });
  });

  it("não acumula se está aproximando de algum destino, mesmo em célula rara", () => {
    const r = avaliarRuaRara(0, true, 1);
    expect(r.streak).toBe(0);
    expect(r.disparou).toBe(false);
  });

  it("acumula em célula rara e sem aproximar de nada", () => {
    const r = avaliarRuaRara(1, false, 0);
    expect(r.streak).toBe(1);
    expect(r.disparou).toBe(false); // limiar é 2
  });

  it("dispara na 2a leitura seguida", () => {
    const r = avaliarRuaRara(0, false, 1);
    expect(r.streak).toBe(2);
    expect(r.disparou).toBe(true);
  });
});

describe("montarAlertaDesvio", () => {
  it("retorna null se nenhum sinal disparou", () => {
    const a = montarAlertaDesvio(
      { disparou: false, streak: 0 },
      { disparou: false, streak: 0, celula: "0:0", nVisitas: 10 }
    );
    expect(a).toBeNull();
  });

  it("prioriza afastando-de-tudo quando os dois disparam no mesmo ciclo", () => {
    const a = montarAlertaDesvio(
      { disparou: true, streak: 3 },
      { disparou: true, streak: 2, celula: "0:0", nVisitas: 0 }
    );
    expect(a?.origemDesvio).toBe("afastando_geral");
  });

  it("monta alerta de rua rara com a célula e contagem no motivo", () => {
    const a = montarAlertaDesvio(
      { disparou: false, streak: 0 },
      { disparou: true, streak: 2, celula: "-22900:-43200", nVisitas: 1 }
    );
    expect(a?.tipo).toBe("desvio");
    expect(a?.origemDesvio).toBe("rua_rara_frota");
    expect(a?.motivo).toContain("-22900:-43200");
    expect(a?.motivo).toContain("1");
  });

  it("nasce crítico (nunca 'atencao') pros dois sinais -- resgate 16/08 da Fase Agressiva de 11/07", () => {
    const afastando = montarAlertaDesvio(
      { disparou: true, streak: 1 },
      { disparou: false, streak: 0, celula: "0:0", nVisitas: 10 }
    );
    expect(afastando?.nivel).toBe("critico");
    const ruaRara = montarAlertaDesvio(
      { disparou: false, streak: 0 },
      { disparou: true, streak: 2, celula: "0:0", nVisitas: 0 }
    );
    expect(ruaRara?.nivel).toBe("critico");
  });
});
