import { describe, it, expect } from "vitest";
import { agruparPontosPorPlaca, type AlvoUnitrac } from "./unitrac";

describe("agruparPontosPorPlaca", () => {
  it("mapeia os campos completos e trata data 0001 como null", () => {
    const alvos: AlvoUnitrac[] = [
      {
        placa: "ABC1D23",
        alvosituacaoservico: 0,
        pontolatitude: -22.9,
        pontolongitude: -43.2,
        pontoraio: 100,
        pontonome: "SENDAS",
        alvoordem: 1,
        alvodocumento: "279225",
        pontoidentificador: "560036",
        alvodatainicio: "2026-06-26T00:21:13",
        alvodatarealizado: "0001-01-01T00:00:00",
        alvoobservacoes: null,
        alvorota: "ROTA",
      },
    ];
    const mapa = agruparPontosPorPlaca(alvos);
    const p = mapa.get("ABC1D23")![0];
    expect(p.documento).toBe("279225");
    expect(p.identificador).toBe("560036");
    expect(p.dataInicio).toBe("2026-06-26T00:21:13");
    expect(p.dataRealizado).toBeNull();
    expect(p.observacoes).toBeNull();
    expect(p.rota).toBe("ROTA");
    expect(p.feito).toBe(false);
  });

  it("marca feito quando alvosituacaoservico = 1 e preserva data realizada valida", () => {
    const alvos: AlvoUnitrac[] = [
      {
        placa: "XYZ9K88",
        alvosituacaoservico: 1,
        pontolatitude: -22.8,
        pontolongitude: -43.1,
        alvoordem: 2,
        alvodatarealizado: "2026-06-26T08:15:00",
      },
    ];
    const p = agruparPontosPorPlaca(alvos).get("XYZ9K88")![0];
    expect(p.feito).toBe(true);
    expect(p.dataRealizado).toBe("2026-06-26T08:15:00");
    expect(p.documento).toBeNull();
  });
});
