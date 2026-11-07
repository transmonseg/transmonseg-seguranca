import { describe, it, expect } from "vitest";
import { ajustarAlertaRetornoBaseComPendente, motivoVoltandoBaseComPendente, type LeituraRetornoBase } from "./desvio";
import type { Alerta } from "./detectores";

// 15 leituras a cada 60 s chegando 700 m mais perto da base por leitura.
const voltando: LeituraRetornoBase[] = Array.from({ length: 15 }, (_, i) => ({ tSegundos: i * 60, distBaseM: 40_000 - i * 700, deslocamentoM: i === 0 ? 0 : 800 }));
// Mesma janela se afastando da base.
const indoEmbora: LeituraRetornoBase[] = voltando.map((l, i) => ({ ...l, distBaseM: 30_000 + i * 700 }));

const desvio = (extra: Partial<Alerta> = {}): Alerta =>
  ({ tipo: "desvio", nivel: "critico", score: 75, motivo: "Afastando de todos os clientes pendentes e da base (distância real de rua)", origemDesvio: "afastando_geral", ...extra }) as Alerta;

describe("07/11: volta pra base depois das 14:30 com cliente pendente vira atencao (nunca some)", () => {
  it("voltando pra base as 17:40 com 3 pendentes: atencao com o texto certo, origem igual", () => {
    const r = ajustarAlertaRetornoBaseComPendente(desvio(), { leituras: voltando, agoraLocal: { hora: 17, minuto: 40 }, pendentesNoRaio: 3 });
    expect(r).toMatchObject({ tipo: "desvio", nivel: "atencao", origemDesvio: "afastando_geral", motivo: "Voltando para a base com 3 clientes sem entrega confirmada" });
  });

  it("antes das 14:30 continua critico (volta cedo pra base e' suspeita)", () => {
    expect(ajustarAlertaRetornoBaseComPendente(desvio(), { leituras: voltando, agoraLocal: { hora: 11, minuto: 0 }, pendentesNoRaio: 3 })?.nivel).toBe("critico");
  });

  it("se afastando da base a tarde continua critico", () => {
    expect(ajustarAlertaRetornoBaseComPendente(desvio(), { leituras: indoEmbora, agoraLocal: { hora: 17, minuto: 40 }, pendentesNoRaio: 3 })?.nivel).toBe("critico");
  });

  it("sem janela de GPS, sem pendente ou outra origem: nao mexe", () => {
    const a = desvio();
    expect(ajustarAlertaRetornoBaseComPendente(a, { leituras: null, agoraLocal: { hora: 17, minuto: 40 }, pendentesNoRaio: 3 })).toBe(a);
    expect(ajustarAlertaRetornoBaseComPendente(a, { leituras: voltando, agoraLocal: { hora: 17, minuto: 40 }, pendentesNoRaio: 0 })).toBe(a);
    const rua = desvio({ origemDesvio: "rua_rara_frota" });
    expect(ajustarAlertaRetornoBaseComPendente(rua, { leituras: voltando, agoraLocal: { hora: 17, minuto: 40 }, pendentesNoRaio: 3 })).toBe(rua);
    expect(ajustarAlertaRetornoBaseComPendente(null, { leituras: voltando, agoraLocal: { hora: 17, minuto: 40 }, pendentesNoRaio: 3 })).toBeNull();
  });

  it("singular", () => {
    expect(motivoVoltandoBaseComPendente(1)).toBe("Voltando para a base com 1 cliente sem entrega confirmada");
  });
});
