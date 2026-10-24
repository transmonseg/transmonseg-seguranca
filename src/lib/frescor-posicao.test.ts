import { describe, it, expect } from "vitest";
import { atrasoEfetivoMin, sqlAtrasoEfetivo, SQL_VEICULOS_EM_FAVELA, SQL_VEICULOS_SEM_ROMANEIO, veiculosFavelaDoCiclo } from "./frescor-posicao";

// F1-15 (AC-01): posicoes_atuais.atraso_min e' o atraso que a Unitrac
// informou NA ULTIMA LEITURA gravada. Quando o motor para de gravar o
// veiculo (cliente desativado: Benassi desde 06/10; carro fora da API:
// TTJ-0F00, TTP-0H36, TTI-6D27, TTT-1E20), o numero congela baixo e o carro
// parece "fresco" para sempre. Frescor real = max(atraso_min, idade do
// updated_at). Nunca datagps (3 h deslocado).
describe("atrasoEfetivoMin", () => {
  const agora = new Date("2026-10-23T20:00:00Z");

  it("leitura gravada agora: vale o atraso_min", () => {
    expect(atrasoEfetivoMin(5, "2026-10-23T19:59:40Z", agora)).toBe(5);
  });

  it("updated_at velho com atraso_min baixo NAO e' fresco (TTT-1E20: atraso 0, gravado ha 10 dias)", () => {
    const r = atrasoEfetivoMin(0, "2026-10-13T15:06:00Z", agora)!;
    expect(r).toBeGreaterThan(60);
  });

  it("Benassi congelada (atraso_min 16, gravada em 06/10) passa do limiar de 60 min", () => {
    expect(atrasoEfetivoMin(16, "2026-10-06T00:00:00Z", agora)!).toBeGreaterThan(60);
  });

  it("atraso_min nulo continua nulo (nao vira fresco pela idade)", () => {
    expect(atrasoEfetivoMin(null, "2026-10-23T19:59:40Z", agora)).toBeNull();
  });

  it("sem updated_at legivel: fica o atraso_min (nunca piora por falta de dado)", () => {
    expect(atrasoEfetivoMin(7, null, agora)).toBe(7);
    expect(atrasoEfetivoMin(7, "lixo", agora)).toBe(7);
  });

  it("atraso_min maior que a idade: vale o atraso_min", () => {
    expect(atrasoEfetivoMin(90, "2026-10-23T19:50:00Z", agora)).toBe(90);
  });
});

describe("sqlAtrasoEfetivo", () => {
  it("usa updated_at e preserva nulo", () => {
    const s = sqlAtrasoEfetivo("p");
    expect(s).toContain("p.updated_at");
    expect(s).toContain("p.atraso_min IS NULL THEN NULL");
    expect(s).toContain("GREATEST");
    expect(s).not.toContain("datagps");
  });
});

describe("SQL_VEICULOS_EM_FAVELA (detector da Central)", () => {
  it("so' cliente ativo: Benassi desativada nao gera alerta (28.400/dia)", () => {
    expect(SQL_VEICULOS_EM_FAVELA).toMatch(/JOIN clientes c ON c\.id = v\.cliente_id AND c\.ativo/);
  });
  it("frescor pelo atraso efetivo (updated_at), nao so' pelo atraso_min gravado", () => {
    expect(SQL_VEICULOS_EM_FAVELA).toContain(`${sqlAtrasoEfetivo("p")} <= 60`);
    expect(SQL_VEICULOS_EM_FAVELA).not.toMatch(/WHERE p\.atraso_min <= 60/);
  });
});

describe("SQL_VEICULOS_SEM_ROMANEIO (romaneio_ausente)", () => {
  it("frescor pelo atraso efetivo e so' cliente ativo", () => {
    expect(SQL_VEICULOS_SEM_ROMANEIO).toContain(`${sqlAtrasoEfetivo("pa")} < $2`);
    expect(SQL_VEICULOS_SEM_ROMANEIO).toContain("c.ativo");
  });
});

// Revisao F1-15 (R3): o dedupe de alerta de favela so' le alertas ativos de
// clientesComSucesso. Cliente ATIVO cuja busca na Unitrac falhou no ciclo
// (timeout da Nutry) continuava na SQL_VEICULOS_EM_FAVELA, ficava fora do
// Map e ganhava um alerta 'favela' NOVO a cada 30 s (ate' 60 min).
describe("veiculosFavelaDoCiclo", () => {
  const NUTRY = "cli-nutry";
  const RQ = "cli-rq";
  const linhas = [
    { veiculo_id: "v-nutry", cliente_id: NUTRY },
    { veiculo_id: "v-rq", cliente_id: RQ },
  ];

  it("busca da Nutry deu timeout (clientesComSucesso = {RQ}): carro da Nutry em favela fica fora do ciclo", () => {
    expect(veiculosFavelaDoCiclo(linhas, new Set([RQ])).map((v) => v.veiculo_id)).toEqual(["v-rq"]);
  });

  it("nenhum cliente com sucesso: nenhum carro em favela (nada de duplicar todos)", () => {
    expect(veiculosFavelaDoCiclo(linhas, new Set())).toEqual([]);
  });

  it("todos com sucesso: nada muda", () => {
    expect(veiculosFavelaDoCiclo(linhas, new Set([NUTRY, RQ]))).toEqual(linhas);
  });
});
