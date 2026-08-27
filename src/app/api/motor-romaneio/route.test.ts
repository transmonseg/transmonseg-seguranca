// Teste das regras NOVAS da Central Romaneio (task B1, 27/08): `noCliente`
// calculado SO' com os pontos do romaneio geocodificado + os 3 detectores de
// parada (parada_longa / parada_anomala / parada_fora_tapete) rodando dentro
// desta rota.
//
// Por que existe (contexto real, nao hipotetico): ate 26/08 nenhum detector
// de parada rodava pra Nutry Max -- foi desligado na Central Unitrac
// (CLIENTES_COM_MOTOR_ROMANEIO_PARALELO, motor/route.ts) porque la o
// `noCliente` so' reconhece ALVO DA UNITRAC e gerava falso positivo, e nunca
// tinha sido implementado aqui. Estes testes travam as duas pontas:
// (1) parado NO ponto do romaneio => noCliente=true e NENHUM alerta de
//     parada (o falso positivo que motivou o desligamento);
// (2) parado LONGE de qualquer ponto do romaneio => os detectores voltam a
//     disparar (o falso negativo que o desligamento criou).
//
// Estilo: mesma abordagem de src/app/api/kpi/base-horarios/route.test.ts --
// as regras vivem em funcoes PURAS exportadas da propria rota, testadas
// direto, sem mockar banco/rede.
import { describe, it, expect } from "vitest";
import {
  calcularNoClienteRomaneio,
  avaliarParadasRomaneio,
  avaliarDentroTapete,
  deveResolverAlertaGerenciado,
  decidirEscopoDoVeiculo,
  deveAvaliarSinalA,
} from "./route";
import { montarPontosDeRomaneio } from "@/lib/romaneio";
import type { PontoEntrega } from "@/lib/unitrac";
import { celulaDe } from "@/lib/celulas";

// Ponto de entrega do romaneio geocodificado, do jeito que
// montarPontosDeRomaneio (@/lib/romaneio) devolve quando NAO ha alvo Unitrac
// nenhum casando por NF: raio cai no default de 50m, codigo/pontoCodigo
// nulos, feito=false.
function pontoRomaneio(lat: number, lng: number, over: Partial<PontoEntrega> = {}): PontoEntrega {
  return {
    lat,
    lng,
    raio: 50,
    ordem: 0,
    nome: "CLIENTE TESTE",
    feito: false,
    situacao: 0,
    codigo: null,
    pontoCodigo: null,
    documento: "123456",
    identificador: null,
    dataInicio: null,
    dataRealizado: null,
    observacoes: null,
    rota: null,
    ...over,
  };
}

// Caso real que motivou a task (RBJ-2J67, romaneio da Nutry Max): caminhao
// parado EM CIMA do ponto de entrega do romaneio, sem nenhum alvo
// correspondente na Unitrac.
const PONTO = { lat: -22.8541, lng: -43.2965 };
// ~120m do ponto -- fora do raio nominal de 50m, dentro de qualquer piso.
const PERTO = { lat: -22.85302, lng: -43.2965 };
// ~250m do ponto -- a FAIXA CRITICA. Com o piso antigo de 150m dava
// noCliente=false (caminhao no cliente virava parada_anomala aos 12min); com
// RAIO_CHEGADA_MIN_M (300m, medido em 01/08 contra 4.441 pontos reais) da
// true. Trava a decisao do fix round 1, finding 1.
const FAIXA_100_300 = { lat: -22.85185, lng: -43.2965 };
// ~2km do ponto -- inequivocamente fora.
const LONGE = { lat: -22.8361, lng: -43.2965 };

