import { describe, it, expect } from "vitest";
import {
  calcularContextoSaidaDeBase,
  calcularDtParSegundos,
  decidirSupressaoDesvioRomaneio,
  distanciaBaseMaisProximaM,
  ehSaltoDeReconciliacaoRomaneio,
  montarLeiturasRetornoBase,
} from "./desvio-supressao-romaneio";
import type { LeituraRetornoBase } from "./desvio";

// ~111,3 km por grau de latitude
const KM = 1 / 111.32;
const BASE = { lat: -22.9, lng: -43.2 };
const LIMIAR = 50_000;

// Veiculo a `km` km ao norte da base.
const aNorteDaBase = (km: number) => ({ lat: BASE.lat + km * KM, lng: BASE.lng });

// Janela de leituras caindo `passoM` por leitura, 15 leituras a cada 60s
// (span 840s), deslocamento real igual a queda (fracao 1,0).
function leiturasRetornoEstrito(inicioM: number, passoM = 700): LeituraRetornoBase[] {
  return Array.from({ length: 15 }, (_, i) => ({
    tSegundos: i * 60,
    distBaseM: inicioM - i * passoM,
    deslocamentoM: i === 0 ? 0 : passoM,
  }));
}

// Retorno por rodovia: queda liquida franca mas com oscilacao ponto-a-ponto
// (derruba o gate estrito, so' o de horario avancado pega).
function leiturasRetornoOscilante(): LeituraRetornoBase[] {
  const dists = [60_000, 58_500, 59_100, 56_800, 54_200, 55_000, 51_300, 48_900, 47_500, 44_800, 42_100, 43_000, 39_400, 36_700, 34_100];
  return dists.map((d, i) => ({ tSegundos: i * 60, distBaseM: d, deslocamentoM: i === 0 ? 0 : 1600 }));
}

const entradaBase = {
  anterior: null,
  pendentes: [] as Array<{ lat: number; lng: number }>,
  centroidesBase: [BASE],
  leiturasRetorno: null as LeituraRetornoBase[] | null,
  hora: 10,
  minuto: 0,
  streakAfastando: 2,
  limiarDestinoRelevanteM: LIMIAR,
  gateSaidaBaseAtivo: true,
};

describe("calcularDtParSegundos", () => {
  it("limite superior: tempo desde a gravacao anterior + 1 periodo de ciclo", () => {
    expect(calcularDtParSegundos(200_000, 140_000, 60)).toBe(120);
  });
  it("fail-open: sem timestamp valido devolve null (o gate nao age)", () => {
    expect(calcularDtParSegundos(200_000, null, 60)).toBeNull();
    expect(calcularDtParSegundos(200_000, undefined, 60)).toBeNull();
    expect(calcularDtParSegundos(200_000, Number.NaN, 60)).toBeNull();
  });
});

describe("ehSaltoDeReconciliacaoRomaneio (gate de salto de reconciliacao, 28/08)", () => {
  it("caso real TTJ-9I18: atraso 20 -> 1 e salto de 20,8km em ~128s (velocidade implicita ~585 km/h) => suprime", () => {
    expect(
      ehSaltoDeReconciliacaoRomaneio({ atrasoAnteriorMin: 20, atrasoAtualMin: 1, movimentoRealM: 20_798, dtParSegundos: 128 })
    ).toBe(true);
  });
  it("atraso caindo SEM salto de posicao (desvio real RQU-5G33, 327m) => nao suprime", () => {
    expect(
      ehSaltoDeReconciliacaoRomaneio({ atrasoAnteriorMin: 20, atrasoAtualMin: 1, movimentoRealM: 327, dtParSegundos: 128 })
    ).toBe(false);
  });
  it("salto plausivel de rodovia (75 km/h) => nao suprime", () => {
    // 4,5km em 216s = 75 km/h
    expect(
      ehSaltoDeReconciliacaoRomaneio({ atrasoAnteriorMin: 20, atrasoAtualMin: 1, movimentoRealM: 4_500, dtParSegundos: 216 })
    ).toBe(false);
  });
  it("FAIL-OPEN: qualquer dado ausente => nao suprime", () => {
    const ok = { atrasoAnteriorMin: 20, atrasoAtualMin: 1, movimentoRealM: 20_798, dtParSegundos: 128 };
    expect(ehSaltoDeReconciliacaoRomaneio({ ...ok, atrasoAnteriorMin: null })).toBe(false);
    expect(ehSaltoDeReconciliacaoRomaneio({ ...ok, atrasoAtualMin: null })).toBe(false);
    expect(ehSaltoDeReconciliacaoRomaneio({ ...ok, movimentoRealM: null })).toBe(false);
    expect(ehSaltoDeReconciliacaoRomaneio({ ...ok, dtParSegundos: null })).toBe(false);
    expect(ehSaltoDeReconciliacaoRomaneio({ ...ok, dtParSegundos: 0 })).toBe(false);
  });
});

