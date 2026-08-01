import { describe, it, expect } from "vitest";
import {
  atualizarPlacar,
  paradaRecentePertoDeEntrega,
  padraoEntrega,
  destinoAlinhadoAproximando,
  classeViariaDeveEmitir,
  CLASSE_VIARIA_PLACAR_MINIMO,
  type SinaisPlacar,
  type PontoJanela,
  type DestinoPlacar,
} from "./placar-desvio";

// Sinais neutros -- nenhum soma, nenhum desconta. s3ForaDoCorredor:null =
// corredor indisponivel neste ciclo (nem S3 soma, nem D4 desconta).
const SINAIS_NENHUM: SinaisPlacar = {
  s1AfastandoDeTudo: false,
  s2RumoDivergente: false,
  s3ForaDoCorredor: null,
  s4CelulaDesconhecida: false,
  s5DiaEstagnado: false,
  d1ParadaPertoDeEntrega: false,
  d2PadraoEntrega: false,
  d3DestinoAlinhadoAproximando: false,
};

function tISO(baseMs: number, addSeg: number): string {
  return new Date(baseMs + addSeg * 1000).toISOString();
}

// Ponto a exatamente distM metros ao norte de base, deslocando so a
// latitude -- com longitude fixa a formula de Haversine e exata (arco de
// meridiano), sem aproximacao, entao os testes de fronteira em metros
// batem certinho.
function pontoAoNorte(base: { lat: number; lng: number }, distM: number): { lat: number; lng: number } {
  const R = 6371000;
  const dLatGraus = (distM / R) * (180 / Math.PI);
  return { lat: base.lat + dLatGraus, lng: base.lng };
}

