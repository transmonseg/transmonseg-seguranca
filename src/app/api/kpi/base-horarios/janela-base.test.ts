import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { acharSaidaEChegadaBase, ajustarJanelaPelasVisitas, calcularJanelaBase } from "./route";

// F2-06 (KN-09, MON-13, plano mestre 23/10): horarios de base completos.
// Fixtures: posicoes_historico real de 22/10 (Lagos e Campos amostrados 1 a
// cada 10 leituras, so' pra ter o dia inteiro num arquivo pequeno).
function lerPosicoes(nome: string) {
  return readFileSync(join(__dirname, "__fixtures__", nome), "utf8").trim().split("\n").slice(1).map((l) => {
    const [criado_em, lat, lng, velocidade, atraso_min] = l.split(",");
    return { criado_em, lat: Number(lat), lng: Number(lng), velocidade: Number(velocidade), atraso_min: Number(atraso_min) };
  });
}
const lerPontos = (nome: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", nome), "utf8"));
// As 3 bases da Nutry Max na tabela `bases` (Penha, Campos, Lagos/Sao Pedro da Aldeia).
const PENHA = { lat: -22.815896899530625, lng: -43.27780385194278 };
const CAMPOS = { lat: -21.68855909005774, lng: -41.31146138885315 };
const LAGOS = { lat: -22.792550000982295, lng: -42.091500000510116 };
const BASES_NUTRY = [PENHA, CAMPOS, LAGOS];

describe("F2-06: visita a ponto a ate' 300 m da base nao mexe na janela (RQU8D91 22/10, ORION)", () => {
  // O carro entra na base as 18:02 BRT e fica. O ORION REFEICOES (Rua do
  // Feijao, a 16 m do centro da base) ganhou "visita" das 21:26 as 22:47 BRT
  // com o carro dormindo na garagem -- virava a "ultima entrega" e a chegada
  // saia vazia (ponte chamada em 24/10 com os pontos do dia: chegadaBase null).
  const posicoes = lerPosicoes("rqu8d91-2026-10-22-noite.csv");
  const pontos = [
    { id: "2438669", lat: -22.820567, lng: -43.279909 }, // WEGA MARINE, ~560 m da base
    { id: "2438671", lat: -22.815826, lng: -43.277945 }, // ORION
    { id: "2438672", lat: -22.815826, lng: -43.277945 }, // ORION
  ];
  const visitas = [
    { id: "2438669", chegada: "2026-10-22T20:47:40.344Z", saida: "2026-10-22T21:02:10.096Z" },
    { id: "2438671", chegada: "2026-10-23T00:26:06.295Z", saida: "2026-10-23T01:47:35.926Z" },
    { id: "2438672", chegada: "2026-10-23T00:26:06.295Z", saida: "2026-10-23T01:47:35.926Z" },
  ];

  it("chegada 18:02 BRT (21:02:43Z) com os pontos; sem os pontos (contrato antigo) continua vazia", () => {
    const bruto = acharSaidaEChegadaBase(posicoes, BASES_NUTRY);
    expect(bruto.chegadaBase).toBe("2026-10-22T21:02:43.886Z");
    expect(ajustarJanelaPelasVisitas(posicoes, BASES_NUTRY, bruto.saidaBase, bruto.chegadaBase, visitas).chegadaBase).toBeNull();
    expect(ajustarJanelaPelasVisitas(posicoes, BASES_NUTRY, bruto.saidaBase, bruto.chegadaBase, visitas, pontos).chegadaBase)
      .toBe("2026-10-22T21:02:43.886Z");
  });
});

describe("F2-06: pernoite fora da cerca com GPS velho vira saida estimada (RQV9B26 22/10)", () => {
  // Pernoite a 704 m da base com o rastreador dormindo (atraso 294 -> 813),
  // 08:39-09:19 congelado com salto (F2-08) e a 1a leitura que vale e' 09:20.
  const posicoes = lerPosicoes("rqv9b26-2026-10-22-manha.csv");

  it("sem saida observada: saidaSemSinalAte = 09:20 BRT (12:20:15Z)", () => {
    const r = calcularJanelaBase(posicoes, BASES_NUTRY);
    expect(r.saidaBase).toBeNull();
    expect(r.saidaSemSinalAte).toBe("2026-10-22T12:20:15.032Z");
  });

  it("rastreador vivo no pernoite fora da cerca, ou carro que sai da base: sem estimativa", () => {
    const vivo = posicoes.map((p) => ({ ...p, atraso_min: 0 }));
    expect(calcularJanelaBase(vivo, BASES_NUTRY).saidaSemSinalAte).toBeNull();
    const naBase = [{ ...posicoes[0], lat: PENHA.lat, lng: PENHA.lng }, ...posicoes.slice(1)];
    expect(calcularJanelaBase(naBase, BASES_NUTRY).saidaSemSinalAte).toBeNull();
  });
});

describe("F2-06: varias bases -- chegada medida na base de origem do carro (22/10)", () => {
  it("Lagos (RBG4F53): sai de Sao Pedro da Aldeia 06:50 e volta 18:32 BRT", () => {
    const r = calcularJanelaBase(lerPosicoes("rbg4f53-2026-10-22-lagos-1a10.csv"), BASES_NUTRY, lerPontos("rbg4f53-2026-10-22-pontos.json"));
    expect(r).toEqual({ saidaBase: "2026-10-22T09:50:11.581Z", chegadaBase: "2026-10-22T21:32:12.848Z", saidaSemSinalAte: null });
  });

  it("Campos (RBI0J25): sai da base de Campos 06:50 e volta 18:12 BRT", () => {
    const r = calcularJanelaBase(lerPosicoes("rbi0j25-2026-10-22-campos-1a10.csv"), BASES_NUTRY, lerPontos("rbi0j25-2026-10-22-pontos.json"));
    expect(r).toEqual({ saidaBase: "2026-10-22T09:50:11.581Z", chegadaBase: "2026-10-22T21:12:06.145Z", saidaSemSinalAte: null });
  });
});
