import { describe, it, expect } from "vitest";
import {
  TIPO_ROMANEIO_AUSENTE,
  DIST_MIN_BASE_ROMANEIO_AUSENTE_M,
  SQL_FROTA_EM_ROTA,
  SQL_ULTIMO_ENVIO_ROMANEIO,
  textoUltimoEnvio,
  motivoRomaneioAusente,
  planejarRomaneioAusente,
  type VeiculoEmRota,
  type AlertaRomaneioAusente,
} from "./romaneio-ausente";
import { CLIENTES_COM_ROMANEIO_AUSENTE } from "./config-clientes";
import { sqlAtrasoEfetivo } from "./frescor-posicao";

// F3-07 (MON-04). Replay so' leitura de 20-22/10 (scripts/replay-romaneio-
// ausente-agregado.sql): a regra antiga deu 212, 138 e 127 cards da Nutry e 0
// da RQ; a nova da' 1 card por cliente por dia com 90/96/94 carros da Nutry e
// 20/105/12 da RQ (21/10: Fusion fora o dia inteiro). Romaneio da Nutry
// chegou 20/10 11:10, 21/10 10:30, 22/10 09:25 BRT.

const NUTRY = "cfcb52f5-fd01-47c7-988c-d13a10f0d8fd";
const RQ = "16a32814-3402-4b2d-b974-aef0707d7a4e";
const HOJE = "2026-10-21";
const AS_07H = new Date("2026-10-21T10:00:00Z"); // 07:00 BRT
const ULTIMO_ENVIO_NUTRY = "2026-10-20T14:10:00Z"; // romaneio de 20/10, 11:10 BRT

function carro(placa: string, cliente_id = NUTRY): VeiculoEmRota {
  return { veiculo_id: `v-${placa}`, cliente_id, placa, lat: -22.85, lng: -43.3 };
}

