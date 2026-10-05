"use client";

import { useEffect, useMemo, useState } from "react";
import { listarClientes, listarVeiculos, definirAtivo, type ClienteLinha, type VeiculoLinha } from "./actions";
import { situacaoTransmissao, ROTULO_SITUACAO, type SituacaoTransmissao } from "@/lib/veiculos-situacao";

const COR_SITUACAO: Record<SituacaoTransmissao, string> = {
  ok: "var(--verde)",
  parado: "var(--amarelo)",
  sem_sinal: "var(--vermelho)",
  nunca: "var(--text-muted)",
};

function quando(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function VeiculosPage() {
  const [clientes, setClientes] = useState<ClienteLinha[]>([]);
  const [clienteId, setClienteId] = useState<string>("");
  const [veiculos, setVeiculos] = useState<VeiculoLinha[] | null>(null);
  const [filtro, setFiltro] = useState<"ativos" | "fora">("ativos");
  const [busca, setBusca] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    listarClientes().then((cs) => {
      setClientes(cs);
      const nutry = cs.find((c) => /nutry/i.test(c.nome)) ?? cs[0];
      if (nutry) setClienteId(nutry.id);
    });
  }, []);

  const carregar = async (id: string) => {
    setVeiculos(await listarVeiculos(id));
  };
  useEffect(() => {
    if (clienteId) listarVeiculos(clienteId).then(setVeiculos);
  }, [clienteId]);

  const [agora] = useState(() => new Date());
  const comSituacao = useMemo(() => (veiculos ?? []).map((v) => ({ ...v, situacao: situacaoTransmissao(v.datagps, agora) })), [veiculos, agora]);
  const ativos = comSituacao.filter((v) => v.ativo);
  const fora = comSituacao.filter((v) => !v.ativo);
  const semSinal30 = ativos.filter((v) => v.situacao === "sem_sinal" || v.situacao === "nunca");
  const lista = (filtro === "ativos" ? ativos : fora).filter((v) => !busca || v.placa.toUpperCase().includes(busca.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")));

  const alterar = async (ids: string[], ativo: boolean, texto: string) => {
    setSalvando(true);
    setMsg(null);
    const r = await definirAtivo(ids, ativo);
    setSalvando(false);
    setMsg(r.ok ? `${r.alterados} ${texto}` : `Erro: ${r.erro}`);
    if (r.ok) await carregar(clienteId);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-lg font-semibold mb-1" style={{ color: "var(--text)" }}>Veículos</h1>
      <p className="text-sm mb-5" style={{ color: "var(--text-dim)" }}>
        Placas que não fazem mais parte da frota: tire da frota e elas saem do monitoramento de desvio e da contagem da Central. Nada é apagado — dá pra voltar a qualquer momento.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {clientes.map((c) => (
          <button key={c.id} onClick={() => { if (c.id !== clienteId) { setVeiculos(null); setClienteId(c.id); } }} className="px-3 py-1.5 rounded text-sm font-medium"
            style={c.id === clienteId ? { backgroundColor: "var(--accent)", color: "var(--bg)" } : { border: "1px solid var(--border)", color: "var(--text-dim)" }}>
            {c.nome}
          </button>
        ))}
      </div>

      {veiculos && (
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            { rotulo: "Na frota", valor: ativos.length },
            { rotulo: "Na frota transmitindo", valor: ativos.filter((v) => v.situacao === "ok").length },
            { rotulo: "Fora da frota", valor: fora.length },
          ].map((k) => (
            <div key={k.rotulo} className="rounded p-3" style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}>
              <div className="text-xs" style={{ color: "var(--text-dim)" }}>{k.rotulo}</div>
              <div className="text-2xl font-semibold tabular-nums" style={{ color: "var(--text)" }}>{k.valor}</div>
            </div>
          ))}
        </div>
      )}

      {semSinal30.length > 0 && filtro === "ativos" && (
        <div className="rounded p-3 mb-4 text-sm flex flex-wrap items-center justify-between gap-3" style={{ border: "1px solid var(--amarelo)", color: "var(--text)" }}>
          <span>{semSinal30.length} placa(s) na frota sem transmitir há mais de 30 dias (ou nunca). Confira se ainda fazem parte.</span>
          <button disabled={salvando} className="px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50" style={{ border: "1px solid var(--border)", color: "var(--text)" }}
            onClick={() => { if (window.confirm(`Tirar da frota as ${semSinal30.length} placas sem transmitir há +30 dias?\n\n${semSinal30.map((v) => v.placa).join(", ")}`)) alterar(semSinal30.map((v) => v.id), false, "placa(s) tirada(s) da frota."); }}>
            Tirar essas da frota
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setFiltro("ativos")} className="px-3 py-1.5 rounded text-sm" style={filtro === "ativos" ? { backgroundColor: "var(--card-hover)", color: "var(--text)" } : { color: "var(--text-dim)" }}>Na frota ({ativos.length})</button>
        <button onClick={() => setFiltro("fora")} className="px-3 py-1.5 rounded text-sm" style={filtro === "fora" ? { backgroundColor: "var(--card-hover)", color: "var(--text)" } : { color: "var(--text-dim)" }}>Fora da frota ({fora.length})</button>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar placa" className="ml-auto px-3 py-1.5 rounded text-sm"
          style={{ border: "1px solid var(--border)", backgroundColor: "var(--bg)", color: "var(--text)" }} />
        {msg && <span className="w-full text-sm" style={{ color: msg.startsWith("Erro") ? "var(--vermelho)" : "var(--verde)" }}>{msg}</span>}
      </div>

      {veiculos == null ? (
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Carregando…</p>
      ) : lista.length === 0 ? (
        <p className="text-sm py-6 text-center" style={{ color: "var(--text-dim)" }}>{filtro === "fora" ? "Nenhuma placa fora da frota." : "Nenhuma placa."}</p>
      ) : (
        <div className="rounded" style={{ border: "1px solid var(--border)" }}>
          {lista.map((v) => (
            <div key={v.id} className="flex items-center gap-3 px-3 py-2 text-sm" style={{ borderTop: "1px solid var(--border-subtle)" }}>
              <span className="font-semibold w-24" style={{ color: "var(--text)" }}>{v.placa}</span>
              <span className="w-28 truncate" style={{ color: "var(--text-dim)" }}>{v.grupo ?? "—"}</span>
              <span className="flex items-center gap-1.5 flex-1" style={{ color: "var(--text-dim)" }}>
                <span className="inline-block size-2 rounded-full" style={{ backgroundColor: COR_SITUACAO[v.situacao] }} />
                {ROTULO_SITUACAO[v.situacao]}
                <span style={{ color: "var(--text-muted)" }}>· última posição {quando(v.datagps)}</span>
              </span>
              <button disabled={salvando} onClick={() => alterar([v.id], !v.ativo, v.ativo ? "placa tirada da frota." : "placa de volta na frota.")}
                className="px-3 py-1 rounded text-xs font-medium disabled:opacity-50" style={{ border: "1px solid var(--border)", color: "var(--text)" }}>
                {v.ativo ? "Tirar da frota" : "Voltar pra frota"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