describe("calcularNoClienteRomaneio", () => {
  it("parado em cima do ponto do romaneio => noCliente=true (zero Unitrac envolvida)", () => {
    const noCliente = calcularNoClienteRomaneio(
      { lat: PONTO.lat, lng: PONTO.lng, velocidade: 0 },
      [pontoRomaneio(PONTO.lat, PONTO.lng)]
    );
    expect(noCliente).toBe(true);
  });

  it("parado a ~120m do ponto => ainda noCliente=true", () => {
    const noCliente = calcularNoClienteRomaneio(
      { lat: PERTO.lat, lng: PERTO.lng, velocidade: 0 },
      [pontoRomaneio(PONTO.lat, PONTO.lng)]
    );
    expect(noCliente).toBe(true);
  });

  it("parado na faixa 100-300m do ponto geocodificado => noCliente=true (piso e' RAIO_CHEGADA_MIN_M=300, nao 150)", () => {
    // Medicao de 01/08 (unitrac.ts:467-486): 19% das entregas reais acontecem
    // nessa faixa. Com piso de 150m elas viravam parada_anomala aos 12min --
    // o falso positivo que desligou esses detectores pra este cliente.
    const noCliente = calcularNoClienteRomaneio(
      { lat: FAIXA_100_300.lat, lng: FAIXA_100_300.lng, velocidade: 0 },
      [pontoRomaneio(PONTO.lat, PONTO.lng)]
    );
    expect(noCliente).toBe(true);
  });

  it("conta ponto JA ENTREGUE tambem (feito=true) -- e' 'esta no cliente', nao 'tem entrega pendente'", () => {
    const noCliente = calcularNoClienteRomaneio(
      { lat: PONTO.lat, lng: PONTO.lng, velocidade: 0 },
      [pontoRomaneio(PONTO.lat, PONTO.lng, { feito: true })]
    );
    expect(noCliente).toBe(true);
  });

  it("parado longe de qualquer ponto do romaneio => noCliente=false", () => {
    const noCliente = calcularNoClienteRomaneio(
      { lat: LONGE.lat, lng: LONGE.lng, velocidade: 0 },
      [pontoRomaneio(PONTO.lat, PONTO.lng)]
    );
    expect(noCliente).toBe(false);
  });

  it("em movimento em cima do ponto => noCliente=false (mesma regra da Central: exige velocidade 0)", () => {
    const noCliente = calcularNoClienteRomaneio(
      { lat: PONTO.lat, lng: PONTO.lng, velocidade: 12 },
      [pontoRomaneio(PONTO.lat, PONTO.lng)]
    );
    expect(noCliente).toBe(false);
  });

  it("velocidade desconhecida (null) => noCliente=false, nunca assume parado", () => {
    const noCliente = calcularNoClienteRomaneio(
      { lat: PONTO.lat, lng: PONTO.lng, velocidade: null },
      [pontoRomaneio(PONTO.lat, PONTO.lng)]
    );
    expect(noCliente).toBe(false);
  });

  it("ponto sem coordenada usavel (0,0) nao vira 'cliente fantasma' a 5.300km", () => {
    const noCliente = calcularNoClienteRomaneio(
      { lat: PONTO.lat, lng: PONTO.lng, velocidade: 0 },
      [pontoRomaneio(0, 0)]
    );
    expect(noCliente).toBe(false);
  });

  it("sem nenhum ponto de romaneio (lista vazia) => noCliente=false", () => {
    expect(calcularNoClienteRomaneio({ lat: PONTO.lat, lng: PONTO.lng, velocidade: 0 }, [])).toBe(false);
  });

  it("usa o raio real do ponto quando ele e' maior que o piso", () => {
    // 400m de distancia (acima do piso de 300m), raio de 500m no ponto -> dentro.
    const a400m = { lat: -22.85050, lng: -43.2965 };
    const noCliente = calcularNoClienteRomaneio(
      { lat: a400m.lat, lng: a400m.lng, velocidade: 0 },
      [pontoRomaneio(PONTO.lat, PONTO.lng, { raio: 500 })]
    );
    expect(noCliente).toBe(true);
  });
});