describe("atualizarPlacar", () => {
  it("aplica decaimento de 10% por ciclo quando nenhum sinal dispara (100 -> 90)", () => {
    const r = atualizarPlacar(100, SINAIS_NENHUM, false);
    expect(r.placar).toBe(90);
  });

  it("clampa em 100 quando a soma dos sinais positivos estoura o teto", () => {
    const sinais: SinaisPlacar = {
      ...SINAIS_NENHUM,
      s1AfastandoDeTudo: true,
      s2RumoDivergente: true,
      s3ForaDoCorredor: true,
      s4CelulaDesconhecida: true,
      s5DiaEstagnado: true,
    };
    const r = atualizarPlacar(100, sinais, false);
    expect(r.placar).toBe(100);
  });

  it("clampa em 0 quando os descontos superam o placar anterior", () => {
    const sinais: SinaisPlacar = {
      ...SINAIS_NENHUM,
      s3ForaDoCorredor: false, // dentro do corredor -> desconta D4
      d1ParadaPertoDeEntrega: true,
      d2PadraoEntrega: true,
      d3DestinoAlinhadoAproximando: true,
    };
    const r = atualizarPlacar(0, sinais, false);
    expect(r.placar).toBe(0);
  });

  it("suspensoPorChegada zera o placar na hora, ignorando os sinais do ciclo", () => {
    const sinais: SinaisPlacar = {
      ...SINAIS_NENHUM,
      s1AfastandoDeTudo: true,
      s2RumoDivergente: true,
      s3ForaDoCorredor: true,
    };
    const r = atualizarPlacar(85, sinais, true);
    expect(r).toEqual({ placar: 0, componentes: { zeradoPorChegada: true } });
  });

  it("decaimento puro (sem sinal) nao zera sozinho abaixo do piso -- 4 -> 3.6, ainda acima de PLACAR_PISO_ZERAR", () => {
    const r = atualizarPlacar(4, SINAIS_NENHUM, false);
    expect(r.placar).toBeCloseTo(3.6, 6); // 4*0.9 = 3.6, nao ha snap (>=0.5)
  });

  it("decaimento puro abaixo do piso zera de vez (snap) -- 0.55 -> 0.495 (<0.5) vira 0", () => {
    const r = atualizarPlacar(0.55, SINAIS_NENHUM, false);
    expect(r.placar).toBe(0); // 0.55*0.9 = 0.495 < PLACAR_PISO_ZERAR(0.5) -> snap pra 0
  });

  it("s3ForaDoCorredor null nao soma S3 nem desconta D4 -- corredor indisponivel no ciclo", () => {
    const rNull = atualizarPlacar(50, { ...SINAIS_NENHUM, s3ForaDoCorredor: null }, false);
    expect(rNull.placar).toBe(45); // 50*0.9 + 0

    const rFalse = atualizarPlacar(50, { ...SINAIS_NENHUM, s3ForaDoCorredor: false }, false);
    expect(rFalse.placar).toBe(39); // 50*0.9 - 6 (D4: dentro do corredor)

    const rTrue = atualizarPlacar(50, { ...SINAIS_NENHUM, s3ForaDoCorredor: true }, false);
    expect(rTrue.placar).toBe(53); // 50*0.9 + 8 (S3: fora do corredor)
  });

  it("cenario entrega normal (D1+D2 true, todos S false) por 5 ciclos partindo de 30 -> termina em 0", () => {
    const sinais: SinaisPlacar = {
      ...SINAIS_NENHUM,
      s3ForaDoCorredor: false, // S false -- corredor conhecido, dentro
      d1ParadaPertoDeEntrega: true,
      d2PadraoEntrega: true,
    };
    // Desconto por ciclo: d1(-15) + d2(-6) + d4DentroDoCorredor(-6) = -27.
    // ciclo1: 30*0.9 - 27 = 27 - 27 = 0 (clamp em 0 -- ja no 1o ciclo, o
    // desconto sozinho ja supera o placar inicial). Ciclos seguintes:
    // 0*0.9 - 27 = -27 -> clamp em 0. Fica em 0 os 5 ciclos.
    let placar = 30;
    const historico: number[] = [];
    for (let i = 0; i < 5; i++) {
      placar = atualizarPlacar(placar, sinais, false).placar;
      historico.push(placar);
    }
    expect(historico[0]).toBeCloseTo(0, 6);
    expect(historico[1]).toBeCloseTo(0, 6);
    expect(historico[2]).toBeCloseTo(0, 6);
    expect(historico[3]).toBeCloseTo(0, 6);
    expect(historico[4]).toBeCloseTo(0, 6);
  });

  it("cenario desvio real (S1+S2+S3 true, descontos false) partindo de 0 -> cruza 40 ate o 3o ciclo e 70 ate o 5o", () => {
    const sinais: SinaisPlacar = {
      ...SINAIS_NENHUM,
      s1AfastandoDeTudo: true,
      s2RumoDivergente: true,
      s3ForaDoCorredor: true,
    };
    // Soma por ciclo: s1(+8) + s2(+6) + s3(+8) = +22.
    // c1: 0*0.9+22 = 22
    // c2: 22*0.9+22 = 41.8
    // c3: 41.8*0.9+22 = 59.62
    // c4: 59.62*0.9+22 = 75.658
    // c5: 75.658*0.9+22 = 90.0922
    let placar = 0;
    const historico: number[] = [];
    for (let i = 0; i < 5; i++) {
      placar = atualizarPlacar(placar, sinais, false).placar;
      historico.push(placar);
    }
    expect(historico[0]).toBeCloseTo(22, 6);
    expect(historico[1]).toBeCloseTo(41.8, 6);
    expect(historico[2]).toBeCloseTo(59.62, 6);
    expect(historico[3]).toBeCloseTo(75.658, 6);
    expect(historico[4]).toBeCloseTo(90.0922, 6);
    expect(historico[2]).toBeGreaterThanOrEqual(40); // 3o ciclo
    expect(historico[4]).toBeGreaterThanOrEqual(70); // 5o ciclo
  });
});

