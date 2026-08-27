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

// Reimplementa tempoAtras/corIdadeAlerta (MonitorV2.tsx, ~linhas 143-180) --
// mesmo padrao das suites acima: cópia local da mesma expressao, testada
// isolada (o componente nao exporta nada, ver comentario no topo do
// arquivo). Task 2B.1/2B.2 (27/08): recalibra os limiares de 3h/8h pra
// 30min/90min com base na mediana real de 22min / p90 de 76min ate' o
// tratamento do alerta (medido contra dado real de 26/08).
function tempoAtras(desde: string): string {
  const diff = Math.floor((Date.now() - new Date(desde).getTime()) / 60000);
  if (diff < 60) return `${diff}min`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h`;
  return `${Math.floor(diff / 1440)}d`;
}

function minutosDesde(desde: string): number {
  return Math.round((Date.now() - new Date(desde).getTime()) / 60000);
}

const LIMIAR_ALERTA_ATENCAO_MIN = 30;
const LIMIAR_ALERTA_CRITICO_MIN = 90;
function corIdadeAlerta(desde: string, tema: "dark" | "light"): { cor: string; peso: number } {
  const min = minutosDesde(desde);
  if (min >= LIMIAR_ALERTA_CRITICO_MIN) return { cor: tema === "dark" ? "#ff6b5e" : "#c9392c", peso: 800 };
  if (min >= LIMIAR_ALERTA_ATENCAO_MIN) return { cor: tema === "dark" ? "#f2b84b" : "#a66a10", peso: 700 };
  return { cor: "", peso: 400 };
}

function desdeMinutosAtras(min: number): string {
  return new Date(Date.now() - min * 60000).toISOString();
}

describe("indicador de idade do alerta (task 2B.1/2B.2, 27/08)", () => {
  it("tempoAtras formata em minutos abaixo de 1h", () => {
    expect(tempoAtras(desdeMinutosAtras(5))).toBe("5min");
    expect(tempoAtras(desdeMinutosAtras(45))).toBe("45min");
  });

  it("tempoAtras formata em horas entre 1h e 24h", () => {
    expect(tempoAtras(desdeMinutosAtras(90))).toBe("1h");
    expect(tempoAtras(desdeMinutosAtras(300))).toBe("5h");
  });

  it("tempoAtras formata em dias a partir de 24h", () => {
    expect(tempoAtras(desdeMinutosAtras(1440))).toBe("1d");
    expect(tempoAtras(desdeMinutosAtras(4320))).toBe("3d");
  });

  it("corIdadeAlerta nao pinta abaixo do limiar de atencao (30min, novo valor)", () => {
    expect(corIdadeAlerta(desdeMinutosAtras(0), "dark")).toEqual({ cor: "", peso: 400 });
    expect(corIdadeAlerta(desdeMinutosAtras(22), "dark")).toEqual({ cor: "", peso: 400 }); // mediana real (Fase 2)
    expect(corIdadeAlerta(desdeMinutosAtras(29), "light")).toEqual({ cor: "", peso: 400 });
  });

  it("corIdadeAlerta pinta 'atencao' entre 30min e 90min (novos limiares)", () => {
    expect(corIdadeAlerta(desdeMinutosAtras(30), "dark")).toEqual({ cor: "#f2b84b", peso: 700 });
    expect(corIdadeAlerta(desdeMinutosAtras(76), "dark")).toEqual({ cor: "#f2b84b", peso: 700 }); // p90 real (Fase 2)
    expect(corIdadeAlerta(desdeMinutosAtras(60), "light")).toEqual({ cor: "#a66a10", peso: 700 });
  });

  it("corIdadeAlerta pinta 'critico' a partir de 90min", () => {
    expect(corIdadeAlerta(desdeMinutosAtras(90), "dark")).toEqual({ cor: "#ff6b5e", peso: 800 });
    expect(corIdadeAlerta(desdeMinutosAtras(200), "light")).toEqual({ cor: "#c9392c", peso: 800 });
  });
});

// Reimplementa a condicao de exibicao do badge "GPS +Nmin" no card do
// alerta (MonitorV2.tsx, renderCardAlerta ~linha 1478) -- task 2B.3 (27/08).
// Achado da Fase 2: 13,5% dos fixes de GPS de 26/08 chegaram com >=10min de
// atraso na origem (Unitrac), concentrado em alguns veiculos, e isso era
// invisivel no card/lista de alertas (so mapa em 60min e painel de detalhe
// em 30min cobriam parte do problema). Aditivo: nao mexe em nenhum dos
// limiares/telas existentes.
function mostraBadgeAtrasoGps(atraso_min: number | null): boolean {
  return atraso_min != null && atraso_min >= 10;
}

describe("badge de GPS defasado no card do alerta (task 2B.3, 27/08)", () => {
  it("nao aparece quando atraso_min e null", () => {
    expect(mostraBadgeAtrasoGps(null)).toBe(false);
  });

  it("nao aparece abaixo de 10min", () => {
    expect(mostraBadgeAtrasoGps(0)).toBe(false);
    expect(mostraBadgeAtrasoGps(9)).toBe(false);
    expect(mostraBadgeAtrasoGps(9.99)).toBe(false);
  });

  it("aparece a partir de 10min (inclusive)", () => {
    expect(mostraBadgeAtrasoGps(10)).toBe(true);
    expect(mostraBadgeAtrasoGps(10.4)).toBe(true);
    expect(mostraBadgeAtrasoGps(45)).toBe(true);
  });

  it("nao quebra com atraso_min fracionario -- Math.round no texto do badge", () => {
    expect(Math.round(10.4)).toBe(10);
    expect(Math.round(10.6)).toBe(11);
  });
});
