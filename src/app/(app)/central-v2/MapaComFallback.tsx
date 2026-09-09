"use client";

// Escolhe entre o mapa real (Google) e o de fallback (OSM) com base no
// estado compartilhado em mapa_provider_estado, e orquestra o retry
// automatico pra voltar ao Google. Ver spec
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md.
//
// Drop-in: mesma assinatura de Props que MapaLeafletV2 -- so' este arquivo
// precisa trocar no import dynamic() de MonitorV2.tsx.

import { useEffect, useState, useCallback } from "react";
import MapaLeafletV2, { type Props } from "./MapaLeafletV2";
import MapaFallbackOSM from "./MapaFallbackOSM";
import { deveTentarRetryAgora, type MapaProviderEstado } from "@/lib/mapa-provider";

const POLL_MS = 30_000; // mesmo intervalo ja usado pelo resto da Central

async function buscarEstado(): Promise<MapaProviderEstado | null> {
  const r = await fetch("/api/mapa-provider");
  if (!r.ok) return null;
  return r.json();
}

async function postarEvento(evento: "quota_excedida" | "retry_sucesso" | "retry_falhou") {
  await fetch("/api/mapa-provider", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evento }),
  }).catch(() => {});
}

export default function MapaComFallback(props: Props) {
  const [estado, setEstado] = useState<MapaProviderEstado | null>(null);
  const [tentandoRetry, setTentandoRetry] = useState(false);
  // Timestamp de quando o probe oculto do Google confirmou onMapLoaded
  // nesta tentativa de retry -- null enquanto nao carregou ainda (ou antes
  // de iniciar). Ver ProbeRetry mais abaixo pra como isso decide
  // sucesso/falha do retry com um sinal real.
  const [mapaCarregouEm, setMapaCarregouEm] = useState<number | null>(null);

  useEffect(() => {
    let ativo = true;
    const ciclo = async () => {
      const novoEstado = await buscarEstado();
      if (ativo && novoEstado) setEstado(novoEstado);
    };
    ciclo();
    const t = setInterval(ciclo, POLL_MS);
    return () => { ativo = false; clearInterval(t); };
  }, []);

  const onQuotaExceeded = useCallback(() => {
    postarEvento("quota_excedida").then(async () => setEstado(await buscarEstado()));
  }, []);

  const iniciarRetry = useCallback(() => {
    setMapaCarregouEm(null);
    setTentandoRetry(true);
  }, []);

  const onRetrySucesso = useCallback(() => {
    setTentandoRetry(false);
    postarEvento("retry_sucesso").then(async () => setEstado(await buscarEstado()));
  }, []);

  const onRetryFalhou = useCallback(() => {
    setTentandoRetry(false);
    postarEvento("retry_falhou").then(async () => setEstado(await buscarEstado()));
  }, []);

  useEffect(() => {
    if (!estado || tentandoRetry) return;
    if (deveTentarRetryAgora(estado, new Date().toISOString())) iniciarRetry();
  }, [estado, tentandoRetry, iniciarRetry]);

  if (!estado || estado.provider === "google") {
    return <MapaLeafletV2 {...props} onQuotaExceeded={onQuotaExceeded} />;
  }

  return (
    <>
      <MapaFallbackOSM
        veiculosMapa={props.veiculosMapa}
        onVeiculoClick={props.onVeiculoClick}
        mapTokens={props.mapTokens}
        tema={props.tema}
      />
      {tentandoRetry && (
        // Instancia oculta do mapa real, so' pra testar se o Google voltou --
        // nao aparece pro operador (position fixed fora da tela, nao display:none
        // -- alguns navegadores pausam render/JS de elementos display:none, o
        // que impediria o SDK do Google de sequer tentar carregar).
        <div style={{ position: "fixed", top: -9999, left: -9999, width: 400, height: 300 }}>
          <MapaLeafletV2
            {...props}
            onQuotaExceeded={onRetryFalhou}
            onMapLoaded={() => setMapaCarregouEm(Date.now())}
          />
          <ProbeRetry
            mapaCarregouEm={mapaCarregouEm}
            onFalhaConfirmada={onRetryFalhou}
            onSucessoConfirmado={onRetrySucesso}
          />
        </div>
      )}
    </>
  );
}

// Decide se o retry teve sucesso usando um sinal REAL (onMapLoaded do
// MapaLeafletV2), nao silencio ambiguo -- correcao de um defeito achado na
// varredura pre-execucao deste plano (ver ledger): uma versao anterior
// deste componente tratava "nenhum erro em 8s" como sucesso a partir do
// MOUNT do probe, o que e' ambiguo (o Google pode so' nao ter tentado
// renderizar ainda). Design corrigido, ancorado no incidente real de 08/09
// (o erro de cota apareceu ~1s depois do mapa instanciar, nao depois de
// segundos incertos):
//   - so' comeca a contar depois que mapaCarregouEm (via onMapLoaded) tem
//     um valor -- ou seja, depois que o SDK do Google de fato instanciou
//     o mapa, no' so' carregou o script;
//   - 5s depois disso (5x a margem sobre o ~1s observado no incidente
//     real) sem erro de cota = sucesso CONFIRMADO, nao assumido;
//   - se onMapLoaded nunca disparar dentro de 15s do mount (rede lenta,
//     script travado por outro motivo), trata como falha -- nao da' pra
//     confirmar nada, e o padrao seguro deste projeto (mesma filosofia do
//     detector de desvio, recall > precisao) e' ficar no fallback que já
//     funciona em vez de arriscar voltar pro que pode continuar quebrado.
function ProbeRetry({
  mapaCarregouEm,
  onFalhaConfirmada,
  onSucessoConfirmado,
}: {
  mapaCarregouEm: number | null;
  onFalhaConfirmada: () => void;
  onSucessoConfirmado: () => void;
}) {
  useEffect(() => {
    if (mapaCarregouEm == null) {
      const tOuter = setTimeout(onFalhaConfirmada, 15_000);
      return () => clearTimeout(tOuter);
    }
    const tInner = setTimeout(onSucessoConfirmado, 5_000);
    return () => clearTimeout(tInner);
  }, [mapaCarregouEm, onFalhaConfirmada, onSucessoConfirmado]);
  return null;
}
