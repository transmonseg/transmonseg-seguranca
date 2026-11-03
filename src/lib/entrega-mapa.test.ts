import { describe, it, expect } from "vitest";
import { janelaDiaBR, paradaDaEntrega, maisPerto, afinarRastro, normPlacaVariantes, COR_SITUACAO_ENTREGA, ROTULO_SITUACAO_ENTREGA, codUnitracDaFrota, clienteDaEntrega } from "./entrega-mapa";

const p = (hhmm: string, lat: number, lng: number) => ({ lat, lng, em: `2026-10-05T${hhmm}:00-03:00` });

describe("entrega no mapa", () => {
  it("janela do dia em BRT", () => {
    expect(janelaDiaBR("2026-10-05")).toEqual({ inicio: "2026-10-05T03:00:00.000Z", fim: "2026-10-06T03:00:00.000Z" });
  });
  it("parada da entrega = média das posições entre chegada e saída", () => {
    const pts = [p("10:00", -22.9, -43.2), p("10:15", -22.91, -43.21), p("10:30", -22.93, -43.23), p("11:10", -23, -43.3)];
    const r = paradaDaEntrega(pts, "2026-10-05", "10:13", "10:58")!;
    expect(r.lat).toBeCloseTo(-22.92, 3);
    expect(r.lng).toBeCloseTo(-43.22, 3);
    expect(paradaDaEntrega(pts, "2026-10-05", null, null)).toBeNull();
  });
  it("sem posição dentro da janela: a mais próxima da chegada (até 15 min)", () => {
    const pts = [p("10:00", -22.9, -43.2), p("11:30", -23, -43.3)];
    expect(paradaDaEntrega(pts, "2026-10-05", "10:10", "10:20")).toMatchObject({ lat: -22.9, lng: -43.2 });
    expect(paradaDaEntrega(pts, "2026-10-05", "10:40", "10:50")).toBeNull();
  });
  it("ponto do dia mais perto do cliente", () => {
    const pts = [p("08:00", -22.9, -43.2), p("09:00", -22.95, -43.25), p("10:00", -23, -43.3)];
    const r = maisPerto(pts, { lat: -22.951, lng: -43.251 })!;
    expect(r.em).toBe(pts[1].em);
    expect(r.distM).toBeLessThan(200);
  });
  it("afina o rastro mantendo primeiro e último", () => {
    const pts = Array.from({ length: 10 }, (_, i) => p(`10:${String(i).padStart(2, "0")}`, i, i));
    const r = afinarRastro(pts, 4);
    expect(r.length).toBeLessThanOrEqual(5);
    expect(r[0]).toBe(pts[0]);
    expect(r[r.length - 1]).toBe(pts[9]);
  });
  it("placa do KPI casa com a do monitoramento: com e sem hífen e com O/0 e I/1 trocados (frota com cadastro duplicado)", () => {
    const v = normPlacaVariantes("rqo9h37");
    expect(v).toEqual(expect.arrayContaining(["RQO9H37", "RQO-9H37", "RQ09H37", "RQ0-9H37"]));
    expect(new Set(v).size).toBe(v.length);
    expect(normPlacaVariantes("TTK4D17")).toEqual(expect.arrayContaining(["TTK4D17", "TTK-4D17", "TTK4DI7", "TTK-4DI7"]));
  });

  // F1-10 (pendência): o KPI manda a situação "fora_da_conta" (cinza) desde
  // 9b350f2; a tela de entrega pintava de cinza escuro "pendente" e sem rótulo.
  it("situação fora_da_conta vinda do KPI: cinza #cbd5e1 e rótulo \"Fora da conta\"", () => {
    expect(COR_SITUACAO_ENTREGA.fora_da_conta).toBe("#cbd5e1");
    expect(ROTULO_SITUACAO_ENTREGA.fora_da_conta).toBe("Fora da conta");
    // as que já existiam continuam iguais
    expect(COR_SITUACAO_ENTREGA.entregue).toBe("#22c55e");
    expect(ROTULO_SITUACAO_ENTREGA.nao_foi).toBe("Não foi");
  });
});

