"use client";

import { useState, useEffect, useRef } from "react";

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
  placasNaoEncontradas?: string[];
  modoTeste?: boolean;
};

type StatusGeocode = {
  ok: boolean;
  total: number;
  geocodadosOk: number;
  falhou: number;
  pendente: number;
  pontos: PontoProcessado[];
};

// Achado real 01/08: separado do resultado do upload de propósito -- o
// botão de reset precisa ficar disponível mesmo se a pessoa saiu da tela
// e voltou (resultado é estado local, some ao recarregar a página).
function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

export default function RomaneioPage() {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [modoTeste, setModoTeste] = useState(false);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoUpload | null>(null);

  const [status, setStatus] = useState<StatusGeocode | null>(null);
  const [revertendo, setRevertendo] = useState(false);
  const [mensagemReverter, setMensagemReverter] = useState<string | null>(null);
  // null ate montar no cliente -- evita mismatch de hidratacao (SSR roda
  // em outro instante que o hydrate no navegador, podem cair em dias
  // diferentes bem na virada da meia-noite).
  const [hoje, setHoje] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setHoje(hojeSP());
  }, []);

  const pararPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const buscarStatus = async (romaneioData: string) => {
    try {
      const res = await fetch(`/api/romaneio/status?data=${encodeURIComponent(romaneioData)}`);
      const data = (await res.json()) as StatusGeocode;
      if (!data.ok) return;
      setStatus(data);
      if (data.pendente === 0) pararPolling();
    } catch {
      // Falha pontual de poll -- tenta de novo no proximo tick, nao para o polling.
    }
  };

  const processar = async () => {
    if (!arquivo) return;
    setProcessando(true);
    setResultado(null);
    setStatus(null);
    pararPolling();
    try {
      const formData = new FormData();
      formData.append("arquivo", arquivo);
      formData.append("modoTeste", modoTeste ? "true" : "false");
      const res = await fetch("/api/romaneio/upload", { method: "POST", body: formData });
      const data = (await res.json()) as ResultadoUpload;
      setResultado(data);
      if (data.ok && data.romaneioData) {
        await buscarStatus(data.romaneioData);
        pollRef.current = setInterval(() => buscarStatus(data.romaneioData!), 4000);
      }
    } catch (e) {
      setResultado({ ok: false, erro: `Falha de rede: ${String(e)}` });
    } finally {
      setProcessando(false);
    }
  };

  const reverter = async (romaneioData: string) => {
    if (!confirm(`Resetar o romaneio de ${romaneioData}? Isso apaga todos os pontos extraídos desse dia -- não afeta o motor (ele já não usa mais o romaneio, só a Unitrac). Você vai poder subir o arquivo de novo do zero.`)) {
      return;
    }
    setRevertendo(true);
    setMensagemReverter(null);
    try {
      const res = await fetch("/api/romaneio/reverter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ romaneioData }),
      });
      const data = (await res.json()) as { ok: boolean; erro?: string; linhasRemovidas?: number };
      if (data.ok) {
        pararPolling();
        setResultado(null);
        setStatus(null);
        setMensagemReverter(`Romaneio de ${romaneioData} revertido -- ${data.linhasRemovidas} linhas removidas.`);
      } else {
        setMensagemReverter(data.erro ?? "Falha ao reverter.");
      }
    } catch (e) {
      setMensagemReverter(`Falha de rede: ${String(e)}`);
    } finally {
      setRevertendo(false);
    }
  };

  useEffect(() => () => pararPolling(), []);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold mb-4" style={{ color: "var(--text)" }}>
        Romaneio de entrega
      </h1>
      <p className="text-sm mb-4" style={{ color: "var(--text-dim)" }}>
        Sobe o romaneio do dia (PDF, Excel ou CSV) — os pontos de entrega (endereço,
        coordenada) de cada veículo passam a vir daqui em vez da Unitrac. O arquivo
        não fica salvo, só os pontos extraídos.
      </p>

      <input
        type="file"
        accept=".pdf,.xlsx,.xls,.csv,application/pdf"
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

      {mensagemReverter && (
        <p className="mt-3 text-sm" style={{ color: "var(--text)" }}>{mensagemReverter}</p>
      )}

      {resultado && (
        <div
          className="mt-6 p-4 rounded text-sm"
          style={{ border: "1px solid var(--border)", color: "var(--text)" }}
        >
          {resultado.ok ? (
            <>
              <p className="font-medium mb-2 flex items-center gap-3">
                <span>
                  Romaneio de {resultado.romaneioData} — {resultado.totalLinhas} linhas recebidas.
                </span>
                {resultado.modoTeste && (
                  <span className="ml-2" style={{ color: "var(--accent)" }}>
                    (MODO TESTE — não afeta a detecção)
                  </span>
                )}
              </p>
              {resultado.placasNaoEncontradas && resultado.placasNaoEncontradas.length > 0 && (
                <p className="mb-4" style={{ color: "var(--danger, #e55)" }}>
                  Placas não encontradas no cadastro: {resultado.placasNaoEncontradas.join(", ")}
                </p>
              )}
              {status && status.pendente > 0 && (
                <p className="mb-4" style={{ color: "var(--text-dim)" }}>
                  Geocodificando em segundo plano: {status.geocodadosOk + status.falhou} de {status.total} processadas
                  ({status.pendente} restantes)...
                </p>
              )}
              {status && status.pendente === 0 && (
                <ul className="space-y-1 mb-4" style={{ color: "var(--text-dim)" }}>
                  <li>{status.total} linhas no total</li>
                  <li>{status.geocodadosOk} geocodificadas com sucesso</li>
                  <li>{status.falhou} sem coordenada (endereço não geocodificou — não entram na lista de pendentes)</li>
                </ul>
              )}
              {status && status.pendente === 0 && status.pontos.length > 0 && (
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
                      {status.pontos.map((p, i) => (
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

      <div className="mt-10 pt-6" style={{ borderTop: "1px solid var(--border)" }}>
        <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--text)" }}>
          Configurações
        </h2>
        <p className="text-sm mb-3" style={{ color: "var(--text-dim)" }}>
          Apaga os pontos do romaneio de hoje{hoje ? ` (${hoje})` : ""} e deixa pronto pra subir o arquivo de novo do zero.
        </p>
        <button
          onClick={() => reverter(hoje ?? hojeSP())}
          disabled={revertendo || !hoje}
          className="px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
          style={{ border: "1px solid var(--danger, #e55)", color: "var(--danger, #e55)" }}
        >
          {revertendo ? "Resetando..." : "Resetar romaneio de hoje"}
        </button>
      </div>
    </div>
  );
}
