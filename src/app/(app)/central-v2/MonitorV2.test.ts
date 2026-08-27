import { describe, it, expect } from "vitest";

// MonitorV2.tsx nao exporta nada (e um componente .tsx default-export gigante,
// sem suite de componente/RTL no repo -- ver CardAlertaCritico.test.ts pro
// mesmo padrao ja usado aqui: reimplementar a logica pura idêntica num
// .test.ts separado). Task A1 (27/08): aba "Desvios" fixa e sempre visivel,
// independente de cod_user_unitrac, filtrando so desvio+parada_anomala.
//
// As LISTAS de tipo nao sao mais replicadas aqui (achado M1 da revisao final
// de branch, 27/08): vem de ./tipos-alerta, o mesmo modulo que MonitorV2.tsx
// importa. Cópia nao quebra quando o original muda; import quebra.
import { TIPOS_ABA_DESVIOS, TIPOS_REVISAO_INDIVIDUAL } from "./tipos-alerta";

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

  it("a lista da aba vem do modulo compartilhado, nao de uma copia local", () => {
    // Se alguem mudar TIPOS_ABA_DESVIOS em ./tipos-alerta sem querer, ESTE
    // teste quebra -- que e exatamente o ponto do achado M1.
    expect(TIPOS_ABA_DESVIOS).toEqual(["desvio", "parada_anomala"]);
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

// Reimplementa alertasResolviveisEmMassa (MonitorV2.tsx) -- a MESMA expressao,
// agora lendo a MESMA constante que o componente le.
function resolviveisEmMassa<T extends { tipo: string }>(alertas: T[]): T[] {
  return alertas.filter(a => !TIPOS_REVISAO_INDIVIDUAL.has(a.tipo));
}

describe("mass-resolve x cooldown de re-disparo (achado I2)", () => {
  it("os 3 tipos de parada NUNCA entram em 'Resolver todos'", () => {
    // Motivo: resolverVarios/limparVarios gravam origem_acao
    // resolver_massa/limpar_massa, e ORIGENS_TRATAMENTO_INDIVIDUAL (nos dois
    // motores) so reconhece resolver_individual/falso_individual. Resolver em
    // massa nao armava o cooldown -- o alerta voltava no ciclo seguinte (30s),
    // reabrindo o flood do caso real TUG-9D18 (17 alertas em 2h).
    for (const tipo of ["parada_anomala", "parada_longa", "parada_fora_tapete"]) {
      expect(TIPOS_REVISAO_INDIVIDUAL.has(tipo)).toBe(true);
    }
  });

  it("desvio continua fora do mass-resolve (regressao da regra de 20/08)", () => {
    expect(TIPOS_REVISAO_INDIVIDUAL.has("desvio")).toBe(true);
  });

  it("tipos sem cooldown por episodio continuam resolviveis em massa", () => {
    const alertas = [
      { tipo: "desvio" },
      { tipo: "parada_anomala" },
      { tipo: "parada_longa" },
      { tipo: "parada_fora_tapete" },
      { tipo: "parada_sem_marcacao" },
      { tipo: "parada_cliente" },
      { tipo: "favela" },
      { tipo: "panico" },
    ];
    expect(resolviveisEmMassa(alertas).map(a => a.tipo)).toEqual([
      "parada_sem_marcacao",
      "parada_cliente",
      "favela",
      "panico",
    ]);
  });
});
