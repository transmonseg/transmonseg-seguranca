"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PainelUploadRomaneio from "../components/PainelUploadRomaneio";

// Tela de tarefa única: o romaneio de HOJE não foi enviado, então a Central
// Romaneio não tem o que mostrar no mapa. Pedido do usuário 23/08 -- "se não
// tiver com romaneio e escala do pão do dia ele pede pra colocar, e eu
// coloco, e o mapa aparece". O upload acontece aqui mesmo: mandar o operador
// pra outra página no meio do turno é o que ele não quer.
//
// Só o romaneio é obrigatório (decisão confirmada). A escala do Pão fica
// como complemento explicitamente secundário -- nunca trava esta tela.

type StatusGeocode = {
  ok: boolean;
  total: number;
  geocodadosOk: number;
  falhou: number;
  pendente: number;
};

export default function GateRomaneio({
  hoje,
  linhasHojeSemVeiculo,
}: {
  hoje: string;
  // > 0 significa: chegou arquivo hoje, mas nenhuma linha casou com veículo
  // do cadastro. O mapa continua fechado (o motor precisa de veiculo_id) e
  // recarregar não resolve -- então a tela precisa DIZER isso, em vez de
  // voltar pro mesmo pedido de arquivo sem explicação.
  linhasHojeSemVeiculo: number;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<StatusGeocode | null>(null);
  const [liberando, setLiberando] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pararPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Mesma mecânica de poll da /romaneio (/api/romaneio/status a cada 4s) --
  // reusada de propósito pra não existirem duas ideias diferentes de
  // "quando o romaneio fica pronto".
  const buscarStatus = useCallback(async (dia: string) => {
    try {
      const res = await fetch(`/api/romaneio/status?data=${encodeURIComponent(dia)}&modoTeste=false`);
      const data = (await res.json()) as StatusGeocode;
      if (!data.ok) return;
      setStatus(data);
      if (data.total > 0 && data.pendente === 0) {
        pararPolling();
        // Sai do gate sozinho: o gate é decidido no servidor, então basta
        // re-renderizar o server component. router.refresh() não perde o
        // estado do resto da árvore nem a posição de scroll.
        setLiberando(true);
        router.refresh();
      }
    } catch {
      // Falha pontual de poll -- tenta de novo no próximo tick.
    }
  }, [router]);

  const aoSucessoUpload = (romaneioData: string) => {
    pararPolling();
    setStatus(null);
    buscarStatus(romaneioData);
    pollRef.current = setInterval(() => buscarStatus(romaneioData), 4000);
  };

  useEffect(() => () => pararPolling(), []);

  const processadas = status ? status.geocodadosOk + status.falhou : 0;
  const pct = status && status.total > 0 ? Math.round((processadas / status.total) * 100) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-xl mx-auto px-6 py-12 animate-fade-in">
        <p
          className="text-xs font-semibold mb-2"
          style={{ color: "var(--text-dim)", letterSpacing: "0.08em" }}
        >
          CENTRAL ROMANEIO — {hoje}
        </p>
        <h1 className="text-lg font-semibold mb-2" style={{ color: "var(--text)" }}>
          Falta o romaneio de hoje
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
          O mapa desta tela é montado a partir dos pontos de entrega do romaneio do dia.
          Sobe o arquivo aqui (PDF, Excel ou CSV) e o mapa abre sozinho assim que os
          pontos ficarem prontos.
        </p>

        {linhasHojeSemVeiculo > 0 && (
          <div
            className="mb-6 px-3 py-2 rounded text-xs"
            style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)", color: "var(--text-muted)" }}
          >
            {linhasHojeSemVeiculo} {linhasHojeSemVeiculo === 1 ? "linha já foi recebida" : "linhas já foram recebidas"} hoje,
            mas nenhuma placa bateu com um veículo do cadastro — sem veículo o mapa não tem o que
            desenhar. Confira se é o arquivo certo, ou revise as placas em{" "}
            <Link href="/romaneio" className="underline" style={{ color: "var(--accent)" }}>
              Configurar Romaneio
            </Link>.
          </div>
        )}

        <PainelUploadRomaneio
          titulo="Romaneio"
          origem="romaneio"
          modoTeste={false}
          onSucesso={aoSucessoUpload}
          descricao="Obrigatório — é o que libera o mapa."
        />

        <PainelUploadRomaneio
          titulo="Escala do Pão"
          origem="escala_pao"
          modoTeste={false}
          onSucesso={aoSucessoUpload}
          descricao="Opcional — soma pontos ao mesmo dia, não é necessária pra abrir o mapa."
          enfase="secundario"
        />

        {status && (
          <div
            className="mt-2 p-4 rounded animate-fade-in"
            style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}
            aria-live="polite"
          >
            <p className="text-sm font-medium mb-2" style={{ color: "var(--text)" }}>
              {liberando
                ? "Pontos prontos — abrindo o mapa..."
                : `Geocodificando os pontos: ${processadas} de ${status.total}`}
            </p>
            <div className="h-1 rounded overflow-hidden" style={{ backgroundColor: "var(--accent-dim)" }}>
              <div
                className="h-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: "var(--accent)" }}
              />
            </div>
            {!liberando && status.pendente > 0 && (
              <p className="text-xs mt-2" style={{ color: "var(--text-dim)" }}>
                {status.pendente} {status.pendente === 1 ? "restante" : "restantes"} — pode deixar a tela aberta,
                ela abre o mapa sozinha.
              </p>
            )}
          </div>
        )}

        <p className="text-xs mt-8" style={{ color: "var(--text-dim)" }}>
          Já subiu e quer conferir, trocar ou apagar o arquivo do dia?{" "}
          <Link href="/romaneio" className="underline" style={{ color: "var(--accent)" }}>
            Configurar Romaneio
          </Link>.
        </p>
      </div>
    </div>
  );
}
