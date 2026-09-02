"use client";

import { useState } from "react";
import type { OrigemRomaneio } from "@/lib/romaneio-origem";

export type ResultadoUploadRomaneio = {
  ok: boolean;
  erro?: string;
  romaneioData?: string;
  totalLinhas?: number;
  linhasInseridas?: number;
  linhasDuplicadas?: number;
  placasNaoEncontradas?: string[];
  modoTeste?: boolean;
  origem?: OrigemRomaneio;
};

const ACCEPT = ".pdf,.xlsx,.xls,.csv,application/pdf";
const EXTENSOES = [".pdf", ".xlsx", ".xls", ".csv"];

// `accept` do <input> só filtra o seletor do sistema -- arquivo ARRASTADO
// passa direto. Por isso a checagem existe só no drop: no caminho do
// seletor o browser já garantiu a extensão, e validar de novo mudaria o
// comportamento da /romaneio sem motivo.
function extensaoAceita(nome: string): boolean {
  const n = nome.toLowerCase();
  return EXTENSOES.some((ext) => n.endsWith(ext));
}

function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
// da /central-romaneio (gate do dia).
//
// `variante` existe pra NAO bifurcar o componente (passada de design 23/08):
//   - "classico" (default) = markup identico ao que a /romaneio ja tinha
//     aprovado -- input nativo e botao com disabled:opacity-50. Nada muda la.
//   - "zona" = area de envio de verdade (alvo grande, clicavel, aceita
//     arrastar-e-soltar, mostra o nome do arquivo) + estados de botao
//     explicitos. Usada pelo gate, cuja unica funcao na tela e' receber um
//     arquivo -- input nativo cru ali era o controle mais feio do browser
//     ocupando o lugar da acao principal.
// `enfase` continua separando obrigatorio (padrao) de opcional (secundario);
// em "zona" ela vale tambem como escala: o secundario e' menor e sem
// preenchimento de card, pra recuar de verdade e nao so' no texto.
export default function PainelUploadRomaneio({
  titulo,
  origem,
  modoTeste,
  onSucesso,
  descricao,
  etiqueta,
  enfase = "padrao",
  variante = "classico",
}: {
  titulo: string;
  origem: OrigemRomaneio;
  modoTeste: boolean;
  onSucesso: (romaneioData: string, origem: OrigemRomaneio) => void;
  descricao?: string;
  etiqueta?: string;
  enfase?: "padrao" | "secundario";
  variante?: "classico" | "zona";
}) {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoUploadRomaneio | null>(null);
  const [arrastando, setArrastando] = useState(false);
  // Remonta o <input>: sem isso, escolher -> remover -> escolher O MESMO
  // arquivo nao dispara onChange (o input ainda guarda o valor antigo).
  const [seqInput, setSeqInput] = useState(0);

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
        setSeqInput((n) => n + 1);
        onSucesso(data.romaneioData, origem);
      }
    } catch (e) {
      setResultado({ ok: false, erro: `Falha de rede: ${String(e)}` });
    } finally {
      setProcessando(false);
    }
  };

  const secundario = enfase === "secundario";

  const blocoResultado = resultado && (
    <div
      className="mt-3 text-sm animate-fade-in"
      style={{ color: resultado.ok ? "var(--text)" : "var(--vermelho)" }}
      role="status"
    >
      {resultado.ok
        ? `${resultado.totalLinhas} linhas recebidas de ${resultado.romaneioData}${
            // Achado real 29/08 (revisao independente): reenviar um arquivo
            // ja upado (ex: apos corrigir e reenviar sem reverter antes)
            // mostrava a MESMA mensagem de sucesso de um upload real, com 0
            // linhas gravadas -- "duplicacao silenciosa" virava "no-op
            // silencioso". Os campos ja existiam na API, so' nao apareciam.
            resultado.linhasDuplicadas
              ? ` (${resultado.linhasInseridas ?? 0} novas, ${resultado.linhasDuplicadas} já existiam -- reenvio detectado)`
              : ""
          }${
            resultado.placasNaoEncontradas && resultado.placasNaoEncontradas.length > 0
              ? ` -- placas não encontradas: ${resultado.placasNaoEncontradas.join(", ")}`
              : ""
          }`
        : resultado.erro}
    </div>
  );

  // ── Variante clássica: a /romaneio, exatamente como já estava aprovada ──
  if (variante === "classico") {
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
          accept={ACCEPT}
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
        {blocoResultado}
      </div>
    );
  }

  // ── Variante "zona": área de envio de verdade ──────────────────────────
  const armado = !!arquivo && !processando;

  const aoSoltar = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setArrastando(false);
    // Achado real 01/09 (varredura): soltar um 2o arquivo enquanto o 1o
    // ainda esta processando sobrescrevia `arquivo` em silencio -- quando a
    // resposta do 1o chegava, o sucesso zerava `arquivo` (linha ~99), e a
    // selecao do 2o sumia sem nenhum aviso. Ignora solturas durante
    // processamento -- o operador precisa esperar o 1o terminar antes de
    // trocar o arquivo.
    if (processando) return;
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!extensaoAceita(f.name)) {
      setArquivo(null);
      setResultado({
        ok: false,
        erro: `"${f.name}" não é um formato aceito. Use PDF, Excel (.xlsx / .xls) ou CSV.`,
      });
      return;
    }
    setResultado(null);
    setArquivo(f);
  };


  // Botao: estado explicito em vez de opacity-50 sobre o azul. No tema claro
  // o accent a 50% virava um cinza-azulado que lia como desabilitado ate'
  // quando estava ativo -- e essa e' a acao primaria da tela. Desarmado usa
  // --card-hover + --text-muted: continua legivel (o operador precisa saber
  // que o botao existe e o que ele faz) sem competir com o accent.
  const estiloBotao: React.CSSProperties = secundario
    ? armado
      ? { border: "1px solid var(--accent)", color: "var(--accent)", backgroundColor: "transparent" }
      : { border: "1px solid var(--border)", color: "var(--text-dim)", backgroundColor: "transparent" }
    : armado || processando
      ? { backgroundColor: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)" }
      : { backgroundColor: "var(--card-hover)", color: "var(--text-muted)", border: "1px solid var(--border)" };

  const iconeZona = (px: number) =>
    arquivo ? (
      <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ) : (
      <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    );

  // O <input type="file"> continua existindo (sr-only) -- some da tela, nunca
  // da arvore de acessibilidade: e' ele que da foco por teclado, Enter/Espaco
  // pra abrir o seletor e o nome do campo pro leitor de tela. O anel de foco
  // visivel vai no bloco irmao via peer-focus-visible.
  const zonaArquivo = (conteudo: React.ReactNode, classesInternas: string) => (
    <label
      className="block rounded-lg cursor-pointer transition-colors"
      onDragEnter={(e) => { e.preventDefault(); setArrastando(true); }}
      onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
      onDragLeave={(e) => { e.preventDefault(); setArrastando(false); }}
      onDrop={aoSoltar}
      style={{
        border: `1px ${arquivo ? "solid" : "dashed"} ${
          arrastando || arquivo ? "var(--accent)" : "var(--border)"
        }`,
        backgroundColor: arrastando
          ? "var(--accent-dim)"
          : secundario
            ? "var(--card)"
            : "var(--bg)",
      }}
    >
      <input
        key={seqInput}
        type="file"
        accept={ACCEPT}
        onChange={(e) => {
          // Mesma guarda de `aoSoltar` acima -- trocar pelo seletor nativo
          // durante o processamento tem o mesmo risco de sobrescrever a
          // selecao em silencio.
          if (processando) return;
          setResultado(null);
          setArquivo(e.target.files?.[0] ?? null);
        }}
        className="sr-only peer"
        aria-label={`Arquivo — ${titulo}`}
      />
      <div
        className={`rounded-lg flex items-center gap-3 peer-focus-visible:ring-2 peer-focus-visible:ring-[color:var(--accent)] ${classesInternas}`}
      >
        {conteudo}
      </div>
    </label>
  );

  const botaoProcessar = (
    <button
      onClick={processar}
      disabled={!arquivo || processando}
      className={`rounded-md font-semibold transition-colors flex-shrink-0 ${
        secundario ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"
      }`}
      style={estiloBotao}
    >
      {processando ? "Processando..." : `Processar ${titulo.toLowerCase()}`}
    </button>
  );

  const botaoRemover = armado && (
    <button
      type="button"
      onClick={() => {
        setArquivo(null);
        setResultado(null);
        setSeqInput((n) => n + 1);
      }}
      className="text-xs underline underline-offset-2 rounded flex-shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent)]"
      style={{ color: "var(--text-dim)" }}
    >
      Remover
    </button>
  );

  const cabecalho = (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <h2
          className={secundario ? "text-xs font-semibold" : "text-sm font-semibold"}
          style={{ color: secundario ? "var(--text-muted)" : "var(--text)" }}
        >
          {titulo}
        </h2>
        {etiqueta && (
          <span
            className="tag"
            style={
              secundario
                ? { color: "var(--text-dim)", border: "1px solid var(--border)", fontSize: "10px" }
                : { color: "var(--accent)", backgroundColor: "var(--accent-dim)", fontSize: "10px" }
            }
          >
            {etiqueta}
          </span>
        )}
      </div>
      {descricao && (
        <p className="text-xs mt-1" style={{ color: "var(--text-dim)" }}>
          {descricao}
        </p>
      )}
    </>
  );

  // ── Secundário: faixa contida, um degrau abaixo em tudo ────────────────
  // Altura ~1/3 do cartão obrigatório, sem preenchimento de card, zona e
  // botão na mesma linha. A diferença tem que ser visível antes de ler o
  // texto -- é isso que diz quem destrava a tela.
  if (secundario) {
    return (
      <section className="rounded-lg px-4 py-3" style={{ border: "1px solid var(--border-subtle)" }}>
        {cabecalho}
        <div className="flex items-center gap-2 mt-2.5">
          <div className="flex-1 min-w-0">
            {zonaArquivo(
              <>
                <span
                  className="flex items-center justify-center rounded flex-shrink-0"
                  style={{ width: 22, height: 22, backgroundColor: "var(--accent-dim)", color: "var(--accent)" }}
                  aria-hidden="true"
                >
                  {iconeZona(12)}
                </span>
                <span className="text-xs truncate" style={{ color: arquivo ? "var(--text)" : "var(--text-muted)" }}>
                  {arquivo
                    ? `${arquivo.name} · ${tamanhoLegivel(arquivo.size)}`
                    : "Arraste o arquivo aqui ou clique para escolher"}
                </span>
              </>,
              "px-2.5 py-1.5",
            )}
          </div>
          {botaoProcessar}
        </div>
        {botaoRemover && <div className="mt-2">{botaoRemover}</div>}
        {blocoResultado}
      </section>
    );
  }

  // ── Obrigatório: cartão cheio, alvo grande, botão primário ─────────────
  return (
    <section className="rounded-xl p-6" style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}>
      {cabecalho}
      <div className="mt-3.5">
        {zonaArquivo(
          <>
            <span
              className="flex items-center justify-center rounded-md flex-shrink-0"
              style={{ width: 38, height: 38, backgroundColor: "var(--accent-dim)", color: "var(--accent)" }}
              aria-hidden="true"
            >
              {iconeZona(18)}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium truncate" style={{ color: "var(--text)" }}>
                {arquivo ? arquivo.name : "Arraste o arquivo aqui ou clique para escolher"}
              </span>
              <span className="block text-xs mt-0.5" style={{ color: "var(--text-dim)" }}>
                {arquivo
                  ? `${tamanhoLegivel(arquivo.size)} · pronto pra processar`
                  : "PDF, Excel (.xlsx / .xls) ou CSV"}
              </span>
            </span>
          </>,
          "px-4 py-6",
        )}
      </div>
      <div className="flex items-center gap-3 mt-4">
        {botaoProcessar}
        {botaoRemover}
      </div>
      {blocoResultado}
    </section>
  );
}
