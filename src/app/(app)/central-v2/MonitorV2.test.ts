import { describe, it, expect } from "vitest";

// MonitorV2.tsx nao exporta nada (e um componente .tsx default-export gigante,
// sem suite de componente/RTL no repo -- ver CardAlertaCritico.test.ts pro
// mesmo padrao ja usado aqui: reimplementar a logica pura idêntica num
// .test.ts separado). Task A1 (27/08): aba "Desvios" fixa e sempre visivel,
// independente de cod_user_unitrac, filtrando so desvio+parada_anomala. Ver
// MonitorV2.tsx (TIPOS_ABA_DESVIOS / bloco de render das filter tabs) pra
// fonte da verdade -- essas constantes/funcao replicam identico o que la
// esta.
const TIPOS_ABA_DESVIOS = ["desvio", "parada_anomala"];

// Antes desta task, as abas eram `labelFoco ? ["tudo","foco"] : ["tudo"]`,
// onde labelFoco vinha de um Record por cliente (LABEL_FOCO_POR_CLIENTE) --
// cliente nao mapeado perdia a 2a aba silenciosamente. Agora e fixo, sem
// depender de nenhum Record/cliente.
function abasVisiveis(): readonly ["tudo", "desvios"] {
  return ["tudo", "desvios"] as const;
}

function filtrarPorVista<T extends { tipo: string }>(alertas: T[], vista: "tudo" | "desvios"): T[] {
  return alertas.filter(a => {
    if (vista === "desvios" && !TIPOS_ABA_DESVIOS.includes(a.tipo)) return false;
    return true;
  });
}

describe("aba Desvios fixa (task A1)", () => {
  it("aparece pra qualquer cliente, mesmo sem entrada em nenhum Record por cliente", () => {
    // Antigamente isso dependia de LABEL_FOCO_POR_CLIENTE[cliente] existir.
    // Agora abasVisiveis() nem recebe `cliente` como parametro -- nao ha como
    // um cliente ficar de fora.
    expect(abasVisiveis()).toEqual(["tudo", "desvios"]);
  });

  it("filtra so desvio + parada_anomala, nunca parada_fora_tapete/parada_sem_marcacao", () => {
    const alertas = [
      { tipo: "desvio" },
      { tipo: "parada_anomala" },
      { tipo: "parada_fora_tapete" },
      { tipo: "parada_sem_marcacao" },
      { tipo: "favela" },
    ];
    const filtrados = filtrarPorVista(alertas, "desvios");
    expect(filtrados.map(a => a.tipo).sort()).toEqual(["desvio", "parada_anomala"]);
  });

  it("aba TUDO continua mostrando todos os tipos, sem regressao", () => {
    const alertas = [
      { tipo: "desvio" },
      { tipo: "parada_anomala" },
      { tipo: "parada_fora_tapete" },
      { tipo: "parada_sem_marcacao" },
      { tipo: "favela" },
      { tipo: "panico" },
    ];
    const filtrados = filtrarPorVista(alertas, "tudo");
    expect(filtrados).toHaveLength(alertas.length);
  });
});
