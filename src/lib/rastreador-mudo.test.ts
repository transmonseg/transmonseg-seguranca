import { describe, it, expect } from "vitest";
import {
  TIPO_RASTREADOR_MUDO,
  LIMIAR_RASTREADOR_MUDO_MIN,
  HORA_MIN_RASTREADOR_MUDO_SP,
  SQL_CARGA_DO_DIA_COM_POSICAO,
  rastreadorMudo,
  ultimaComunicacaoEstimada,
  motivoRastreadorMudo,
  planejarRastreadorMudo,
  semAlertasInternos,
  type CargaComPosicao,
} from "./rastreador-mudo";

// F3-09 (ACH-09, MON-08 / DR-14). Casos reais de posicoes_atuais e
// posicoes_historico (lidos em 24/10, so' leitura):
//  - LTZ-7I72 (RQ): mudo desde 03/10, Central regrava a linha a cada ciclo
//    (updated_at fresco) com atraso_min 28.050 em 22/10 e 29.952 em 24/10.
//  - RJM-5B51 (RQ): mudo desde 20/08, atraso_min 91.445 em 22/10.
//  - EEG-2F60 (RQ): nunca transmitiu -- nenhuma linha em posicoes_atuais, 35
//    NFs no romaneio de 23/10.
//  - OXE-7D03 (RQ, 23/10): carro dormiu desde a tarde anterior, atraso 1.039
//    as 06:21 com o romaneio ja carregado -- NAO e' rastreador mudo.
//  - KWQ-6252 (RQ, 22/10): atraso 717 as 07:03 -- idem.
//  - RQU-1B50 (Nutry, 20/10): atraso 2.688 de madrugada (parado desde
//    sabado), sai antes das 10h -- NAO e' rastreador mudo.
//  - LNH-8A80 (RQ): GPS fresco (atraso 0) -- nunca entra.

const AGORA_23_10_11H = new Date("2026-10-23T14:00:00Z"); // 11:00 BRT
const HOJE = "2026-10-23";

function carga(over: Partial<CargaComPosicao> = {}): CargaComPosicao {
  return {
    veiculo_id: "v-ltz",
    cliente_id: "cli-rq",
    placa: "LTZ-7I72",
    nfs: 41,
    tem_posicao: true,
    lat: -22.9,
    lng: -43.2,
    atraso_min: 28050,
    updated_at: "2026-10-23T13:59:40Z",
    ...over,
  };
}

describe("rastreadorMudo (casos reais 20-23/10)", () => {
  it("LTZ-7I72: atraso 28.050 com linha regravada agora => mudo", () => {
    expect(rastreadorMudo(carga(), AGORA_23_10_11H)).toBe(true);
  });

  it("RJM-5B51: atraso 91.445 => mudo", () => {
    expect(rastreadorMudo(carga({ placa: "RJM-5B51", atraso_min: 91445 }), AGORA_23_10_11H)).toBe(true);
  });

  it("EEG-2F60: nunca transmitiu (sem linha em posicoes_atuais) => mudo", () => {
    const eeg = carga({ placa: "EEG-2F60", nfs: 35, tem_posicao: false, lat: null, lng: null, atraso_min: null, updated_at: null });
    expect(rastreadorMudo(eeg, AGORA_23_10_11H)).toBe(true);
  });

  it("OXE-7D03: dormiu desde a tarde anterior (atraso 1.039) => NAO e' mudo", () => {
    expect(rastreadorMudo(carga({ placa: "OXE-7D03", atraso_min: 1039 }), AGORA_23_10_11H)).toBe(false);
  });

  it("KWQ-6252: atraso 717 => NAO e' mudo", () => {
    expect(rastreadorMudo(carga({ placa: "KWQ-6252", atraso_min: 717 }), AGORA_23_10_11H)).toBe(false);
  });

  it("LNH-8A80: GPS fresco => NAO e' mudo", () => {
    expect(rastreadorMudo(carga({ placa: "LNH-8A80", atraso_min: 0 }), AGORA_23_10_11H)).toBe(false);
  });

  it("linha congelada (Central parou de gravar ha 2 dias) conta a idade do updated_at", () => {
    const congelada = carga({ atraso_min: 3, updated_at: "2026-10-21T14:00:00Z" });
    expect(rastreadorMudo(congelada, AGORA_23_10_11H)).toBe(true);
  });

  it("atraso_min nulo com linha existente: sem dado, nao afirma mudo", () => {
    expect(rastreadorMudo(carga({ atraso_min: null }), AGORA_23_10_11H)).toBe(false);
  });

  it("limiar e' 24 h", () => {
    expect(LIMIAR_RASTREADOR_MUDO_MIN).toBe(24 * 60);
    expect(rastreadorMudo(carga({ atraso_min: 1440 }), AGORA_23_10_11H)).toBe(true);
    expect(rastreadorMudo(carga({ atraso_min: 1439 }), AGORA_23_10_11H)).toBe(false);
  });
});