describe("decidirSupressaoDesvioRomaneio -- retorno a base", () => {
  const pos = aNorteDaBase(66); // 66km da base => alem dos 50km

  it("retorno sustentado estrito (15 leituras caindo sem interrupcao) => suprimido_retorno_base, em qualquer horario", () => {
    const d = decidirSupressaoDesvioRomaneio({
      ...entradaBase,
      pos,
      leiturasRetorno: leiturasRetornoEstrito(66_000),
      hora: 9,
    });
    expect(d.tipo).toBe("suprimido_retorno_base");
    expect(d.detalhe.leiturasNaJanela).toBe(15);
    expect(d.detalhe.quedaM).toBeGreaterThan(1000);
  });

  it("retorno por rodovia com oscilacao: 14:30 em diante => suprime; antes das 14:30 => nao (gate estrito nao pega)", () => {
    const l = leiturasRetornoOscilante();
    expect(decidirSupressaoDesvioRomaneio({ ...entradaBase, pos, leiturasRetorno: l, hora: 14, minuto: 30 }).tipo).toBe(
      "suprimido_retorno_base"
    );
    expect(decidirSupressaoDesvioRomaneio({ ...entradaBase, pos, leiturasRetorno: l, hora: 14, minuto: 29 }).tipo).toBeNull();
    expect(decidirSupressaoDesvioRomaneio({ ...entradaBase, pos, leiturasRetorno: l, hora: 10, minuto: 0 }).tipo).toBeNull();
  });

  it("um aumento real de distancia no meio da janela derruba o gate estrito (protege desvio local real)", () => {
    const l = leiturasRetornoEstrito(66_000);
    l[7] = { ...l[7], distBaseM: l[6].distBaseM + 500 };
    expect(decidirSupressaoDesvioRomaneio({ ...entradaBase, pos, leiturasRetorno: l, hora: 9 }).tipo).toBeNull();
  });

  it("FAIL-OPEN: janela indisponivel (null ou vazia) => nao suprime", () => {
    expect(decidirSupressaoDesvioRomaneio({ ...entradaBase, pos, leiturasRetorno: null, hora: 16 }).tipo).toBeNull();
    expect(decidirSupressaoDesvioRomaneio({ ...entradaBase, pos, leiturasRetorno: [], hora: 16 }).tipo).toBeNull();
  });

  it("base dentro dos 50km (ela ja' esta nos destinos avaliados) => o gate de retorno nao se aplica", () => {
    const perto = aNorteDaBase(30);
    expect(
      decidirSupressaoDesvioRomaneio({ ...entradaBase, pos: perto, leiturasRetorno: leiturasRetornoEstrito(30_000), hora: 16 }).tipo
    ).toBeNull();
  });

  it("cliente sem base cadastrada => nao suprime", () => {
    expect(
      decidirSupressaoDesvioRomaneio({ ...entradaBase, pos, centroidesBase: [], leiturasRetorno: leiturasRetornoEstrito(66_000) }).tipo
    ).toBeNull();
  });
});

