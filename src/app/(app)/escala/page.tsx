"use client";

import { useState, useEffect } from "react";
import { listarApelidos, adicionarApelido, removerApelido, type Apelido } from "./actions";

type ResultadoUpload = {
  ok: boolean;
  erro?: string;
  escalaData?: string;
  totalLinhas?: number;
  placasNaoEncontradas?: string[];
  destinosNaoResolvidos?: string[];
};

export default function EscalaPage() {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoUpload | null>(null);

  const [apelidos, setApelidos] = useState<Apelido[]>([]);
  const [novoApelido, setNovoApelido] = useState("");
  const [novaCidade, setNovaCidade] = useState("");
  const [salvandoApelido, setSalvandoApelido] = useState(false);
  const [erroApelido, setErroApelido] = useState<string | null>(null);
  const [mensagemApelido, setMensagemApelido] = useState<string | null>(null);

  const carregarApelidos = async () => {
    setApelidos(await listarApelidos());
  };

  useEffect(() => {
    carregarApelidos();
  }, []);

  const processar = async () => {
    if (!arquivo) return;
    setProcessando(true);
    setResultado(null);
    try {
      const formData = new FormData();
      formData.append("arquivo", arquivo);
      const res = await fetch("/api/escala/upload", { method: "POST", body: formData });
      const data = (await res.json()) as ResultadoUpload;
      setResultado(data);
    } catch (e) {
      setResultado({ ok: false, erro: `Falha de rede: ${String(e)}` });
    } finally {
      setProcessando(false);
    }
  };

  const salvarApelido = async () => {
    setSalvandoApelido(true);
    setErroApelido(null);
    setMensagemApelido(null);
    try {
      const r = await adicionarApelido(novoApelido, novaCidade);
      if (!r.ok) {
        setErroApelido(r.erro ?? "Falha ao salvar.");
        return;
      }
      if (r.reResolvidas && r.reResolvidas > 0) {
        setMensagemApelido(`${r.reResolvidas} linha(s) da escala ja gravadas foram atualizadas com esse destino.`);
      }
      setNovoApelido("");
      setNovaCidade("");
      await carregarApelidos();
    } finally {
      setSalvandoApelido(false);
    }
  };

  const excluirApelido = async (id: string) => {
    await removerApelido(id);
    await carregarApelidos();
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold mb-4" style={{ color: "var(--text)" }}>
        Escala de rota
      </h1>
      <p className="text-sm mb-4" style={{ color: "var(--text-dim)" }}>
        Sobe a escala do dia (PDF) — veículos que aparecem aqui ganham um
        destino aproximado (raio de cidade) na detecção de desvio, mesmo
        sem marcação de romaneio.
      </p>

      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
        className="block mb-3 text-sm"
        style={{ color: "var(--text)" }}
      />

      <button
        onClick={processar}
        disabled={!arquivo || processando}
        className="px-4 py-2 rounded text-sm font-medium disabled:opacity-50"
        style={{ backgroundColor: "var(--accent)", color: "var(--bg)" }}
      >
        {processando ? "Processando..." : "Processar escala"}
      </button>

      {resultado && (
        <div
          className="mt-6 p-4 rounded text-sm"
          style={{ border: "1px solid var(--border)", color: "var(--text)" }}
        >
          {resultado.ok ? (
            <>
              <p className="font-medium mb-2">
                Escala de {resultado.escalaData} — {resultado.totalLinhas} linhas recebidas.
              </p>
              {resultado.placasNaoEncontradas && resultado.placasNaoEncontradas.length > 0 && (
                <p className="mb-2" style={{ color: "var(--danger, #e55)" }}>
                  Placas não encontradas no cadastro: {resultado.placasNaoEncontradas.join(", ")}
                </p>
              )}
              {resultado.destinosNaoResolvidos && resultado.destinosNaoResolvidos.length > 0 && (
                <p style={{ color: "var(--danger, #e55)" }}>
                  Destinos não resolvidos (cadastra um apelido abaixo pra eles): {resultado.destinosNaoResolvidos.join(", ")}
                </p>
              )}
            </>
          ) : (
            <p style={{ color: "var(--danger, #e55)" }}>{resultado.erro}</p>
          )}
        </div>
      )}

      <div className="mt-10 pt-6" style={{ borderTop: "1px solid var(--border)" }}>
        <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--text)" }}>
          Apelidos de destino
        </h2>
        <p className="text-sm mb-3" style={{ color: "var(--text-dim)" }}>
          Pra destinos da escala que não são nome de cidade (ex: nome de
          rota/cliente fixo) — mapeia pra qual cidade/região aquele nome
          corresponde.
        </p>

        <div className="flex gap-2 mb-3">
          <input
            type="text"
            placeholder="Ex: JEITO CASEIRO"
            value={novoApelido}
            onChange={(e) => setNovoApelido(e.target.value)}
            className="px-2 py-1.5 rounded text-sm flex-1"
            style={{ border: "1px solid var(--border)", color: "var(--text)", background: "transparent" }}
          />
          <input
            type="text"
            placeholder="Ex: Volta Redonda"
            value={novaCidade}
            onChange={(e) => setNovaCidade(e.target.value)}
            className="px-2 py-1.5 rounded text-sm flex-1"
            style={{ border: "1px solid var(--border)", color: "var(--text)", background: "transparent" }}
          />
          <button
            onClick={salvarApelido}
            disabled={!novoApelido || !novaCidade || salvandoApelido}
            className="px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: "var(--accent)", color: "var(--bg)" }}
          >
            Adicionar
          </button>
        </div>
        {erroApelido && <p className="text-sm mb-3" style={{ color: "var(--danger, #e55)" }}>{erroApelido}</p>}
        {mensagemApelido && <p className="text-sm mb-3" style={{ color: "var(--text-dim)" }}>{mensagemApelido}</p>}

        <ul className="space-y-1">
          {apelidos.map((a) => (
            <li key={a.id} className="flex items-center justify-between text-sm py-1" style={{ borderTop: "1px solid var(--border)" }}>
              <span style={{ color: "var(--text)" }}>{a.apelidoTexto} → {a.cidadeDestino}</span>
              <button
                onClick={() => excluirApelido(a.id)}
                className="text-xs"
                style={{ color: "var(--danger, #e55)" }}
              >
                remover
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