describe("paradaRecentePertoDeEntrega", () => {
  const base = Date.parse("2026-08-01T12:00:00.000Z");

  it("run parado por 119s ate a retomada do movimento NAO conta (abaixo do minimo de 120s)", () => {
    // Nova semantica (achado producao 01/08): duracao NAO e mais
    // zero-a-zero entre amostras paradas -- e do 1o ponto parado ate a 1a
    // amostra em MOVIMENTO depois do run. Aqui o run tem so 1 amostra
    // parada (t=0); a retomada em t=119 fecha o run com duracao 119-0=119s.
    const destino: DestinoPlacar = { lat: -22, lng: -43, raio: 50, codigo: "D1A" };
    const janela: PontoJanela[] = [
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: destino.lat, lng: destino.lng, velocidade: 20, criadoEm: tISO(base, 119) }, // retoma o movimento -- fecha o run
    ];
    expect(paradaRecentePertoDeEntrega(janela, [destino])).toBe(false);
  });

  it("run parado por 120s ate a retomada do movimento conta", () => {
    const destino: DestinoPlacar = { lat: -22, lng: -43, raio: 50, codigo: "D1A" };
    const janela: PontoJanela[] = [
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: destino.lat, lng: destino.lng, velocidade: 20, criadoEm: tISO(base, 120) }, // retoma o movimento -- fecha o run em 120-0=120s
    ];
    expect(paradaRecentePertoDeEntrega(janela, [destino])).toBe(true);
  });

  it("amostra de 3km/h (arrasto de GPS) no meio de zeros NAO quebra o run -- run unico de 180s conta", () => {
    // Achado producao 01/08: com a semantica antiga (corte em
    // velocidade===0), esta amostra de 3km/h terminaria o 1o run em t=30
    // (zero-a-zero: 30-0=30s) e comecaria um 2o run em t=90 que so fecharia
    // no fim da janela (zero-a-zero: 150-90=60s) -- os dois pedacos abaixo
    // dos 120s, D1 NAO dispararia. Com PARADA_VELOCIDADE_MAX_KMH=5, a
    // amostra de 3km/h continua contando como "parado": um UNICO run de
    // t=0 ate a retomada em t=180 -- duracao 180-0=180s >=120, dispara.
    const destino: DestinoPlacar = { lat: -22, lng: -43, raio: 50, codigo: "D1C" };
    const janela: PontoJanela[] = [
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 30) },
      { lat: destino.lat, lng: destino.lng, velocidade: 3, criadoEm: tISO(base, 60) }, // arrasto de GPS -- <=5km/h, continua "parado"
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 90) },
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 120) },
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 150) },
      { lat: destino.lat, lng: destino.lng, velocidade: 20, criadoEm: tISO(base, 180) }, // retoma o movimento -- fecha o run
    ];
    expect(paradaRecentePertoDeEntrega(janela, [destino])).toBe(true);
  });

  it("4 amostras zeradas de 30 em 30s + retomada 30s depois da ultima = duracao de 120s (nao 90s zero-a-zero)", () => {
    // 4 amostras zero em t=0,30,60,90 (span zero-a-zero = 90-0=90s, a conta
    // que a semantica ANTIGA usava e que sub-media paradas reais) + retomada
    // do movimento em t=120. Duracao (nova semantica) = do PRIMEIRO ponto
    // parado (t=0) ate a retomada (t=120) = 120s. Com amostragem de ~30s,
    // e' a melhor aproximacao da parada real: o veiculo estava parado em
    // algum momento antes de t=120, nao so ate a ultima amostra zerada.
    const destino: DestinoPlacar = { lat: -22, lng: -43, raio: 50, codigo: "D1D" };
    const janela: PontoJanela[] = [
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 30) },
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 60) },
      { lat: destino.lat, lng: destino.lng, velocidade: 0, criadoEm: tISO(base, 90) },
      { lat: destino.lat, lng: destino.lng, velocidade: 20, criadoEm: tISO(base, 120) }, // retoma o movimento -- fecha o run em 120-0=120s
    ];
    expect(paradaRecentePertoDeEntrega(janela, [destino])).toBe(true); // 120 >= D1_PARADA_MIN_SEG (120), no limite
  });

  it("parada a raio+299m da entrega conta", () => {
    const destino: DestinoPlacar = { lat: -10, lng: -40, raio: 50, codigo: "D1B" };
    const p = pontoAoNorte(destino, 349); // raio(50) + 299
    const janela: PontoJanela[] = [
      { lat: p.lat, lng: p.lng, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: p.lat, lng: p.lng, velocidade: 0, criadoEm: tISO(base, 130) },
    ];
    expect(paradaRecentePertoDeEntrega(janela, [destino])).toBe(true);
  });

  it("parada a raio+301m da entrega NAO conta", () => {
    const destino: DestinoPlacar = { lat: -10, lng: -40, raio: 50, codigo: "D1B" };
    const p = pontoAoNorte(destino, 351); // raio(50) + 301
    const janela: PontoJanela[] = [
      { lat: p.lat, lng: p.lng, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: p.lat, lng: p.lng, velocidade: 0, criadoEm: tISO(base, 130) },
    ];
    expect(paradaRecentePertoDeEntrega(janela, [destino])).toBe(false);
  });

  it("janela vazia -> false", () => {
    const destino: DestinoPlacar = { lat: -22, lng: -43, raio: 50, codigo: "D1A" };
    expect(paradaRecentePertoDeEntrega([], [destino])).toBe(false);
  });
});

