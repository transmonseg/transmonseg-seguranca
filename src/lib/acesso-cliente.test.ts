import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { podeVerCliente, filtrarPorAcesso } from "./acesso-cliente";

const NUTRY = "cfcb52f5-fd01-47c7-988c-d13a10f0d8fd";
const RQ = "16a32814-3402-4b2d-b974-aef0707d7a4e";
const clientes = [{ id: NUTRY, nome: "Nutry Max" }, { id: RQ, nome: "Rio Quality" }];

describe("acesso por cliente", () => {
  it("conta da Nutry Max só vê a Nutry Max", () => {
    const acesso = { tipo: "um" as const, clienteId: NUTRY };
    expect(filtrarPorAcesso(acesso, clientes).map((c) => c.nome)).toEqual(["Nutry Max"]);
    expect(podeVerCliente(acesso, RQ)).toBe(false);
    expect(podeVerCliente(acesso, NUTRY)).toBe(true);
  });
  it("central (cliente_id null) vê todos", () => {
    expect(filtrarPorAcesso({ tipo: "todos" }, clientes)).toHaveLength(2);
  });
  it("sem operador cadastrado não vê nada", () => {
    expect(filtrarPorAcesso({ tipo: "nenhum" }, clientes)).toHaveLength(0);
    expect(podeVerCliente({ tipo: "nenhum" }, NUTRY)).toBe(false);
  });
  it("cliente vazio nunca passa pra conta restrita", () => {
    expect(podeVerCliente({ tipo: "um", clienteId: NUTRY }, null)).toBe(false);
  });
});