describe("ultimaComunicacaoEstimada / motivo", () => {
  it("LTZ-7I72 em 24/10 (atraso 29.952 gravado 10:42 UTC) => 03/10", () => {
    const d = ultimaComunicacaoEstimada(29952, "2026-10-24T10:42:02Z")!;
    expect(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }).format(d)).toBe("03/10");
  });

  it("sem posicao => null", () => {
    expect(ultimaComunicacaoEstimada(null, null)).toBeNull();
  });

  it("motivo cita NFs e desde quando; nunca transmitiu tem texto proprio", () => {
    const m = motivoRastreadorMudo(carga({ atraso_min: 29952, updated_at: "2026-10-24T10:42:02Z" }));
    expect(m).toContain("41 NFs");
    expect(m).toContain("03/10");
    const eeg = motivoRastreadorMudo(carga({ placa: "EEG-2F60", nfs: 35, tem_posicao: false, atraso_min: null, updated_at: null }));
    expect(eeg).toContain("35 NFs");
    expect(eeg).toMatch(/nunca transmitiu/i);
  });
});

describe("SQL_CARGA_DO_DIA_COM_POSICAO", () => {
  it("so' veiculo ATIVO de cliente ATIVO (TTF-5I09/TTI-9B98 inativos tinham romaneio em 20/10)", () => {
    expect(SQL_CARGA_DO_DIA_COM_POSICAO).toMatch(/v\.ativo/);
    expect(SQL_CARGA_DO_DIA_COM_POSICAO).toMatch(/c\.ativo/);
  });
  it("romaneio do dia, fora do modo teste, posicao por LEFT JOIN (EEG-2F60 nao tem linha)", () => {
    expect(SQL_CARGA_DO_DIA_COM_POSICAO).toContain("romaneio_data = $1::date");
    expect(SQL_CARGA_DO_DIA_COM_POSICAO).toContain("modo_teste = false");
    expect(SQL_CARGA_DO_DIA_COM_POSICAO).toMatch(/LEFT JOIN posicoes_atuais/);
  });
});