describe("decidirSupressaoDesvioRomaneio -- saida da base sem destino avaliavel", () => {
  // Veiculo a 8km da base, indo rumo ao primeiro cliente a 90km (fora dos 50km).
  const pos = aNorteDaBase(8);
  const anterior = aNorteDaBase(7.8);
  const clienteLonge = aNorteDaBase(98); // 90km a frente do veiculo
  const entradaSaida = { ...entradaBase, pos, anterior, pendentes: [clienteLonge] };

  it("pendentes todos alem de 50km, veiculo se aproximando, >=5km da base, streak baixo => suprimido_saida_base", () => {
    const d = decidirSupressaoDesvioRomaneio(entradaSaida);
    expect(d.tipo).toBe("suprimido_saida_base");
    expect(d.detalhe.pendentesTotal).toBe(1);
  });

  it("GATE_SAIDA_BASE_ATIVO desligado => nao suprime", () => {
    expect(decidirSupressaoDesvioRomaneio({ ...entradaSaida, gateSaidaBaseAtivo: false }).tipo).toBeNull();
  });

  it("rede de seguranca: streak ja' alcancou o limiar elevado (8) => nao suprime", () => {
    expect(decidirSupressaoDesvioRomaneio({ ...entradaSaida, streakAfastando: 8 }).tipo).toBeNull();
    expect(decidirSupressaoDesvioRomaneio({ ...entradaSaida, streakAfastando: 7 }).tipo).toBe("suprimido_saida_base");
  });

  it("veiculo SEM pendente nenhum fica FORA do gate (populacao de recall diferente)", () => {
    expect(decidirSupressaoDesvioRomaneio({ ...entradaSaida, pendentes: [] }).tipo).toBeNull();
  });

  it("existe pendente relevante (dentro de 50km) => nao suprime", () => {
    expect(
      decidirSupressaoDesvioRomaneio({ ...entradaSaida, pendentes: [clienteLonge, aNorteDaBase(20)] }).tipo
    ).toBeNull();
  });

  it("nao se aproximando do pendente distante => nao suprime (sem evidencia positiva de progresso)", () => {
    expect(
      decidirSupressaoDesvioRomaneio({ ...entradaSaida, anterior: aNorteDaBase(8.2) }).tipo
    ).toBeNull();
  });

  it("FAIL-OPEN: sem leitura anterior ou sem base conhecida => nao suprime", () => {
    expect(decidirSupressaoDesvioRomaneio({ ...entradaSaida, anterior: null }).tipo).toBeNull();
    expect(decidirSupressaoDesvioRomaneio({ ...entradaSaida, centroidesBase: [] }).tipo).toBeNull();
  });

  it("perto demais da base (<5km, manobra de patio) => nao suprime", () => {
    expect(
      decidirSupressaoDesvioRomaneio({ ...entradaSaida, pos: aNorteDaBase(3), anterior: aNorteDaBase(2.8) }).tipo
    ).toBeNull();
  });
});

describe("decidirSupressaoDesvioRomaneio -- ordem", () => {
  it("retorno a base e' avaliado antes da saida da base (mesma ordem da Central)", () => {
    const pos = aNorteDaBase(66);
    const d = decidirSupressaoDesvioRomaneio({
      ...entradaBase,
      pos,
      anterior: aNorteDaBase(66.2),
      pendentes: [aNorteDaBase(160)],
      leiturasRetorno: leiturasRetornoEstrito(66_000),
    });
    expect(d.tipo).toBe("suprimido_retorno_base");
  });
});

describe("helpers", () => {
  it("distanciaBaseMaisProximaM escolhe a base mais proxima e devolve null sem base", () => {
    const outra = aNorteDaBase(200);
    const d = distanciaBaseMaisProximaM(aNorteDaBase(10), [outra, BASE]);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(9_900);
    expect(d!).toBeLessThan(10_100);
    expect(distanciaBaseMaisProximaM(aNorteDaBase(10), [])).toBeNull();
  });

  it("montarLeiturasRetornoBase: deslocamento 0 na primeira, distancia ate a base mais proxima em cada leitura", () => {
    const l = montarLeiturasRetornoBase(
      [
        { ...aNorteDaBase(60), t: 0 },
        { ...aNorteDaBase(59), t: 60 },
      ],
      [BASE]
    );
    expect(l[0].deslocamentoM).toBe(0);
    expect(l[1].deslocamentoM).toBeGreaterThan(900);
    expect(l[1].deslocamentoM).toBeLessThan(1100);
    expect(l[0].distBaseM).toBeGreaterThan(l[1].distBaseM);
    expect(l[1].tSegundos).toBe(60);
  });

  it("calcularContextoSaidaDeBase: sem pendente => tudo false", () => {
    expect(
      calcularContextoSaidaDeBase({ pos: aNorteDaBase(8), anterior: aNorteDaBase(7), pendentes: [], limiarDestinoRelevanteM: LIMIAR })
    ).toEqual({ temPendenteRelevante: false, temPendenteForaDoRaio: false, aproximandoDePendenteForaDoRaio: false });
  });
});
