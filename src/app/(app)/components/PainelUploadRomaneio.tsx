"use client";

import { useState } from "react";
import type { OrigemRomaneio } from "@/lib/romaneio-origem";

export type ResultadoUploadRomaneio = {
  ok: boolean;
  erro?: string;
  romaneioData?: string;
  totalLinhas?: number;
  placasNaoEncontradas?: string[];
  modoTeste?: boolean;
  origem?: OrigemRomaneio;
};

// Um painel de upload independente (arquivo/processando/resultado proprios)
// -- quem usa fica so' com o estado compartilhado (modoTeste, status
// combinado do dia, reverter). Dois arquivos no mesmo dia (romaneio
// principal + escala do Pao) se SOMAM em romaneio_pontos (mesmo
// romaneio_data + modo_teste, ver /api/romaneio/upload -- insert puro, nunca
// substitui) -- por isso os dois painéis chamam o mesmo endpoint generico.
// O que os diferencia no banco e' `origem` (migration 059), que vem numa
// PROP PROPRIA e nunca do `titulo`: titulo e' texto de UI e pode mudar a
// qualquer momento, chave de dado nao pode depender disso.
//
// Extraido de romaneio/page.tsx em 23/08 pra ser reusado pela tela de envio
// da /central-romaneio (gate do dia) -- os defaults abaixo mantem a
// aparencia da /romaneio exatamente como era.
export default function PainelUploadRomaneio({
  titulo,
  origem,
  modoTeste,
  onSucesso,
  descricao,
  enfase = "padrao",
}: {
  titulo: string;
  origem: OrigemRomaneio;
  modoTeste: boolean;
  onSucesso: (romaneioData: string, origem: OrigemRomaneio) => void;
  descricao?: string;
  enfase?: "padrao" | "secundario";
}) {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoUploadRomaneio | null>(null);

  const processar = async () => {
    if (!arquivo) return;
    setProcessando(true);
    setResultado(null);
    try {
      const formData = new FormData();
      formData.append("arquivo", arquivo);
      formData.append("modoTeste", modoTeste ? "true" : "false");
      formData.append("origem", origem);
      const res = await fetch("/api/romaneio/upload", { method: "POST", body: formData });
      const data = (await res.json()) as ResultadoUploadRomaneio;
      setResultado(data);
      if (data.ok && data.romaneioData) {
        setArquivo(null);
        onSucesso(data.romaneioData, origem);
      }
    } catch (e) {
      setResultado({ ok: false, erro: `Falha de rede: ${String(e)}` });
    } finally {
      setProcessando(false);
    }
  };

  const secundario = enfase === "secundario";

  return (
    <div className="mb-6 p-4 rounded" style={{ border: "1px solid var(--border)" }}>
      <h2
        className="text-sm font-semibold"
        style={{ color: secundario ? "var(--text-muted)" : "var(--text)" }}
      >
        {titulo}
      </h2>
      {descricao && (
        <p className="text-xs mt-1" style={{ color: "var(--text-dim)" }}>
          {descricao}
        </p>
      )}
      <input
        type="file"
        accept=".pdf,.xlsx,.xls,.csv,application/pdf"
        onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
        className="block mt-2 mb-3 text-sm"
        style={{ color: "var(--text)" }}
        aria-label={`Arquivo — ${titulo}`}
      />
      <button
        onClick={processar}
        disabled={!arquivo || processando}
        className="px-4 py-2 rounded text-sm font-medium disabled:opacity-50"
        style={
          secundario
            ? { border: "1px solid var(--border)", color: "var(--accent)" }
            : { backgroundColor: "var(--accent)", color: "var(--bg)" }
        }
      >
        {processando ? "Processando..." : `Processar ${titulo.toLowerCase()}`}
      </button>

      {resultado && (
        <div
          className="mt-3 text-sm animate-fade-in"
          style={{ color: resultado.ok ? "var(--text)" : "var(--vermelho)" }}
          role="status"
        >
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
