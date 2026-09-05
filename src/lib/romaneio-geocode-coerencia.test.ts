import { describe, it, expect } from "vitest";
import {
  resolverGrupoPorCoerencia,
  municipiosDaZona,
  type CandidatoCluster,
} from "./romaneio-geocode-coerencia";

// Coordenadas reais (aproximadas) usadas nos cenarios -- todas no RJ.
const RIO = "3304557";
const CAXIAS = "3301702";
const JAPERI = "3302270";
const NITEROI = "3303302";

const c = (municipioCodigo: string, lat: number, lng: number, qtd = 10, similaridade = 1): CandidatoCluster =>
  ({ municipioCodigo, lat, lng, qtd, similaridade });

// Leblon (Rio): ruas unicas + rua ambigua
const ATAULFO = c(RIO, -22.9840, -43.2220);       // AVENIDA ATAULFO DE PAIVA (unica)
const DIAS_FERREIRA = c(RIO, -22.9870, -43.2270); // RUA DIAS FERREIRA (unica)
const NOVE_LEBLON = c(RIO, -22.9855, -43.2240);   // "RUA NOVE" perto do Leblon (ficticia)
const NOVE_MARE = c(RIO, -22.8600, -43.2450);     // "RUA NOVE" na Mare (~14km)
const NOVE_CAXIAS = c(CAXIAS, -22.7900, -43.3050);
const NOVE_JAPERI = c(JAPERI, -22.6430, -43.6530);

describe("municipiosDaZona", () => {
  it("zonas da capital (CENTRO/SUL/NORTE/OESTE/SUDOESTE) apontam so' pro Rio de Janeiro", () => {
    for (const z of ["CAPITAL"]) expect(municipiosDaZona(z)).toEqual(new Set([RIO]));
  });
  it("BAIXADA inclui Duque de Caxias e Japeri mas nao o Rio", () => {
    const s = municipiosDaZona("BAIXADA")!;
    expect(s.has(CAXIAS)).toBe(true);
    expect(s.has(JAPERI)).toBe(true);
    expect(s.has(RIO)).toBe(false);
  });
  it("LESTE inclui Niteroi", () => {
    expect(municipiosDaZona("LESTE")!.has(NITEROI)).toBe(true);
  });
  it("zona desconhecida => null (sem prior, todos os candidatos valem)", () => {
    expect(municipiosDaZona("MARTE")).toBeNull();
    expect(municipiosDaZona(null)).toBeNull();
  });
});