// Contexto base: veiculo parado ha 20min, em horario de operacao, fora da
// base, sem POI, sem congestionamento, fora do tapete -- ou seja, TODAS as
// condicoes dos 3 detectores satisfeitas menos `noCliente`.
function ctxParadaSuspeita(over: Partial<Parameters<typeof avaliarParadasRomaneio>[0]> = {}) {
  return {
    paradoMin: 20,
    emOperacao: true,
    foraDaBase: true,
    noCliente: false,
    estavEmMovimento: true,
    esMadrugada: false,
    temPOIProximo: false,
    jaParedoNoCicloAnterior: true,
    vizinhosParados: 0,
    dentroTapete: false as boolean | null,
    riscoAreaAtual: 0,
    ...over,
  };
}

describe("avaliarParadasRomaneio", () => {
  it("CASO DA TASK: parado no ponto do romaneio (noCliente=true) => nenhum dos 3 detectores dispara", () => {
    const alertas = avaliarParadasRomaneio(ctxParadaSuspeita({ noCliente: true }));
    expect(alertas).toEqual([]);
  });

  it("mesma parada, mas noCliente=false (longe de todo ponto do romaneio) => dispara de verdade", () => {
    const alertas = avaliarParadasRomaneio(ctxParadaSuspeita());
    const tipos = alertas.map((a) => a.tipo).sort();
    // 20min: parada_anomala (>=12min, estava em movimento) + parada_fora_tapete
    // (>=3min e dentroTapete===false). parada_longa so' a partir de 90min.
    expect(tipos).toEqual(["parada_anomala", "parada_fora_tapete"]);
  });

  it("parada de 2h fora do cliente => parada_longa entra (parada_anomala sai, >=90min e' dela)", () => {
    const tipos = avaliarParadasRomaneio(ctxParadaSuspeita({ paradoMin: 120 })).map((a) => a.tipo).sort();
    expect(tipos).toEqual(["parada_fora_tapete", "parada_longa"]);
  });

  it("parada de 2h NO ponto do romaneio => nada dispara (era o falso positivo que desligou o detector)", () => {
    expect(avaliarParadasRomaneio(ctxParadaSuspeita({ paradoMin: 120, noCliente: true }))).toEqual([]);
  });

  it("dentro da base nao dispara nada, mesmo com noCliente=false", () => {
    expect(avaliarParadasRomaneio(ctxParadaSuspeita({ foraDaBase: false }))).toEqual([]);
  });

  it("fora do horario de operacao nao dispara nada", () => {
    expect(avaliarParadasRomaneio(ctxParadaSuspeita({ emOperacao: false }))).toEqual([]);
  });

  it("tapete sem cobertura minima (null) so' tira parada_fora_tapete, nao a parada_anomala", () => {
    const tipos = avaliarParadasRomaneio(ctxParadaSuspeita({ dentroTapete: null })).map((a) => a.tipo);
    expect(tipos).toEqual(["parada_anomala"]);
  });

  it("POI proximo (posto/apoio) suprime os dois -- mesma supressao anti-FP da Central", () => {
    expect(avaliarParadasRomaneio(ctxParadaSuspeita({ temPOIProximo: true }))).toEqual([]);
  });

  it("2+ vizinhos parados (congestionamento) suprime os dois", () => {
    expect(avaliarParadasRomaneio(ctxParadaSuspeita({ vizinhosParados: 2 }))).toEqual([]);
  });

  it("primeiro ciclo parado (anti-pisca) segura a parada_anomala mas nao a fora_tapete", () => {
    const tipos = avaliarParadasRomaneio(ctxParadaSuspeita({ jaParedoNoCicloAnterior: false })).map((a) => a.tipo);
    expect(tipos).toEqual(["parada_fora_tapete"]);
  });

  it("area de risco alta deixa a parada_fora_tapete critica, area neutra deixa em atencao", () => {
    const neutra = avaliarParadasRomaneio(ctxParadaSuspeita({ riscoAreaAtual: 0 }))
      .find((a) => a.tipo === "parada_fora_tapete");
    const risco = avaliarParadasRomaneio(ctxParadaSuspeita({ riscoAreaAtual: 40 }))
      .find((a) => a.tipo === "parada_fora_tapete");
    expect(neutra?.nivel).toBe("atencao");
    expect(risco?.nivel).toBe("critico");
  });

  it("rota concluida NAO suprime parada_longa nesta rota -- avaliarParadasRomaneio nem aceita entregasFeitas/Total (decisao registrada)", () => {
    // Na Central, detectarParadaLonga recebe entregasFeitas/entregasTotal e
    // se cala quando a rota acabou, porque la o retorno_tardio cobre esse
    // caso. A Central Romaneio nao tem retorno_tardio -- passar esses
    // parametros aqui viraria falso negativo puro.
    const tipos = avaliarParadasRomaneio(ctxParadaSuspeita({ paradoMin: 120 })).map((a) => a.tipo).sort();
    expect(tipos).toContain("parada_longa");
  });
});

