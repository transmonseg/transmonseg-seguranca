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

// Um painel de upload independente (arquivo/processando/resultado próprios)
// -- pai fica só com o estado compartilhado (modoTeste, status combinado do
// dia, reverter). Dois arquivos no mesmo dia (romaneio principal + escala
// do Pão, por ex.) se SOMAM em romaneio_pontos (mesmo romaneio_data +
// modo_teste, ver /api/romaneio/upload -- insert puro, nunca substitui) --
// por isso os dois painéis chamam o mesmo endpoint genérico, só a label na
// tela muda. `onSucesso` avisa o pai pra (re)iniciar o poll de status
// combinado, que já reflete os pontos dos dois painéis juntos.
function PainelUpload({
  titulo, modoTeste, onSucesso,
}: {
  titulo: string;
  modoTeste: boolean;
  onSucesso: (romaneioData: string) => void;
}) {
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
      formData.append("modoTeste", modoTeste ? "true" : "false");
      const res = await fetch("/api/romaneio/upload", { method: "POST", body: formData });
      const data = (await res.json()) as ResultadoUpload;
      setResultado(data);
      if (data.ok && data.romaneioData) {
        setArquivo(null);
        onSucesso(data.romaneioData);
      }
    } catch (e) {
      setResultado({ ok: false, erro: `Falha de rede: ${String(e)}` });
    } finally {
      setProcessando(false);
    }
  };

  return (
    <div className="mb-6 p-4 rounded" style={{ border: "1px solid var(--border)" }}>
      <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--text)" }}>
        {titulo}
      </h2>
      <input
        type="file"
        accept=".pdf,.xlsx,.xls,.csv,application/pdf"
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
        {processando ? "Processando..." : `Processar ${titulo.toLowerCase()}`}
      </button>

      {resultado && (
        <div className="mt-3 text-sm" style={{ color: resultado.ok ? "var(--text)" : "var(--danger, #e55)" }}>
          {resultado.ok
            ? `${resultado.totalLinhas} linhas recebidas de ${resultado.romaneioData}${
                resultado.placasNaoEncontradas && resultado.placasNaoEncontradas.length > 0
                  ? ` -- placas não encontradas: ${resultado.placasNaoEncontradas.join(", ")}`
                  : ""
              }`
            : resultado.erro}
        </div>
      )}
    </div>
  );
}

export default function RomaneioPage() {
  const [modoTeste, setModoTeste] = useState(false);

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

  const buscarStatus = async (romaneioData: string, modoTesteDoUpload: boolean) => {
    try {
      const res = await fetch(
        `/api/romaneio/status?data=${encodeURIComponent(romaneioData)}&modoTeste=${modoTesteDoUpload ? "true" : "false"}`
      );
      const data = (await res.json()) as StatusGeocode;
      if (!data.ok) return;
      setStatus(data);
      if (data.pendente === 0) pararPolling();
    } catch {
      // Falha pontual de poll -- tenta de novo no proximo tick, nao para o polling.
    }
  };

  // Chamado por QUALQUER painel de upload que suceder -- o status combinado
  // reflete romaneio principal + escala do Pão juntos (mesmo romaneio_data),
  // então um novo upload em qualquer painel reinicia o mesmo poll único.
  const aoSucessoUpload = (romaneioData: string) => {
    pararPolling();
    setStatus(null);
    buscarStatus(romaneioData, modoTeste);
    pollRef.current = setInterval(() => buscarStatus(romaneioData, modoTeste), 4000);
  };

  const reverter = async (romaneioData: string) => {
    const escopo = modoTeste ? "de MODO TESTE" : "real (produção)";
    if (!confirm(`Resetar o romaneio ${escopo} de ${romaneioData}? Isso apaga só os pontos ${modoTeste ? "de modo teste" : "reais"} extraídos desse dia -- o romaneio ${modoTeste ? "real" : "de modo teste"}, se existir, não é afetado. Você vai poder subir o arquivo de novo do zero.`)) {
      return;
    }
    setRevertendo(true);
    setMensagemReverter(null);
    try {
      const res = await fetch("/api/romaneio/reverter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ romaneioData, modoTeste }),
      });
      const data = (await res.json()) as { ok: boolean; erro?: string; linhasRemovidas?: number };
      if (data.ok) {
        pararPolling();
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
        não fica salvo, só os pontos extraídos. Dá pra subir o romaneio principal e a
        escala do Pão separadamente — os pontos dos dois se somam e aparecem juntos
        aqui embaixo.
      </p>

      <label className="flex items-center gap-2 mb-4 text-sm" style={{ color: "var(--text)" }}>
        <input
          type="checkbox"
          checked={modoTeste}
          onChange={(e) => setModoTeste(e.target.checked)}
        />
        Modo teste (roda um motor de desvio isolado, não afeta os alertas reais)
      </label>

      <PainelUpload titulo="Romaneio" modoTeste={modoTeste} onSucesso={aoSucessoUpload} />
      <PainelUpload titulo="Escala do Pão" modoTeste={modoTeste} onSucesso={aoSucessoUpload} />

      {mensagemReverter && (
        <p className="mt-3 text-sm" style={{ color: "var(--text)" }}>{mensagemReverter}</p>
      )}

      {status && (
        <div
          className="mt-6 p-4 rounded text-sm"
          style={{ border: "1px solid var(--border)", color: "var(--text)" }}
        >
          <p className="font-medium mb-2 flex items-center gap-3">
            <span>
              Total de hoje{hoje ? ` (${hoje})` : ""} — romaneio + escala do Pão juntos.
            </span>
            {modoTeste && (
              <span className="ml-2" style={{ color: "var(--accent)" }}>
                (MODO TESTE — alimenta só o motor de teste, não os alertas reais)
              </span>
            )}
          </p>
          {status.pendente > 0 && (
            <p className="mb-4" style={{ color: "var(--text-dim)" }}>
              Geocodificando em segundo plano: {status.geocodadosOk + status.falhou} de {status.total} processadas
              ({status.pendente} restantes)...
            </p>
          )}
          {status.pendente === 0 && (
            <ul className="space-y-1 mb-4" style={{ color: "var(--text-dim)" }}>
              <li>{status.total} linhas no total</li>
              <li>{status.geocodadosOk} geocodificadas com sucesso</li>
              <li>{status.falhou} sem coordenada (endereço não geocodificou — não entram na lista de pendentes)</li>
            </ul>
          )}
          {status.pendente === 0 && status.pontos.length > 0 && (
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
        </div>
      )}

      <div className="mt-10 pt-6" style={{ borderTop: "1px solid var(--border)" }}>
        <h2 className="text-sm font-semibold mb-2" style={{ color: "var(--text)" }}>
          Configurações
        </h2>
        <p className="text-sm mb-3" style={{ color: "var(--text-dim)" }}>
          Apaga os pontos do romaneio de hoje{hoje ? ` (${hoje})` : ""} (principal + escala do Pão) e deixa pronto pra subir os arquivos de novo do zero.
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
