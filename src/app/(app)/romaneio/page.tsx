"use client";

import { useState } from "react";

type PontoProcessado = {
  nf: string;
  clienteNome: string;
  enderecoBruto: string;
  lat: number | null;
  lng: number | null;
  geocodeStatus: string;
};

type ResultadoUpload = {
  ok: boolean;
  erro?: string;
  romaneioData?: string;
  totalLinhas?: number;
  geocodadosOk?: number;
  semCoordenada?: number;
  placasNaoEncontradas?: string[];
  modoTeste?: boolean;
  pontos?: PontoProcessado[];
};

export default function RomaneioPage() {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [modoTeste, setModoTeste] = useState(false);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoUpload | null>(null);

  const processar = async () => {
    if (!arquivo) return;
    setProcessando(true);
    setResultado(null);
    try {
      const formData = new FormData();
      formData.append("arquivo", arquivo);
      formData.append("modoTeste", modoTeste ? "true" : "false");
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
    <div className="p-6 max-w-3xl mx-auto">
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
        className="block mb-3 text-sm"
        style={{ color: "var(--text)" }}
      />

      <label className="flex items-center gap-2 mb-4 text-sm" style={{ color: "var(--text)" }}>
        <input
          type="checkbox"
          checked={modoTeste}
          onChange={(e) => setModoTeste(e.target.checked)}
        />
        Modo teste (não afeta o motor)
      </label>

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
                {resultado.modoTeste && (
                  <span className="ml-2" style={{ color: "var(--accent)" }}>
                    (MODO TESTE — não afeta a detecção)
                  </span>
                )}
              </p>
              <ul className="space-y-1 mb-4" style={{ color: "var(--text-dim)" }}>
                <li>{resultado.totalLinhas} linhas no total</li>
                <li>{resultado.geocodadosOk} geocodificadas com sucesso</li>
                <li>{resultado.semCoordenada} sem coordenada (endereço não geocodificou — não entram na lista de pendentes)</li>
              </ul>
              {resultado.placasNaoEncontradas && resultado.placasNaoEncontradas.length > 0 && (
                <p className="mb-4" style={{ color: "var(--danger, #e55)" }}>
                  Placas não encontradas no cadastro: {resultado.placasNaoEncontradas.join(", ")}
                </p>
              )}
              {resultado.pontos && resultado.pontos.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" style={{ color: "var(--text)" }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)" }}>
                        <th className="text-left pr-3 py-1">NF</th>
                        <th className="text-left pr-3 py-1">Cliente</th>
                        <th className="text-left pr-3 py-1">Endereço</th>
                        <th className="text-left pr-3 py-1">Coordenada</th>
                        <th className="text-left py-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resultado.pontos.map((p, i) => (
                        <tr key={`${p.nf}-${i}`} style={{ borderTop: "1px solid var(--border)" }}>
                          <td className="pr-3 py-1">{p.nf}</td>
                          <td className="pr-3 py-1">{p.clienteNome}</td>
                          <td className="pr-3 py-1">{p.enderecoBruto}</td>
                          <td className="pr-3 py-1">
                            {p.lat != null && p.lng != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "—"}
                          </td>
                          <td className="py-1">{p.geocodeStatus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