describe("resolverGrupoPorCoerencia", () => {
  it("rua com 1 candidato vira ancora com confianca alta", () => {
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "ATAULFO PAIVA" }],
      new Map([["ATAULFO PAIVA", [ATAULFO]]]),
      null,
    );
    expect(r[0]).toMatchObject({ lat: ATAULFO.lat, lng: ATAULFO.lng, municipioCodigo: RIO, confianca: "alta", ancora: true, candidatos: 1 });
  });

  it("rua ambigua escolhe o candidato mais perto da ancora mais proxima (o caso real 'RUA NOVE': Leblon, nao Mare)", () => {
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "ATAULFO PAIVA" }, { nomeNormalizado: "NOVE" }, { nomeNormalizado: "DIAS FERREIRA" }],
      new Map([
        ["ATAULFO PAIVA", [ATAULFO]],
        ["NOVE", [NOVE_MARE, NOVE_LEBLON, NOVE_CAXIAS, NOVE_JAPERI]],
        ["DIAS FERREIRA", [DIAS_FERREIRA]],
      ]),
      null,
    );
    expect(r[1].lat).toBe(NOVE_LEBLON.lat);
    expect(r[1].confianca).toBe("alta");
    expect(r[1].candidatos).toBe(4);
  });

  it("a ordem das paradas NAO importa (achado real 05/09: ordem do xlsx nao e' ordem de rota)", () => {
    const cands = new Map([
      ["ATAULFO PAIVA", [ATAULFO]],
      ["NOVE", [NOVE_MARE, NOVE_LEBLON, NOVE_CAXIAS]],
    ]);
    const a = resolverGrupoPorCoerencia([{ nomeNormalizado: "NOVE" }, { nomeNormalizado: "ATAULFO PAIVA" }], cands, null);
    const b = resolverGrupoPorCoerencia([{ nomeNormalizado: "ATAULFO PAIVA" }, { nomeNormalizado: "NOVE" }], cands, null);
    expect(a[0].lat).toBe(NOVE_LEBLON.lat);
    expect(b[1].lat).toBe(NOVE_LEBLON.lat);
  });

  it("prior de zona: com zona BAIXADA, candidatos fora da zona sao descartados quando existe algum dentro", () => {
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "NOVE" }],
      new Map([["NOVE", [NOVE_MARE, NOVE_LEBLON, NOVE_CAXIAS]]]),
      municipiosDaZona("BAIXADA"),
    );
    expect(r[0].municipioCodigo).toBe(CAXIAS);
    expect(r[0].candidatos).toBe(1); // so' sobrou o de Caxias
  });

  it("prior de zona NAO e' filtro rigido: se nenhum candidato esta' na zona, mantem todos (rota pode cruzar a fronteira)", () => {
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "ATAULFO PAIVA" }],
      new Map([["ATAULFO PAIVA", [ATAULFO]]]),
      municipiosDaZona("BAIXADA"),
    );
    expect(r[0].municipioCodigo).toBe(RIO);
    expect(r[0].lat).toBe(ATAULFO.lat);
  });

  it("sem nenhuma ancora (todas ambiguas): escolhe pelo aglomerado mais denso e marca confianca <= media", () => {
    // duas ruas ambiguas, ambas com um candidato em Caxias e outro longe em lugares diferentes
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "A" }, { nomeNormalizado: "B" }],
      new Map([
        ["A", [NOVE_CAXIAS, NOVE_JAPERI]],
        ["B", [c(CAXIAS, -22.7910, -43.3060), NOVE_MARE]],
      ]),
      null,
    );
    expect(r[0].municipioCodigo).toBe(CAXIAS);
    expect(r[1].municipioCodigo).toBe(CAXIAS);
    for (const x of r) expect(["media", "baixa"]).toContain(x.confianca);
  });

  it("rua sem candidato => sem_candidato, lat/lng null, e nao quebra as outras", () => {
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "ATAULFO PAIVA" }, { nomeNormalizado: "INEXISTENTE" }],
      new Map([["ATAULFO PAIVA", [ATAULFO]]]),
      null,
    );
    expect(r[1]).toMatchObject({ lat: null, lng: null, confianca: "sem_candidato", candidatos: 0 });
    expect(r[0].confianca).toBe("alta");
  });

  it("candidato ambiguo escolhido longe de qualquer ancora (> 8km) fica 'baixa' -- honesto, nao inventa", () => {
    const longe = c(RIO, -22.90, -43.60); // Santa Cruz, ~40km do Leblon
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "ATAULFO PAIVA" }, { nomeNormalizado: "X" }],
      new Map([["ATAULFO PAIVA", [ATAULFO]], ["X", [longe, c(JAPERI, -22.64, -43.65)]]]),
      null,
    );
    expect(r[1].confianca).toBe("baixa");
  });

  // Achado real 05/09 (gabarito Rio Quality): "RUA 37" tem UM candidato no
  // CNEFE (Itatiaia) mas a rua real do romaneio nao esta' no CNEFE -- o
  // candidato unico virou ancora com confianca "alta" a 25km de todas as
  // outras ancoras do caminhao. Rua unica no estado nao e' garantia: se ela
  // fica longe de TODAS as outras ancoras (que concordam entre si), e' ela
  // que esta' errada -- rebaixa pra "baixa" e nao deixa puxar as ambiguas.
  it("ancora isolada (>15km de todas as outras ancoras, que concordam entre si) e' rebaixada e nao atrai as ambiguas", () => {
    const longe = c(RIO, -22.90, -43.60); // "RUA 37": unica, mas a 40km do Leblon
    const perto = c(RIO, -22.9850, -43.2235);
    const r = resolverGrupoPorCoerencia(
      [
        { nomeNormalizado: "ATAULFO PAIVA" },
        { nomeNormalizado: "DIAS FERREIRA" },
        { nomeNormalizado: "RUA 37" },
        { nomeNormalizado: "NOVE" },
      ],
      new Map([
        ["ATAULFO PAIVA", [ATAULFO]],
        ["DIAS FERREIRA", [DIAS_FERREIRA]],
        ["RUA 37", [longe]],
        ["NOVE", [c(RIO, -22.905, -43.605), perto]], // um candidato colado na ancora falsa, outro no Leblon
      ]),
      null,
    );
    expect(r[2].confianca).toBe("baixa");
    expect(r[2].ancora).toBe(false);
    expect(r[3].lat).toBe(perto.lat); // NOVE foi pro Leblon, nao pra perto da "RUA 37"
  });

  it("com so' 2 ancoras discordantes nao da' pra saber quem esta' errada: as duas ficam, ninguem e' rebaixada", () => {
    const longe = c(RIO, -22.90, -43.60);
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "ATAULFO PAIVA" }, { nomeNormalizado: "RUA 37" }],
      new Map([["ATAULFO PAIVA", [ATAULFO]], ["RUA 37", [longe]]]),
      null,
    );
    expect(r[0].ancora).toBe(true);
    expect(r[1].ancora).toBe(true);
  });

  it("candidato vindo de similaridade (nao exato) nunca vira ancora sozinho e rebaixa a confianca um nivel", () => {
    const sim = c(RIO, -22.9850, -43.2230, 10, 0.72);
    const r = resolverGrupoPorCoerencia(
      [{ nomeNormalizado: "ATAULFO PAIVA" }, { nomeNormalizado: "ATAULFO PAIVA X" }],
      new Map([["ATAULFO PAIVA", [ATAULFO]], ["ATAULFO PAIVA X", [sim]]]),
      null,
    );
    expect(r[1].ancora).toBe(false);
    expect(r[1].confianca).toBe("media");
  });
});
