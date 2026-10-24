// F2-15 (MON-12, plano mestre 23/10): frota da Rio Quality vinda do KPI.
//
// A masn/598 da Unitrac responde "sem permissao", entao 02_veiculos.mjs nao
// sincroniza a RQ. A frota da RQ no monitoramento foi copiada uma vez (06/10)
// da kpi_rioquality_frota do KPI e ficou parada. O KPI descobre os cvs novos
// (scripts/descobrir-cv-rq.ts, so' os "ok") e manda a frota inteira para
// POST /api/veiculos/rioquality; aqui so' entra o cv que falta. Veiculo ja'
// cadastrado nunca e' renomeado nem desativado (divergencia vira aviso).

export type VeiculoRQ = { placa: string; cv: string };
export type VeiculoExistente = { id: string; cliente_id: string; cv: string; placa: string };
export type PlanoFrotaRQ = {
  inserir: { cliente_id: string; cv: string; placa: string; perfil: "auto"; ativo: true }[];
  jaExistiam: number;
  conflitos: { placa: string; cv: string; motivo: string }[];
};

/** "tup0b49" -> "TUP-0B49" (formato da tabela veiculos). Fora de 7 caracteres: null. */
function placaMonitoramento(bruta: unknown): string | null {
  if (typeof bruta !== "string") return null;
  const p = bruta.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return p.length === 7 ? `${p.slice(0, 3)}-${p.slice(3)}` : null;
}

export function lerVeiculosRQ(brutos: unknown[]): VeiculoRQ[] {
  const out: VeiculoRQ[] = [];
  for (const b of brutos) {
    if (!b || typeof b !== "object") continue;
    const r = b as { placa?: unknown; cv?: unknown };
    const placa = placaMonitoramento(r.placa);
    const cv = typeof r.cv === "number" || typeof r.cv === "string" ? String(r.cv).trim() : "";
    if (placa && /^\d+$/.test(cv)) out.push({ placa, cv });
  }
  return out;
}

export function planejarFrotaRQ(clienteIdRQ: string, existentes: VeiculoExistente[], recebidos: VeiculoRQ[]): PlanoFrotaRQ {
  const porCvRQ = new Map(existentes.filter((v) => v.cliente_id === clienteIdRQ).map((v) => [String(v.cv), v]));
  const porPlaca = new Map(existentes.map((v) => [v.placa, v]));
  const plano: PlanoFrotaRQ = { inserir: [], jaExistiam: 0, conflitos: [] };
  const vistos = new Set<string>();
  for (const r of recebidos) {
    if (vistos.has(r.cv)) continue;
    vistos.add(r.cv);
    const doCv = porCvRQ.get(r.cv);
    if (doCv) {
      if (doCv.placa === r.placa) plano.jaExistiam++;
      else plano.conflitos.push({ ...r, motivo: `cv já cadastrado com a placa ${doCv.placa}` });
      continue;
    }
    const daPlaca = porPlaca.get(r.placa);
    if (daPlaca) {
      plano.conflitos.push({ ...r, motivo: `placa já cadastrada no cv ${daPlaca.cv}${daPlaca.cliente_id === clienteIdRQ ? "" : " de outro cliente"}` });
      continue;
    }
    plano.inserir.push({ cliente_id: clienteIdRQ, cv: r.cv, placa: r.placa, perfil: "auto", ativo: true });
    porPlaca.set(r.placa, { id: "novo", cliente_id: clienteIdRQ, cv: r.cv, placa: r.placa });
  }
  return plano;
}