describe("planejarRastreadorMudo (1 por veiculo por dia)", () => {
  const ltz = carga();
  const rjm = carga({ veiculo_id: "v-rjm", placa: "RJM-5B51", atraso_min: 91445, nfs: 32 });
  const eeg = carga({ veiculo_id: "v-eeg", placa: "EEG-2F60", nfs: 35, tem_posicao: false, lat: null, lng: null, atraso_min: null, updated_at: null });
  const oxe = carga({ veiculo_id: "v-oxe", placa: "OXE-7D03", atraso_min: 1039 });
  const lnh = carga({ veiculo_id: "v-lnh", placa: "LNH-8A80", atraso_min: 0 });

  it("23/10 11h: alerta so' para LTZ-7I72 e EEG-2F60 (RJM sem romaneio no dia), nenhum carro com GPS fresco", () => {
    const plano = planejarRastreadorMudo({ cargas: [ltz, eeg, oxe, lnh], existentes: [], hoje: HOJE, agora: AGORA_23_10_11H });
    expect(plano.inserir.map((c) => c.placa).sort()).toEqual(["EEG-2F60", "LTZ-7I72"]);
    expect(plano.resolver).toEqual([]);
  });

  it("antes das 10h BRT nao cria (carro que dormiu ainda pode ligar)", () => {
    expect(HORA_MIN_RASTREADOR_MUDO_SP).toBe(10);
    const as0915 = new Date("2026-10-23T12:15:00Z");
    const plano = planejarRastreadorMudo({ cargas: [ltz, rjm], existentes: [], hoje: HOJE, agora: as0915 });
    expect(plano.inserir).toEqual([]);
  });

  it("ja tem alerta HOJE (qualquer status, inclusive resolvido pelo operador) => nao cria outro", () => {
    const existentes = [{ id: "a1", veiculo_id: "v-ltz", status: "resolvido", desde: "2026-10-23T13:10:00Z" }];
    const plano = planejarRastreadorMudo({ cargas: [ltz], existentes, hoje: HOJE, agora: AGORA_23_10_11H });
    expect(plano.inserir).toEqual([]);
  });

  it("alerta de ONTEM nao conta: cria o de hoje e fecha o de ontem", () => {
    const existentes = [{ id: "ontem", veiculo_id: "v-ltz", status: "ativo", desde: "2026-10-22T13:00:00Z" }];
    const plano = planejarRastreadorMudo({ cargas: [ltz], existentes, hoje: HOJE, agora: AGORA_23_10_11H });
    expect(plano.inserir.map((c) => c.placa)).toEqual(["LTZ-7I72"]);
    expect(plano.resolver).toEqual(["ontem"]);
  });

  it("rastreador voltou a comunicar (ou a carga saiu do romaneio) => fecha sozinho o alerta ativo de hoje", () => {
    const existentes = [{ id: "a1", veiculo_id: "v-ltz", status: "ativo", desde: "2026-10-23T13:10:00Z" }];
    const voltou = carga({ atraso_min: 2 });
    const plano = planejarRastreadorMudo({ cargas: [voltou], existentes, hoje: HOJE, agora: AGORA_23_10_11H });
    expect(plano.resolver).toEqual(["a1"]);
    expect(plano.inserir).toEqual([]);
  });

  it("alerta ativo de hoje de carro que continua mudo nao e' fechado", () => {
    const existentes = [{ id: "a1", veiculo_id: "v-ltz", status: "ativo", desde: "2026-10-23T13:10:00Z" }];
    const plano = planejarRastreadorMudo({ cargas: [ltz], existentes, hoje: HOJE, agora: AGORA_23_10_11H });
    expect(plano.resolver).toEqual([]);
  });

  it("linha sem nfs (dado incompleto) nao cria, mas e' contada como invalida (R-F3-09-04: nada calado)", () => {
    const quebrada = { ...ltz, nfs: undefined } as unknown as CargaComPosicao;
    const plano = planejarRastreadorMudo({ cargas: [quebrada], existentes: [], hoje: HOJE, agora: AGORA_23_10_11H });
    expect(plano.inserir).toEqual([]);
    expect(plano.linhasInvalidas).toEqual(["LTZ-7I72"]);
  });

  it("R-F3-09-04: nfs como string (count sem ::int vira bigint -> '41' no node-pg) ainda cria, com nfs numerico", () => {
    const comoString = { ...ltz, nfs: "41" } as unknown as CargaComPosicao;
    const plano = planejarRastreadorMudo({ cargas: [comoString], existentes: [], hoje: HOJE, agora: AGORA_23_10_11H });
    expect(plano.inserir.map((c) => [c.placa, c.nfs])).toEqual([["LTZ-7I72", 41]]);
    expect(plano.linhasInvalidas).toEqual([]);
  });

  it("R-F3-09-04: linha invalida nao fecha o alerta de hoje daquele carro (sem dado, nao afirma que voltou)", () => {
    const existentes = [{ id: "a1", veiculo_id: "v-ltz", status: "ativo", desde: "2026-10-23T13:10:00Z" }];
    const quebrada = { ...ltz, nfs: "x" } as unknown as CargaComPosicao;
    const plano = planejarRastreadorMudo({ cargas: [quebrada], existentes, hoje: HOJE, agora: AGORA_23_10_11H });
    expect(plano.resolver).toEqual([]);
  });
});