// ─── Task B2 (27/08): gate de escopo separado em dois efeitos ──────────────
// Ate a B2, `route.ts` tinha um `continue` no topo do loop que pulava o
// veiculo INTEIRO quando ele tinha pelo menos um alvo na Unitrac. Aquele
// gate foi criado em 24/08 por um motivo real e medido (70% da frota
// disparando "desvio" duplicado, quase flood) -- mas ele so' vale pro DESVIO:
// a Central Unitrac esta com os 3 detectores de parada DESLIGADOS pro cliente
// inteiro (CLIENTES_COM_MOTOR_ROMANEIO_PARALELO), entao pular o veiculo
// inteiro deixava ~70% da frota sem detector de parada NENHUM nos dois
// pipelines. Estes testes travam as duas pontas da separacao.
describe("decidirEscopoDoVeiculo", () => {
  // 4096 = Nutry Max, o unico cod_user_unitrac em
  // CLIENTES_COM_MOTOR_ROMANEIO_PARALELO (@/lib/config-clientes) -- a mesma
  // lista que DESLIGA os 3 detectores de parada na Central Unitrac.
  const NUTRY = "4096";

  it("veiculo SEM alvo Unitrac: avalia desvio E paradas (comportamento historico, nao mudou)", () => {
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 0, codUserUnitrac: NUTRY }))
      .toEqual({ avaliaDesvio: true, avaliaParadas: true });
  });

  it("CASO DA TASK B2: veiculo COM alvo Unitrac avalia paradas, mas NUNCA desvio", () => {
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 1, codUserUnitrac: NUTRY }))
      .toEqual({ avaliaDesvio: false, avaliaParadas: true });
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 37, codUserUnitrac: NUTRY }))
      .toEqual({ avaliaDesvio: false, avaliaParadas: true });
  });

  it("ter alvo Unitrac NUNCA desliga as paradas -- so o desvio (regressao da B2)", () => {
    for (const n of [0, 1, 2, 5, 100]) {
      expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: n, codUserUnitrac: NUTRY }).avaliaParadas).toBe(true);
    }
  });

  // ─── Achado I5 da revisao final de branch (27/08) ───
  it("cliente FORA da lista: paradas DESLIGADAS aqui (a Central Unitrac cobre)", () => {
    // Sem este corte, o dia em que um segundo cliente ganhar romaneio os 3
    // detectores rodam em DOBRO pra ele: a Central Unitrac cobre normalmente
    // (nao desligou nada, porque ele nao esta na lista) e esta rota tambem.
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 0, codUserUnitrac: "4586" }))
      .toEqual({ avaliaDesvio: true, avaliaParadas: false });
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 3, codUserUnitrac: "9999" }))
      .toEqual({ avaliaDesvio: false, avaliaParadas: false });
  });

  it("cliente sem cod_user_unitrac cadastrado: paradas desligadas (fail-safe contra duplicata)", () => {
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 0, codUserUnitrac: null }).avaliaParadas).toBe(false);
  });

  it("o gate de parada NAO mexe no gate de desvio, e vice-versa", () => {
    // Os dois efeitos sao independentes de proposito: desvio depende so de
    // alvo Unitrac, parada depende so do cliente.
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 0, codUserUnitrac: "outro" }).avaliaDesvio).toBe(true);
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 9, codUserUnitrac: NUTRY }).avaliaParadas).toBe(true);
  });
});