describe("padraoEntrega", () => {
  const base = Date.parse("2026-08-01T12:00:00.000Z");

  it("media 24 km/h + 2 paradas -> true", () => {
    const janela: PontoJanela[] = [
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 60) },
      { lat: -22, lng: -43, velocidade: 72, criadoEm: tISO(base, 120) }, // fecha parada 1 -- duracao (nova semantica) 120-0=120s
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 180) },
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 240) },
      { lat: -22, lng: -43, velocidade: 72, criadoEm: tISO(base, 300) }, // fecha parada 2 -- duracao 300-180=120s
    ];
    // media = (0+0+72+0+0+72)/6 = 24
    expect(padraoEntrega(janela)).toBe(true);
  });

  it("media 26 km/h (acima do maximo de 25) -> false mesmo com 2 paradas", () => {
    const janela: PontoJanela[] = [
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 60) },
      { lat: -22, lng: -43, velocidade: 78, criadoEm: tISO(base, 120) },
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 180) },
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 240) },
      { lat: -22, lng: -43, velocidade: 78, criadoEm: tISO(base, 300) },
    ];
    // media = (0+0+78+0+0+78)/6 = 26
    expect(padraoEntrega(janela)).toBe(false);
  });

  it("1 parada so (mesmo com media baixa e duracao >=60s) -> false", () => {
    const janela: PontoJanela[] = [
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 0) },
      { lat: -22, lng: -43, velocidade: 0, criadoEm: tISO(base, 60) },
      { lat: -22, lng: -43, velocidade: 45, criadoEm: tISO(base, 120) }, // fecha a unica parada -- duracao 120-0=120s
    ];
    // media = (0+0+45)/3 = 15 (dentro do limite), mas so 1 run parado
    expect(padraoEntrega(janela)).toBe(false);
  });
});

describe("destinoAlinhadoAproximando", () => {
  const posAtual = { lat: -22, lng: -43 };

  it("divergencia 99 graus + dist 1400m + dist caindo (anterior 1600m) -> true", () => {
    const r = destinoAlinhadoAproximando(
      posAtual,
      [{ codigo: "E1", divergenciaGraus: 99, distM: 1400 }],
      { E1: 1600 }
    );
    expect(r).toBe(true);
  });

  it("divergencia 1 grau mas dist 2400m -> false (caso real RQV-6C22 de 01/08: coerencia sozinha nao basta, tem que estar perto tambem)", () => {
    const r = destinoAlinhadoAproximando(
      posAtual,
      [{ codigo: "E2", divergenciaGraus: 1, distM: 2400 }],
      { E2: 2600 } // caindo, mas irrelevante -- falha por estar longe demais (>=1500m)
    );
    expect(r).toBe(false);
  });

  it("dist subindo (nao aproximando) -> false", () => {
    const r = destinoAlinhadoAproximando(
      posAtual,
      [{ codigo: "E3", divergenciaGraus: 50, distM: 1000 }],
      { E3: 900 } // anterior era menor -- distancia esta subindo
    );
    expect(r).toBe(false);
  });

  it("codigo sem dist anterior -> false (primeiro ciclo nao desconta)", () => {
    const r = destinoAlinhadoAproximando(
      posAtual,
      [{ codigo: "E4", divergenciaGraus: 10, distM: 500 }],
      {}
    );
    expect(r).toBe(false);
  });
});

// Gate de emissao do classe_viaria (troca de regra 01/08, ver route.ts
// CLASSE_VIARIA_EXIGE_PLACAR_ATIVO e comentario de CLASSE_VIARIA_PLACAR_MINIMO
// acima): dado real que fundamenta o corte -- 53 alertas classe_viaria/4h,
// 31 medidos, 25 com placar 0, 6 entre 0 e 15, ZERO >=15.
describe("classeViariaDeveEmitir", () => {
  it("placar 0 (o caso mais comum real, 25/31) -> nao emite", () => {
    expect(classeViariaDeveEmitir(0)).toBe(false);
  });

  it("placar abaixo do minimo (ex: 8, dentro da faixa 0-15 real, 6/31) -> nao emite", () => {
    expect(classeViariaDeveEmitir(8)).toBe(false);
  });

  it("placar logo abaixo do minimo (14) -> nao emite", () => {
    expect(classeViariaDeveEmitir(14)).toBe(false);
  });

  it("placar exatamente no minimo (15) -> emite (limiar inclusivo)", () => {
    expect(classeViariaDeveEmitir(CLASSE_VIARIA_PLACAR_MINIMO)).toBe(true);
  });

  it("placar acima do minimo (ex: S1+S2+S3 = 8+6+8 = 22) -> emite", () => {
    expect(classeViariaDeveEmitir(22)).toBe(true);
  });
});