describe("R-F3-09-03: posicoes do cliente paradas nao viram 'rastreador mudo'", () => {
  // Busca da RQ na Unitrac falhando das 09h de 22/10 ate as 10h de 23/10: a
  // Central para de regravar posicoes_atuais da RQ (em 24/10 as 118 linhas
  // da RQ tinham updated_at de 0,5 min -- a Central regrava toda linha a
  // cada ciclo, inclusive a de rastreador mudo como LTZ-7I72).
  const AS_10H_23_10 = new Date("2026-10-23T13:00:00Z");
  const congelada = "2026-10-22T12:00:00Z";
  const rqParada = [
    carga({ veiculo_id: "v-kwq", placa: "KWQ-6252", atraso_min: 0, updated_at: congelada }),
    carga({ veiculo_id: "v-oxe", placa: "OXE-7D03", atraso_min: 3, updated_at: congelada }),
    carga({ veiculo_id: "v-ltz", placa: "LTZ-7I72", atraso_min: 28050, updated_at: congelada }),
    carga({ veiculo_id: "v-eeg", placa: "EEG-2F60", nfs: 35, tem_posicao: false, lat: null, lng: null, atraso_min: null, updated_at: null }),
  ];
  const nutryViva = [
    carga({ veiculo_id: "v-rqu", cliente_id: "cli-nutry", placa: "RQU-1B50", atraso_min: 0, updated_at: "2026-10-23T12:59:30Z" }),
    carga({ veiculo_id: "v-lld", cliente_id: "cli-nutry", placa: "LLD-4202", atraso_min: 29000, updated_at: "2026-10-23T12:59:30Z" }),
  ];

  it("nenhum carro da RQ com linha atualizada na ultima hora => nao cria para a RQ e aponta o cliente", () => {
    const plano = planejarRastreadorMudo({ cargas: [...rqParada, ...nutryViva], existentes: [], hoje: HOJE, agora: AS_10H_23_10 });
    expect(plano.inserir.map((c) => c.placa)).toEqual(["LLD-4202"]);
    expect(plano.clientesParados).toEqual(["cli-rq"]);
  });

  it("com a Central regravando (updated_at fresco), LTZ-7I72 e EEG-2F60 continuam saindo", () => {
    const viva = rqParada.map((c) => (c.tem_posicao ? { ...c, updated_at: "2026-10-23T12:59:30Z" } : c));
    const plano = planejarRastreadorMudo({ cargas: viva, existentes: [], hoje: HOJE, agora: AS_10H_23_10 });
    expect(plano.inserir.map((c) => c.placa).sort()).toEqual(["EEG-2F60", "LTZ-7I72"]);
    expect(plano.clientesParados).toEqual([]);
  });

  it("cliente parado nao fecha alerta de hoje (carro continua sem dado novo)", () => {
    const existentes = [{ id: "a1", veiculo_id: "v-ltz", status: "ativo", desde: "2026-10-23T13:10:00Z" }];
    const plano = planejarRastreadorMudo({ cargas: rqParada, existentes, hoje: HOJE, agora: new Date("2026-10-23T14:00:00Z") });
    expect(plano.resolver).toEqual([]);
  });
});

describe("semAlertasInternos (alerta e' interno: conta do cliente nao ve)", () => {
  const lista = [{ tipo: "desvio" }, { tipo: TIPO_RASTREADOR_MUDO }];
  it("central (todos) ve tudo", () => {
    expect(semAlertasInternos(lista, { tipo: "todos" })).toEqual(lista);
  });
  it("login de um cliente (ex.: RQ) nao ve rastreador_mudo_com_carga", () => {
    expect(semAlertasInternos(lista, { tipo: "um", clienteId: "cli-rq" })).toEqual([{ tipo: "desvio" }]);
  });
});