describe("deveAvaliarSinalA", () => {
  function ctxSinalA(over: Partial<Parameters<typeof deveAvaliarSinalA>[0]> = {}) {
    return {
      avaliaDesvio: true,
      fresco: true,
      suspensoPorChegada: false,
      emCarenciaDeBase: false,
      paradoSemSeMover: false,
      movimentoInsignificante: false,
      qtdDestinosRelevantes: 3,
      ...over,
    };
  }

  it("PROTECAO DE 24/08: veiculo com alvo Unitrac nunca avalia o Sinal A, mesmo com tudo o resto favoravel", () => {
    expect(deveAvaliarSinalA(ctxSinalA({ avaliaDesvio: false }))).toBe(false);
  });

  it("REGRESSAO: veiculo sem alvo Unitrac com condicoes favoraveis avalia, exatamente como antes da B2", () => {
    expect(deveAvaliarSinalA(ctxSinalA())).toBe(true);
  });

  it("REGRESSAO: os 6 gates historicos do Sinal A continuam valendo um a um", () => {
    expect(deveAvaliarSinalA(ctxSinalA({ fresco: false }))).toBe(false);
    expect(deveAvaliarSinalA(ctxSinalA({ suspensoPorChegada: true }))).toBe(false);
    expect(deveAvaliarSinalA(ctxSinalA({ emCarenciaDeBase: true }))).toBe(false);
    expect(deveAvaliarSinalA(ctxSinalA({ paradoSemSeMover: true }))).toBe(false);
    expect(deveAvaliarSinalA(ctxSinalA({ movimentoInsignificante: true }))).toBe(false);
    expect(deveAvaliarSinalA(ctxSinalA({ qtdDestinosRelevantes: 0 }))).toBe(false);
  });
});

