"use client";

import { useState } from "react";

type ResultadoUpload = {
  ok: boolean;
  erro?: string;
  romaneioData?: string;
  totalLinhas?: number;
  geocodadosOk?: number;
  geocodadosFallbackUnitrac?: number;
  semCoordenada?: number;
  placasNaoEncontradas?: string[];
};

export default function RomaneioPage() {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoUpload | null>(null);

  const processar = async () => {
    if (!arquivo) return;
    setProcessando(true);
    setResultado(null);
    try {
      const formData = new FormData();
      formData.append("arquivo", arquivo);
      const res = await fetch("/api/romaneio/upload", { method: "POST", body: formData });
      const data = (await res.json()) as ResultadoUpload;
      setResultado(data);
    } catch (e) {
      setResultado({ ok: false, erro: `Falha de rede: ${String(e)}` });
    } finally {
      setProcessando(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-4" style={{ color: "var(--text)" }}>
        Romaneio de entrega
      </h1>
      <p className="text-sm mb-4" style={{ color: "var(--text-dim)" }}>
        Sobe o romaneio do dia (PDF) — os pontos de entrega (endereço, coordenada) de
        cada veículo passam a vir daqui em vez da Unitrac. O arquivo não fica salvo,
        só os pontos extraídos.
      </p>

      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
        className="block mb-4 text-sm"
        style={{ color: "var(--text)" }}
      />

      <button
        onClick={processar}
        disabled={!arquivo || processando}
        className="px-4 py-2 rounded text-sm font-medium disabled:opacity-50"
        style={{ backgroundColor: "var(--accent)", color: "var(--bg)" }}
      >
        {processando ? "Processando..." : "Processar romaneio"}
      </button>

      {resultado && (
        <div
          className="mt-6 p-4 rounded text-sm"
          style={{ border: "1px solid var(--border)", color: "var(--text)" }}
        >
          {resultado.ok ? (
            <>
              <p className="font-medium mb-2">
                Romaneio de {resultado.romaneioData} processado.
              </p>
              <ul className="space-y-1" style={{ color: "var(--text-dim)" }}>
                <li>{resultado.totalLinhas} linhas no total</li>
                <li>{resultado.geocodadosOk} geocodificadas com sucesso</li>
                <li>{resultado.geocodadosFallbackUnitrac} usando coordenada da Unitrac (endereço não geocodificou)</li>
                <li>{resultado.semCoordenada} sem coordenada nenhuma</li>
              </ul>
              {resultado.placasNaoEncontradas && resultado.placasNaoEncontradas.length > 0 && (
                <p className="mt-2" style={{ color: "var(--danger, #e55)" }}>
                  Placas não encontradas no cadastro: {resultado.placasNaoEncontradas.join(", ")}
                </p>
              )}
            </>
          ) : (
            <p style={{ color: "var(--danger, #e55)" }}>{resultado.erro}</p>
          )}
        </div>
      )}
    </div>
  );
}