function card(over: Partial<AlertaRomaneioAusente> = {}): AlertaRomaneioAusente {
  return {
    id: "a1",
    cliente_id: NUTRY,
    veiculo_id: "v-RQU-1B50",
    status: "ativo",
    desde: "2026-10-21T08:40:00Z",
    motivo: "",
    contexto: { agregado: true, dia: HOJE, placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"] },
    origem_acao: null,
    ...over,
  };
}

const base = { hoje: HOJE, agora: AS_07H, ultimoEnvio: { [NUTRY]: ULTIMO_ENVIO_NUTRY, [RQ]: "2026-10-20T22:11:00Z" } };

describe("escopo e SQL", () => {
  it("vale para Nutry (4096) e Rio Quality (598)", () => {
    expect([...CLIENTES_COM_ROMANEIO_AUSENTE].sort()).toEqual(["4096", "598"]);
  });

  it("exige GPS fresco pelo atraso efetivo, ignicao (ou movimento) e mais de 5 km de toda base, so' cliente ativo", () => {
    expect(DIST_MIN_BASE_ROMANEIO_AUSENTE_M).toBe(5000);
    expect(SQL_FROTA_EM_ROTA).toContain(`${sqlAtrasoEfetivo("pa")} < $2`);
    expect(SQL_FROTA_EM_ROTA).toContain("c.ativo");
    expect(SQL_FROTA_EM_ROTA).toMatch(/pa\.ignicao IS TRUE OR COALESCE\(pa\.velocidade, 0\) >= 10/);
    expect(SQL_FROTA_EM_ROTA).toMatch(/NOT EXISTS[\s\S]*ST_DWithin\(b\.geom, pa\.geom, \$4\)/);
    // romaneio de teste nao conta como romaneio do dia
    expect(SQL_FROTA_EM_ROTA).toMatch(/rp\.romaneio_data = \$3::date[\s\S]*rp\.modo_teste = false/);
    expect(SQL_ULTIMO_ENVIO_ROMANEIO).toContain("max(rp.criado_em)");
  });
});

describe("textoUltimoEnvio", () => {
  it("21/10 07:00 com o romaneio da Nutry de 20/10 11:10 => ha' 19 h", () => {
    expect(textoUltimoEnvio(ULTIMO_ENVIO_NUTRY, AS_07H)).toBe("último envio há 19 h");
  });
  it("menos de 1 h => minutos", () => {
    expect(textoUltimoEnvio("2026-10-21T09:35:00Z", AS_07H)).toBe("último envio há 25 min");
  });
  it("sem envio na semana", () => {
    expect(textoUltimoEnvio(null, AS_07H)).toBe("nenhum envio nos últimos 7 dias");
  });
  it("revisao F3-07 (R7): o fechamento das 00:30 reenvia o dia anterior da RQ -- as 07:00 sem relatorio de hoje o card diz de que DIA e' o ultimo romaneio, nao 'ultimo envio ha' 6 h'", () => {
    const AS_07H_24 = new Date("2026-10-24T10:00:00Z");
    expect(textoUltimoEnvio("2026-10-24T03:30:00Z", AS_07H_24, "2026-10-23", "2026-10-24")).toBe("último romaneio é de 23/10 (enviado há 6 h)");
    expect(textoUltimoEnvio("2026-10-24T08:05:00Z", AS_07H_24, "2026-10-24", "2026-10-24")).toBe("romaneio de hoje enviado há 1 h, sem estes carros");
  });
  it("R7: SQL devolve o dia do ultimo romaneio e o envio desse dia", () => {
    expect(SQL_ULTIMO_ENVIO_ROMANEIO).toMatch(/DISTINCT ON \(v\.cliente_id\)/);
    expect(SQL_ULTIMO_ENVIO_ROMANEIO).toContain("rp.romaneio_data::text AS ultimo_dia");
    expect(SQL_ULTIMO_ENVIO_ROMANEIO).toMatch(/ORDER BY v\.cliente_id, rp\.romaneio_data DESC/);
  });
});

describe("motivoRomaneioAusente", () => {
  it("N carros, ultimo envio e as placas", () => {
    expect(motivoRomaneioAusente({ placas: ["RQU-1B50", "OXE-7D03"], emRotaAgora: 2, ultimoEnvio: ULTIMO_ENVIO_NUTRY, agora: AS_07H }))
      .toBe("2 carros em rota sem romaneio, último envio há 19 h. Placas: OXE-7D03, RQU-1B50");
  });
  it("1 carro no singular; quantos ainda agora quando menos que o total do dia", () => {
    expect(motivoRomaneioAusente({ placas: ["RQU-1B50"], emRotaAgora: 1, ultimoEnvio: ULTIMO_ENVIO_NUTRY, agora: AS_07H }))
      .toBe("1 carro em rota sem romaneio, último envio há 19 h. Placas: RQU-1B50");
    expect(motivoRomaneioAusente({ placas: ["A", "B", "C"], emRotaAgora: 1, ultimoEnvio: null, agora: AS_07H }))
      .toBe("3 carros em rota sem romaneio (1 agora), nenhum envio nos últimos 7 dias. Placas: A, B, C");
  });
});

describe("planejarRomaneioAusente", () => {
  it("21/10 07:00, Nutry sem romaneio com 3 carros e RQ (Fusion fora) com 2: 1 card por cliente, nao 1 por carro", () => {
    const emRota = [carro("RQU-1B50"), carro("OXE-7D03"), carro("TTI-6E43"), carro("KWM-9877", RQ), carro("LLR-9640", RQ)];
    const p = planejarRomaneioAusente({ ...base, emRota, existentes: [] });
    expect(p.inserir).toHaveLength(2);
    const nutry = p.inserir.find((i) => i.cliente_id === NUTRY)!;
    expect(nutry.tipo).toBe(TIPO_ROMANEIO_AUSENTE);
    expect(nutry.nivel).toBe("atencao");
    expect(nutry.motivo).toBe("3 carros em rota sem romaneio, último envio há 19 h. Placas: OXE-7D03, RQU-1B50, TTI-6E43");
    expect(nutry.contexto).toMatchObject({ agregado: true, dia: HOJE, placas: ["OXE-7D03", "RQU-1B50", "TTI-6E43"], em_rota_agora: 3, ultimo_envio: ULTIMO_ENVIO_NUTRY });
    expect(nutry.veiculo_id).toBe("v-OXE-7D03");
    expect(p.inserir.find((i) => i.cliente_id === RQ)!.contexto.placas).toEqual(["KWM-9877", "LLR-9640"]);
    expect(p.atualizar).toEqual([]);
    expect(p.resolver).toEqual([]);
  });

  it("recall: carro que entrou depois soma na contagem; quem saiu (romaneio chegou) continua contado no dia", () => {
    const existente = card({ contexto: { agregado: true, dia: HOJE, placas: ["OXE-7D03", "RQU-1B50"], veiculo_ids: ["v-OXE-7D03", "v-RQU-1B50"] } });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50"), carro("TTI-6E43")], existentes: [existente] });
    expect(p.inserir).toEqual([]);
    expect(p.atualizar).toHaveLength(1);
    expect(p.atualizar[0].id).toBe("a1");
    expect(p.atualizar[0].patch.contexto.placas).toEqual(["OXE-7D03", "RQU-1B50", "TTI-6E43"]);
    expect(p.atualizar[0].patch.motivo).toBe("3 carros em rota sem romaneio (2 agora), último envio há 19 h. Placas: OXE-7D03, RQU-1B50, TTI-6E43");
  });

  it("nada mudou (mesmos carros, so' a contagem 'agora' oscila) => nao regrava a cada ciclo; renova a cada 10 min", () => {
    const placas = ["OXE-7D03", "RQU-1B50"];
    const ctx = (visto_em: string) => ({ agregado: true, dia: HOJE, placas, veiculo_ids: ["v-OXE-7D03", "v-RQU-1B50"], em_rota_agora: 2, ultimo_envio: ULTIMO_ENVIO_NUTRY, visto_em });
    const recente = card({ motivo: "x", contexto: ctx("2026-10-21T09:55:00Z") });
    expect(planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [recente] })).toEqual({ inserir: [], atualizar: [], resolver: [] });
    const velho = card({ motivo: "x", contexto: ctx("2026-10-21T09:49:00Z") });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [velho] });
    expect(p.atualizar).toHaveLength(1);
    expect(p.atualizar[0].patch.motivo).toBe("2 carros em rota sem romaneio (1 agora), último envio há 19 h. Placas: OXE-7D03, RQU-1B50");
    expect(p.atualizar[0].patch.contexto.visto_em).toBe(AS_07H.toISOString());
  });

  it("romaneio chegou e nenhum carro em rota sem ele ha' 30 min: o card fecha sozinho e guarda as placas", () => {
    const p = planejarRomaneioAusente({ ...base, emRota: [], existentes: [card({ contexto: { agregado: true, dia: HOJE, placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"], visto_em: "2026-10-21T09:25:00Z" } })] });
    expect(p.resolver).toEqual([{ id: "a1", contexto: expect.objectContaining({ agregado: true, placas: ["RQU-1B50"], auto_resolvido: true, em_rota_agora: 0 }) }]);
  });

  it("carencia: carro voltou para perto da base ha' 10 min => o card ainda nao fecha (nao pisca)", () => {
    const p = planejarRomaneioAusente({ ...base, emRota: [], existentes: [card({ contexto: { agregado: true, dia: HOJE, placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"], visto_em: "2026-10-21T09:50:00Z" } })] });
    expect(p).toEqual({ inserir: [], atualizar: [], resolver: [] });
  });

  it("fechou sozinho e outro carro saiu sem romaneio no mesmo dia: REABRE o mesmo card (1 por cliente por dia)", () => {
    const fechado = card({ status: "resolvido", contexto: { agregado: true, dia: HOJE, placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"], auto_resolvido: true } });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("TTI-6E43")], existentes: [fechado] });
    expect(p.inserir).toEqual([]);
    expect(p.atualizar).toHaveLength(1);
    expect(p.atualizar[0].patch).toMatchObject({ status: "ativo", resolvido_em: null, veiculo_id: "v-TTI-6E43" });
    expect(p.atualizar[0].patch.contexto.placas).toEqual(["RQU-1B50", "TTI-6E43"]);
    expect(p.atualizar[0].patch.contexto.auto_resolvido).toBeUndefined();
  });

  it("R7: o dia do ultimo romaneio vai pro motivo e pro contexto", () => {
    const p = planejarRomaneioAusente({ ...base, ultimoDia: { [NUTRY]: "2026-10-20" }, emRota: [carro("RQU-1B50")], existentes: [] });
    expect(p.inserir[0].motivo).toBe("1 carro em rota sem romaneio, último romaneio é de 20/10 (enviado há 19 h). Placas: RQU-1B50");
    expect(p.inserir[0].contexto.ultimo_dia).toBe("2026-10-20");
  });

  it("revisao F3-07 (R1): card de hoje que perdeu o contexto (contexto {}) e foi fechado pelo operador -- sem saber quem foi contado, carro rodando abre card novo (recall)", () => {
    const semContexto = card({ status: "limpo", origem_acao: "limpar_massa", contexto: {} });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [semContexto] });
    expect(p.inserir).toHaveLength(1);
    expect(p.resolver).toEqual([]);
  });

  it("operador fechou o card ha' menos de 60 min: nao reabre; carro NOVO sem romaneio abre o 2o card do dia (nunca some)", () => {
    const tratado = card({ status: "resolvido", origem_acao: "resolver_individual", resolvido_em: "2026-10-21T09:20:00Z", contexto: { agregado: true, dia: HOJE, placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"] } });
    const mesmo = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [tratado] });
    expect(mesmo).toEqual({ inserir: [], atualizar: [], resolver: [] });
    const novo = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50"), carro("TTI-6E43")], existentes: [tratado] });
    expect(novo.inserir).toHaveLength(1);
    expect(novo.inserir[0].contexto.placas).toEqual(["RQU-1B50", "TTI-6E43"]);
  });

  it("R1 F3-07 (dono): fechado pelo operador ha' 60 min e carro ja' contado segue em rota sem romaneio => REABRE o mesmo card, sem origem_acao", () => {
    const tratado = card({ status: "falso_positivo", origem_acao: "falso_individual", resolvido_em: "2026-10-21T09:00:00Z", contexto: { agregado: true, dia: HOJE, placas: ["OXE-7D03", "RQU-1B50"], veiculo_ids: ["v-OXE-7D03", "v-RQU-1B50"] } });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [tratado] });
    expect(p.inserir).toEqual([]);
    expect(p.atualizar).toHaveLength(1);
    expect(p.atualizar[0].patch).toMatchObject({ status: "ativo", resolvido_em: null, origem_acao: null });
    expect(p.atualizar[0].patch.motivo).toBe("2 carros em rota sem romaneio (1 agora), último envio há 19 h. Placas: OXE-7D03, RQU-1B50");
    expect(p.atualizar[0].patch.contexto).toMatchObject({ reaberto_apos_operador: 1, ultimo_fechamento_operador: { origem_acao: "falso_individual", status: "falso_positivo", em: "2026-10-21T09:00:00Z" } });
    // 59 min: ainda nao
    const cedo = card({ ...tratado, resolvido_em: "2026-10-21T09:01:00Z" });
    expect(planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [cedo] })).toEqual({ inserir: [], atualizar: [], resolver: [] });
  });

  it("R1 F3-07: fechado pelo operador sem resolvido_em (hora do fechamento desconhecida) e carro contado rodando => reabre (recall)", () => {
    const tratado = card({ status: "limpo", origem_acao: "limpar_massa", contexto: { agregado: true, dia: HOJE, placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"] } });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [tratado] });
    expect(p.atualizar[0]?.patch).toMatchObject({ status: "ativo", origem_acao: null });
  });

  it("R1 F3-07: no maximo 2 cards por cliente por dia -- com 2 cards fechados pelo operador, carro NOVO reabre o mais recente em vez de abrir o 3o", () => {
    const c1 = card({ id: "c1", status: "limpo", origem_acao: "limpar_massa", desde: "2026-10-21T08:40:00Z", resolvido_em: "2026-10-21T09:10:00Z", contexto: { agregado: true, dia: HOJE, placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"] } });
    const c2 = card({ id: "c2", status: "resolvido", origem_acao: "resolver_individual", desde: "2026-10-21T09:20:00Z", resolvido_em: "2026-10-21T09:50:00Z", contexto: { agregado: true, dia: HOJE, placas: ["OXE-7D03"], veiculo_ids: ["v-OXE-7D03"] } });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("TTI-6E43")], existentes: [c1, c2] });
    expect(p.inserir).toEqual([]);
    expect(p.atualizar).toHaveLength(1);
    expect(p.atualizar[0].id).toBe("c2");
    expect(p.atualizar[0].patch).toMatchObject({ status: "ativo", origem_acao: null });
    expect(p.atualizar[0].patch.contexto.placas).toEqual(["OXE-7D03", "TTI-6E43"]);
  });

  it("R1 F3-07: carro contado no 1o card (fechado) rodando 60 min depois do fechamento do 2o => reabre o 2o (o mais recente)", () => {
    const c1 = card({ id: "c1", status: "limpo", origem_acao: "limpar_massa", desde: "2026-10-21T08:40:00Z", resolvido_em: "2026-10-21T08:50:00Z", contexto: { agregado: true, dia: HOJE, placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"] } });
    const c2 = card({ id: "c2", status: "resolvido", origem_acao: "resolver_individual", desde: "2026-10-21T08:55:00Z", resolvido_em: "2026-10-21T08:58:00Z", contexto: { agregado: true, dia: HOJE, placas: ["OXE-7D03"], veiculo_ids: ["v-OXE-7D03"] } });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [c1, c2] });
    expect(p.inserir).toEqual([]);
    expect(p.atualizar.map((u) => u.id)).toEqual(["c2"]);
    expect(p.atualizar[0].patch.contexto.placas).toEqual(["OXE-7D03", "RQU-1B50"]);
  });

  it("card reconhecido segue reconhecido ao atualizar a contagem", () => {
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50"), carro("TTI-6E43")], existentes: [card({ status: "reconhecido" })] });
    expect(p.atualizar[0].patch.status).toBeUndefined();
  });

  it("virada do dia: card aberto de ontem fecha e hoje abre outro", () => {
    const ontem = card({ id: "ontem", desde: "2026-10-20T20:00:00Z", contexto: { agregado: true, dia: "2026-10-20", placas: ["RQU-1B50"], veiculo_ids: ["v-RQU-1B50"] } });
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50")], existentes: [ontem] });
    expect(p.resolver.map((r) => r.id)).toEqual(["ontem"]);
    expect(p.inserir).toHaveLength(1);
  });

  it("deploy: cards antigos (1 por carro, sem 'agregado') abertos fecham e viram o card do cliente", () => {
    const antigos = [
      card({ id: "x1", veiculo_id: "v-RQU-1B50", contexto: {} }),
      card({ id: "x2", veiculo_id: "v-OXE-7D03", contexto: {} }),
    ];
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50"), carro("OXE-7D03")], existentes: antigos });
    expect(p.resolver.map((r) => r.id).sort()).toEqual(["x1", "x2"]);
    expect(p.resolver[0].contexto).toMatchObject({ auto_resolvido: true, substituido_por_agregado: true });
    expect(p.inserir).toHaveLength(1);
    expect(p.inserir[0].contexto.placas).toEqual(["OXE-7D03", "RQU-1B50"]);
  });

  it("mesmo carro em duas linhas (dois pontos) conta uma vez", () => {
    const p = planejarRomaneioAusente({ ...base, emRota: [carro("RQU-1B50"), carro("RQU-1B50")], existentes: [] });
    expect(p.inserir[0].contexto.placas).toEqual(["RQU-1B50"]);
  });
});