describe("B2 fim-a-fim (composicao das regras puras)", () => {
  // Caso central da task: caminhao COM alvo Unitrac (ou seja, dos ~70% que o
  // gate antigo matava), parado 20min num lugar que NAO e' ponto do romaneio.
  const linhasRomaneio = [
    { nf: "123456", clienteNome: "CLIENTE A", lat: PONTO.lat, lng: PONTO.lng, presencaConfirmadaEm: null },
  ];
  // Alvo Unitrac existe pra este veiculo -- e' o que ligava o `continue` antigo.
  // feito=true e raio=400 sao justamente os dois campos que o alvo IMPOE em
  // montarPontosDeRomaneio quando ele e' passado; com [] os dois caem pro
  // valor do romaneio (feito=false, raio default 50).
  const alvosUnitrac = [
    pontoRomaneio(PONTO.lat, PONTO.lng, { feito: true, raio: 400, documento: "123456" }),
  ];

  it("veiculo COM alvo Unitrac parado longe do romaneio: os 3 detectores avaliam e disparam, desvio nao roda", () => {
    const escopo = decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: alvosUnitrac.length, codUserUnitrac: "4096" });
    expect(escopo.avaliaDesvio).toBe(false);
    expect(escopo.avaliaParadas).toBe(true);

    // A rota passa [] literal aqui de proposito (decisao de produto da B2):
    // a Central Romaneio nunca mistura marcacao Unitrac em `pontos`.
    const pontos = montarPontosDeRomaneio(linhasRomaneio, []);
    expect(pontos).toHaveLength(1);
    expect(pontos[0].feito).toBe(false); // veio do romaneio, nao do alvo Unitrac

    const noCliente = calcularNoClienteRomaneio({ ...LONGE, velocidade: 0 }, pontos);
    expect(noCliente).toBe(false);

    const alertas = avaliarParadasRomaneio(ctxParadaSuspeita({ noCliente }));
    expect(alertas.map((a) => a.tipo).sort()).toEqual(["parada_anomala", "parada_fora_tapete"]);
    expect(alertas.some((a) => a.tipo === "desvio")).toBe(false);
  });

  it("mesmo veiculo COM alvo Unitrac, mas parado EM CIMA do ponto do romaneio: nada dispara", () => {
    const pontos = montarPontosDeRomaneio(linhasRomaneio, []);
    const noCliente = calcularNoClienteRomaneio({ ...PONTO, velocidade: 0 }, pontos);
    expect(noCliente).toBe(true);
    expect(avaliarParadasRomaneio(ctxParadaSuspeita({ noCliente }))).toEqual([]);
  });

  it("veiculo SEM alvo Unitrac: continua avaliando desvio E paradas, sem regressao", () => {
    expect(decidirEscopoDoVeiculo({ qtdAlvosUnitracDoVeiculo: 0, codUserUnitrac: "4096" }))
      .toEqual({ avaliaDesvio: true, avaliaParadas: true });
    // Antes da B2 a rota passava `pontosUnitracVeiculo`, que pra ESTE veiculo
    // ja' era [] na pratica -- ou seja, pra ele o argumento literal e' o
    // mesmo dado de sempre e nada mudou.
    const pontos = montarPontosDeRomaneio(linhasRomaneio, []);
    const noCliente = calcularNoClienteRomaneio({ ...PONTO, velocidade: 0 }, pontos);
    expect(noCliente).toBe(true);
    expect(avaliarParadasRomaneio(ctxParadaSuspeita({ noCliente }))).toEqual([]);
  });

  it("o que o [] literal REALMENTE muda: feito, raio e o fallback de coordenada saem do alvo Unitrac", () => {
    // Este e' o teste que prova a decisao do brief (item 2). Passar o alvo
    // Unitrac (comportamento antigo, so' alcancavel agora que o veiculo com
    // alvo nao e' mais pulado inteiro) contamina 3 campos de `pontos`:
    const comAlvo = montarPontosDeRomaneio(linhasRomaneio, alvosUnitrac);
    const semAlvo = montarPontosDeRomaneio(linhasRomaneio, []);

    // (1) `feito` vinha do status ao vivo da Unitrac...
    expect(comAlvo[0].feito).toBe(true);
    // ...e agora e' romaneio puro (presencaConfirmadaEm === null).
    expect(semAlvo[0].feito).toBe(false);

    // (2) `raio` vinha do alvo; agora cai no default de 50m do romaneio.
    expect(comAlvo[0].raio).toBe(400);
    expect(semAlvo[0].raio).toBe(50);

    // (3) fallback de coordenada: linha SEM geocode proprio sobrevivia
    // herdando a coordenada do alvo, e agora e' descartada.
    const semGeocode = [
      { nf: "123456", clienteNome: "CLIENTE A", lat: null, lng: null, presencaConfirmadaEm: null },
    ];
    expect(montarPontosDeRomaneio(semGeocode, alvosUnitrac)).toHaveLength(1);
    expect(montarPontosDeRomaneio(semGeocode, [])).toHaveLength(0);

    // Os 3 empurram na MESMA direcao: menos ponto de "estou no cliente" e raio
    // menor => noCliente menos propenso a true => MAIS parada disparando,
    // nunca menos ([[feedback_desvio_priorizar_recall]]). O caso do raio, em
    // numero: parado a ~250m do ponto, com o raio de 400m do alvo o veiculo
    // esta' no cliente; sem ele o piso RAIO_CHEGADA_MIN_M (300m) ainda cobre
    // -- mas a partir de 300m o veredito passa a divergir.
    expect(calcularNoClienteRomaneio({ ...FAIXA_100_300, velocidade: 0 }, comAlvo)).toBe(true);
    expect(calcularNoClienteRomaneio({ ...FAIXA_100_300, velocidade: 0 }, semAlvo)).toBe(true);
  });
});

