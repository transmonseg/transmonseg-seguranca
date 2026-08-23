"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PainelUploadRomaneio from "../components/PainelUploadRomaneio";
import { ROTULO_ORIGEM, type OrigemRomaneio } from "@/lib/romaneio-origem";

type PontoProcessado = {
  nf: string;
  clienteNome: string;
  enderecoBruto: string;
  lat: number | null;
  lng: number | null;
  geocodeStatus: string;
  origem: OrigemRomaneio | null;
};

type StatusGeocode = {
  ok: boolean;
  total: number;
  geocodadosOk: number;
  falhou: number;
  pendente: number;
  // false enquanto a migration 059 nao estiver aplicada -- a tela esconde o
  // resumo por origem em vez de mostrar zeros que nao significam nada.
  origemDisponivel: boolean;
  porOrigem: { romaneio: number; escala_pao: number; semOrigem: number } | null;
  pontos: PontoProcessado[];
};

// Achado real 01/08: separado do resultado do upload de propósito -- o
// botão de reset precisa ficar disponível mesmo se a pessoa saiu da tela
// e voltou (resultado é estado local, some ao recarregar a página).
function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

export default function ConfigurarRomaneioPage() {
  const [modoTeste, setModoTeste] = useState(false);

  const [status, setStatus] = useState<StatusGeocode | null>(null);
  const [revertendo, setRevertendo] = useState(false);
  const [mensagemReverter, setMensagemReverter] = useState<string | null>(null);
  // null ate montar no cliente -- evita mismatch de hidratacao (SSR roda
  // em outro instante que o hydrate no navegador, podem cair em dias
  // diferentes bem na virada da meia-noite).
  const [hoje, setHoje] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pararPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const buscarStatus = useCallback(async (romaneioData: string, modoTesteDoUpload: boolean) => {
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
  }, []);

  // 23/08: o resumo do dia passou a carregar sozinho ao abrir a tela. Antes
  // ele só existia depois de um upload FEITO NESTA ABA -- quem abria a
  // "Configurar Romaneio" pra conferir o que já subiu (o caso normal agora
  // que a tela virou a de configuração) via a página vazia, mesmo com 2 mil
  // pontos no banco.
  useEffect(() => {
    const dia = hojeSP();
    setHoje(dia);
    buscarStatus(dia, modoTeste);
  }, [buscarStatus, modoTeste]);

  // Chamado por QUALQUER painel de upload que suceder -- o status combinado
  // reflete romaneio principal + escala do Pão juntos (mesmo romaneio_data),
  // então um novo upload em qualquer painel reinicia o mesmo poll único.
  const aoSucessoUpload = (romaneioData: string) => {
    pararPolling();
    setStatus(null);
    buscarStatus(romaneioData, modoTeste);
    pollRef.current = setInterval(() => buscarStatus(romaneioData, modoTeste), 4000);
  };

  const reverter = async (romaneioData: string, origem: OrigemRomaneio | null) => {
    const escopo = modoTeste ? "de MODO TESTE" : "real (produção)";
    const alvo = origem
      ? `só os pontos de ${ROTULO_ORIGEM[origem]}`
      : `os pontos ${modoTeste ? "de modo teste" : "reais"}`;
    if (!confirm(`Resetar o romaneio ${escopo} de ${romaneioData}? Isso apaga ${alvo} extraídos desse dia -- o romaneio ${modoTeste ? "real" : "de modo teste"}, se existir, não é afetado. Você vai poder subir o arquivo de novo do zero.`)) {
      return;
    }
    setRevertendo(true);
    setMensagemReverter(null);
    try {
      const res = await fetch("/api/romaneio/reverter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(origem ? { romaneioData, modoTeste, origem } : { romaneioData, modoTeste }),
      });
      const data = (await res.json()) as { ok: boolean; erro?: string; linhasRemovidas?: number };
      if (data.ok) {
        pararPolling();
        setStatus(null);
        setMensagemReverter(
          `${origem ? `${ROTULO_ORIGEM[origem]} de ${romaneioData}` : `Romaneio de ${romaneioData}`} revertido -- ${data.linhasRemovidas} linhas removidas.`
        );
        buscarStatus(romaneioData, modoTeste);
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

  const porOrigem = status?.origemDisponivel ? status.porOrigem : null;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold mb-1" style={{ color: "var(--text)" }}>
        Configurar Romaneio
      </h1>
      <p className="text-sm mb-4" style={{ color: "var(--text-dim)" }}>
        Sobe o romaneio do dia (PDF, Excel ou CSV) — os pontos de entrega (endereço,
        coordenada) de cada veículo passam a vir daqui em vez da Unitrac. O arquivo
        não fica salvo, só os pontos extraídos. Dá pra subir o romaneio principal e a
        escala do Pão separadamente — os pontos dos dois se somam e aparecem juntos
        aqui embaixo. Só o romaneio libera o mapa da Central Romaneio; a escala do
        Pão é complemento.
      </p>

      <label className="flex items-center gap-2 mb-4 text-sm" style={{ color: "var(--text)" }}>
        <input
          type="checkbox"
          checked={modoTeste}
          onChange={(e) => setModoTeste(e.target.checked)}
        />
        Modo teste (roda um motor de desvio isolado, não afeta os alertas reais)
      </label>

      <PainelUploadRomaneio titulo="Romaneio" origem="romaneio" modoTeste={modoTeste} onSucesso={aoSucessoUpload} />
      <PainelUploadRomaneio titulo="Escala do Pão" origem="escala_pao" modoTeste={modoTeste} onSucesso={aoSucessoUpload} />

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

          {/* Resumo por origem: existe desde a migration 059. Linha antiga
              (origem nula) aparece como "sem origem registrada" e entra no
              total -- nao e' contada como romaneio nem como escala. */}
          {porOrigem && (
            <div className="flex flex-wrap items-stretch gap-2 mb-4">
              {([
                { chave: "romaneio" as const, valor: porOrigem.romaneio },
                { chave: "escala_pao" as const, valor: porOrigem.escala_pao },
              ]).map(({ chave, valor }) => (
                <div
                  key={chave}
                  className="px-3 py-2 rounded flex-1 min-w-[140px]"
                  style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}
                >
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>{ROTULO_ORIGEM[chave]}</p>
                  <p className="text-sm font-semibold num-mono" style={{ color: valor > 0 ? "var(--text)" : "var(--text-dim)" }}>
                    {valor} {valor === 1 ? "ponto" : "pontos"}
                  </p>
                </div>
              ))}
              <div
                className="px-3 py-2 rounded flex-1 min-w-[140px]"
                style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}
              >
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>Total</p>
                <p className="text-sm font-semibold num-mono" style={{ color: "var(--accent)" }}>
                  {status.total} {status.total === 1 ? "ponto" : "pontos"}
                </p>
              </div>
            </div>
          )}
          {porOrigem && porOrigem.semOrigem > 0 && (
            <p className="text-xs mb-4" style={{ color: "var(--text-dim)" }}>
              {porOrigem.semOrigem} {porOrigem.semOrigem === 1 ? "ponto" : "pontos"} sem origem registrada
              (enviados antes da separação entre romaneio e escala) — entram no total.
            </p>
          )}

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
                    <th className="text-left pr-3 py-1">Origem</th>
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
                      <td className="pr-3 py-1" style={{ color: p.origem ? "var(--text)" : "var(--text-dim)" }}>
                        {p.origem ? ROTULO_ORIGEM[p.origem] : "—"}
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => reverter(hoje ?? hojeSP(), null)}
            disabled={revertendo || !hoje}
            className="px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50"
            style={{ border: "1px solid var(--vermelho)", color: "var(--vermelho)" }}
          >
            {revertendo ? "Resetando..." : "Resetar romaneio de hoje"}
          </button>

          {/* Reset por origem: só aparece quando a coluna existe E quando há
              o que apagar naquela origem. Um botão que apagaria zero linha
              (ou que quebraria por coluna inexistente) é pior que nenhum. */}
          {porOrigem && porOrigem.romaneio > 0 && (
            <button
              onClick={() => reverter(hoje ?? hojeSP(), "romaneio")}
              disabled={revertendo || !hoje}
              className="px-3 py-1.5 rounded text-sm disabled:opacity-50"
              style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}
            >
              Resetar só o romaneio ({porOrigem.romaneio})
            </button>
          )}
          {porOrigem && porOrigem.escala_pao > 0 && (
            <button
              onClick={() => reverter(hoje ?? hojeSP(), "escala_pao")}
              disabled={revertendo || !hoje}
              className="px-3 py-1.5 rounded text-sm disabled:opacity-50"
              style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}
            >
              Resetar só a escala do Pão ({porOrigem.escala_pao})
            </button>
          )}
        </div>
        {porOrigem && porOrigem.semOrigem > 0 && (
          <p className="text-xs mt-2" style={{ color: "var(--text-dim)" }}>
            Os {porOrigem.semOrigem} pontos sem origem registrada só saem pelo reset completo.
          </p>
        )}
      </div>
    </div>
  );
}