// F2-11 (AC-11): "Ver no monitoramento" da Rio Quality. O KPI manda a frota
// (nutrimax | rioquality); a placa só abre dentro dela, e a conta de um
// cliente só (ericanutrymax = Nutry Max) nunca abre placa da RQ.
describe("entrega no mapa: frota do KPI e conta do cliente", () => {
  const NUTRY = "cfcb52f5-fd01-47c7-988c-d13a10f0d8fd";
  const RQ = "16a32814-3402-4b2d-b974-aef0707d7a4e";
  it("frota do KPI -> cod_user_unitrac", () => {
    expect(codUnitracDaFrota("rioquality")).toBe("598");
    expect(codUnitracDaFrota("nutrimax")).toBe("4096");
    expect(codUnitracDaFrota("")).toBeNull();
    expect(codUnitracDaFrota("benassi")).toBeNull();
  });
  it("ericanutrymax (conta só da Nutry) não abre placa da RQ", () => {
    expect(clienteDaEntrega({ tipo: "um", clienteId: NUTRY }, RQ)).toEqual({ tipo: "nenhum", motivo: "outra_frota" });
  });
  it("conta só da Nutry na frota da Nutry (ou KPI antigo, sem frota): só a Nutry", () => {
    expect(clienteDaEntrega({ tipo: "um", clienteId: NUTRY }, NUTRY)).toEqual({ tipo: "cliente", clienteId: NUTRY });
    expect(clienteDaEntrega({ tipo: "um", clienteId: NUTRY }, null)).toEqual({ tipo: "cliente", clienteId: NUTRY });
  });
  it("central abre a RQ só na frota da RQ; sem frota (KPI antigo) continua sem filtro", () => {
    expect(clienteDaEntrega({ tipo: "todos" }, RQ)).toEqual({ tipo: "cliente", clienteId: RQ });
    expect(clienteDaEntrega({ tipo: "todos" }, null)).toEqual({ tipo: "todos" });
  });
  it("sem login/operador não abre nada", () => {
    expect(clienteDaEntrega({ tipo: "nenhum" }, RQ)).toEqual({ tipo: "nenhum", motivo: "sem_acesso" });
    expect(clienteDaEntrega({ tipo: "nenhum" }, null)).toEqual({ tipo: "nenhum", motivo: "sem_acesso" });
  });
});

// F4-07 (GEO-24): o KPI manda o selo de precisão (prec) e o raio do círculo de
// incerteza (raio) do ponto do cliente. Raio fora de 1 m-5 km ou selo
// desconhecido são ignorados (nunca desenha um círculo inventado).
describe("selo e círculo de incerteza do ponto (F4-07)", () => {
  it("selo conhecido com raio", async () => {
    const { seloDoPonto } = await import("./entrega-mapa");
    expect(seloDoPonto("interpolado", "50")).toEqual({ rotulo: "Entre números da rua", raioM: 50 });
    expect(seloDoPonto("rua", "1000")).toEqual({ rotulo: "Só a rua", raioM: 1000 });
    expect(seloDoPonto("manual", "")).toEqual({ rotulo: "Ponto corrigido à mão", raioM: null });
  });
  it("sem selo, selo desconhecido ou raio absurdo", async () => {
    const { seloDoPonto } = await import("./entrega-mapa");
    expect(seloDoPonto("", "50")).toBeNull();
    expect(seloDoPonto("chute", "50")).toBeNull();
    expect(seloDoPonto("exato", "999999")).toEqual({ rotulo: "Número exato", raioM: null });
    expect(seloDoPonto("exato", "abc")).toEqual({ rotulo: "Número exato", raioM: null });
  });
});

// RAS-03 (auditoria 03/11): o histórico grava a cada 30 s mesmo com a leitura
// velha da Unitrac; a hora do ponto é a do GPS (criado_em - atraso_min), não
// a da gravação. RQQ-5B81 em 03/11: último GPS 12:07, gravado até 17:19.
import { pontoDoHistorico, posicaoAtual } from "./entrega-mapa";

describe("RAS-03: hora do GPS na Entrega no mapa", () => {
  const linha = (hhmm: string, lat: number, atraso_min: number) =>
    ({ lat, lng: -43.2, criado_em: `2026-11-03T${hhmm}:00-03:00`, atraso_min });
  // anda até 12:07 e congela: a mesma coordenada continua sendo gravada com atraso crescente
  const serie = [linha("12:05", -22.90, 0), linha("12:07", -22.91, 0), linha("13:07", -22.91, 60), linha("17:19", -22.91, 312)]
    .map(pontoDoHistorico);

  it("em = criado_em - atraso_min", () => {
    expect(Date.parse(serie[3].em)).toBe(Date.parse("2026-11-03T12:07:00-03:00"));
    expect(Date.parse(serie[2].em)).toBe(Date.parse("2026-11-03T12:07:00-03:00"));
    expect(Date.parse(serie[0].em)).toBe(Date.parse("2026-11-03T12:05:00-03:00"));
  });
  it("atraso ausente = hora da gravação", () => {
    const p = pontoDoHistorico({ lat: -22.9, lng: -43.2, criado_em: "2026-11-03T12:00:00-03:00", atraso_min: null });
    expect(Date.parse(p.em)).toBe(Date.parse("2026-11-03T12:00:00-03:00"));
  });
  it("posição atual com sinal velho: semSinal e 'Último sinal às 12:07', nunca 'Agora'", () => {
    const a = posicaoAtual(serie, new Date("2026-11-03T17:19:30-03:00"))!;
    expect(Date.parse(a.em)).toBe(Date.parse("2026-11-03T12:07:00-03:00"));
    expect(a.semSinal).toBe(true);
    expect(a.rotulo.startsWith("Último sinal às 12:07")).toBe(true);
    expect(a.rotulo).toContain("há 5 h");
    expect(a.rotulo).not.toContain("Agora");
  });
  it("leitura recente: 'Agora (HH:MM)' e semSinal false", () => {
    const a = posicaoAtual([linha("17:18", -22.9, 1)].map(pontoDoHistorico), new Date("2026-11-03T17:19:30-03:00"))!;
    expect(a.semSinal).toBe(false);
    expect(a.rotulo).toBe("Agora (17:17)");
  });
  it("sem pontos => null", () => expect(posicaoAtual([], new Date())).toBeNull());
});