// Fix round 1, finding 2: falha PARCIAL na leitura do tapete (contagem OK,
// células não) não pode virar "todo mundo fora do tapete".
describe("avaliarDentroTapete", () => {
  const CEL = celulaDe(PONTO.lat, PONTO.lng);

  it("cobertura OK e celula do veiculo no tapete => true", () => {
    expect(
      avaliarDentroTapete({
        confiavel: true,
        contagemCelulasCliente: 5000,
        celulasCliente: new Set([CEL]),
        lat: PONTO.lat,
        lng: PONTO.lng,
      })
    ).toBe(true);
  });

  it("cobertura OK e celula do veiculo FORA do tapete => false (unico caso que dispara o detector)", () => {
    expect(
      avaliarDentroTapete({
        confiavel: true,
        contagemCelulasCliente: 5000,
        celulasCliente: new Set(["celula-de-outro-lugar"]),
        lat: PONTO.lat,
        lng: PONTO.lng,
      })
    ).toBe(false);
  });

  it("cobertura abaixo do piso (cold-start) => null, nunca false", () => {
    expect(
      avaliarDentroTapete({
        confiavel: true,
        contagemCelulasCliente: 299,
        celulasCliente: new Set(),
        lat: PONTO.lat,
        lng: PONTO.lng,
      })
    ).toBeNull();
  });

  it("REGRESSAO: leitura nao confiavel com contagem alta e celulas vazias => null, nao false (senao seria flood fleet-wide)", () => {
    expect(
      avaliarDentroTapete({
        confiavel: false,
        contagemCelulasCliente: 150000,
        celulasCliente: new Set(),
        lat: PONTO.lat,
        lng: PONTO.lng,
      })
    ).toBeNull();
  });
});

// Fix round 1, finding 3: o auto-resolve novo só pode fechar o que o ciclo
// realmente avaliou.
describe("deveResolverAlertaGerenciado", () => {
  const base = {
    tipo: "parada_anomala",
    disparouNesteCiclo: false,
    silenciado: false,
    podeFecharParadas: true,
    podeFecharForaTapete: true,
  };

  it("tipo que disparou neste ciclo nunca e' fechado", () => {
    expect(deveResolverAlertaGerenciado({ ...base, disparouNesteCiclo: true })).toBe(false);
  });

  it("tipo silenciado por falso positivo nunca e' fechado (preserva contexto do operador)", () => {
    expect(deveResolverAlertaGerenciado({ ...base, silenciado: true })).toBe(false);
  });

  it("parada avaliada e condicao acabou => fecha", () => {
    expect(deveResolverAlertaGerenciado(base)).toBe(true);
  });

  it("REGRESSAO: ciclo que NAO conseguiu avaliar a parada (Overpass fora, congestionamento, parado_desde ausente) nao fecha", () => {
    expect(deveResolverAlertaGerenciado({ ...base, podeFecharParadas: false })).toBe(false);
    expect(deveResolverAlertaGerenciado({ ...base, tipo: "parada_longa", podeFecharParadas: false })).toBe(false);
  });

  it("parada_fora_tapete depende da sua propria flag (tapete pode ser 'nao sei' com o resto avaliado)", () => {
    expect(
      deveResolverAlertaGerenciado({ ...base, tipo: "parada_fora_tapete", podeFecharForaTapete: false })
    ).toBe(false);
    expect(
      deveResolverAlertaGerenciado({ ...base, tipo: "parada_fora_tapete", podeFecharForaTapete: true })
    ).toBe(true);
  });

  it("outro tipo gerenciado qualquer mantem o comportamento de antes da B1", () => {
    expect(
      deveResolverAlertaGerenciado({
        ...base,
        tipo: "excesso",
        podeFecharParadas: false,
        podeFecharForaTapete: false,
      })
    ).toBe(true);
  });
});
