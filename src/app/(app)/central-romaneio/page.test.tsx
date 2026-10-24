import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

// R-F3-09-01 (revisão da Fase 3): o alerta interno rastreador_mudo_com_carga
// chegava à conta do cliente pelo SSR da Central Romaneio. O filtro
// semAlertasInternos só estava em /api/alertas-romaneio; a página montava
// alertasIniciais direto de alertas_romaneio. Caso real: 23/10 10h, motor
// cria o alerta para LTZ-7I72 e EEG-2F60 (RQ); o login da RQ abre
// /central-romaneio e o card "Rastreador mudo com carga" vem na primeira
// pintura (e fica, se o poll falhar).

const RQ = "cli-rq";
const NUTRY = "cli-nutry";

const tabelas: Record<string, unknown[]> = {};
const acessoAtual: { valor: unknown } = { valor: { tipo: "todos" } };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      let head = false;
      for (const m of ["eq", "in", "not", "order"]) b[m] = () => b;
      b.select = (_c: string, opts?: { head?: boolean }) => { head = !!opts?.head; return b; };
      (b as { then?: unknown }).then = (res: (v: unknown) => unknown) =>
        Promise.resolve(head ? { count: 7, error: null } : { data: tabelas[tabela] ?? [], error: null }).then(res);
      return b;
    },
  }),
}));

vi.mock("@/lib/acesso-cliente", async () => {
  const real = await vi.importActual<typeof import("@/lib/acesso-cliente")>("@/lib/acesso-cliente");
  return { ...real, acessoDoUsuario: async () => acessoAtual.valor };
});

vi.mock("../central-v2/MonitorV2", () => ({ default: () => null }));
vi.mock("./GateRomaneio", () => ({ default: () => null }));
vi.mock("./AvisoEscalaPao", () => ({ default: () => null }));

import CentralRomaneioPage from "./page";

function alerta(id: string, tipo: string, veiculo_id: string, nivel: "critico" | "atencao" = "atencao") {
  return { id, cliente_id: RQ, veiculo_id, nivel, tipo, motivo: null, desde: "2026-10-23T13:00:00Z", status: "ativo", score: 20, lat: null, lng: null, contexto: null };
}

beforeEach(() => {
  tabelas.clientes = [
    { id: NUTRY, nome: "Nutry Max", cod_user_unitrac: "1" },
    { id: RQ, nome: "Rio Quality", cod_user_unitrac: "2" },
  ];
  tabelas.veiculos = [
    { id: "v-ltz", cliente_id: RQ, placa: "LTZ-7I72", cv: "100" },
    { id: "v-eeg", cliente_id: RQ, placa: "EEG-2F60", cv: "101" },
    { id: "v-kwq", cliente_id: RQ, placa: "KWQ-6252", cv: "102" },
  ];
  tabelas.posicoes_atuais = [];
  tabelas.alertas_romaneio = [
    alerta("a-ltz", "rastreador_mudo_com_carga", "v-ltz"),
    alerta("a-eeg", "rastreador_mudo_com_carga", "v-eeg"),
    alerta("a-kwq", "desvio", "v-kwq", "critico"),
  ];
});

async function alertasIniciaisDa(acesso: unknown): Promise<{ id: string; tipo: string }[]> {
  acessoAtual.valor = acesso;
  const el = (await CentralRomaneioPage({ searchParams: Promise.resolve({ cliente: "2" }) })) as ReactElement<{ alertasIniciais: { id: string; tipo: string }[] }>;
  expect(el).toBeTruthy();
  return el.props.alertasIniciais;
}

describe("Central Romaneio (SSR) e alerta interno", () => {
  it("login da RQ (acesso 'um') não recebe rastreador_mudo_com_carga na primeira pintura", async () => {
    const lista = await alertasIniciaisDa({ tipo: "um", clienteId: RQ });
    expect(lista.map((a) => a.id)).toEqual(["a-kwq"]);
  });

  it("central (operador Transmonseg) continua vendo os dois cards de rastreador mudo", async () => {
    const lista = await alertasIniciaisDa({ tipo: "todos" });
    expect(lista.map((a) => a.id).sort()).toEqual(["a-eeg", "a-kwq", "a-ltz"]);
  });
});
