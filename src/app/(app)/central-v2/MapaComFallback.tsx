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

// Resposta HTTP da rota = estado puro do reducer + o relogio do SERVIDOR.
// O reducer (src/lib/mapa-provider.ts) continua puro e sem esse campo -- ele
// e' so' do transporte. Motivo: `proximaTentativaEm` e' escrito pelo relogio
// do servidor; comparar contra `new Date()` do NAVEGADOR faria uma estacao de
// operador com relogio adiantado ver todo deadline recem-gravado como ja'
// vencido e entrar em loop de retry a cada 5-15s (duracao do probe),
// queimando cota real do Google exatamente durante o incidente.
type RespostaMapaProvider = MapaProviderEstado & { agora: string };

async function buscarEstado(): Promise<RespostaMapaProvider | null> {
  const r = await fetch("/api/mapa-provider");
  if (!r.ok) return null;
  return r.json();
}

// Retorna o `novoEstado` que a rota ja calculou e persistiu (via
// transicionar()) direto no corpo da resposta do POST. Usar esse valor pra
// atualizar o estado local de forma SINCRONA com o evento evita uma race:
// se em vez disso esperassemos um GET /api/mapa-provider separado, haveria
// uma janela onde o componente ja comitou tentandoRetry=false mas o estado
// local ainda e' o antigo (com proximaTentativaEm ja vencido, motivo de o
// retry ter comecado) -- o efeito de "hora de tentar retry?" rodaria de
// novo nessa janela e disparava outro retry imediato, sem respeitar o
// backoff de RETRY_INTERVALO_MIN. Ver revisao do Task 9.
async function postarEvento(
  evento: "quota_excedida" | "retry_sucesso" | "retry_falhou"
): Promise<RespostaMapaProvider | null> {
  try {
    const r = await fetch("/api/mapa-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evento }),
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

export default function MapaComFallback(props: Props) {
  const [estado, setEstado] = useState<RespostaMapaProvider | null>(null);
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
    postarEvento("quota_excedida").then(async (novoEstado) => setEstado(novoEstado ?? (await buscarEstado())));
  }, []);

  const iniciarRetry = useCallback(() => {
    setMapaCarregouEm(null);
    setTentandoRetry(true);
  }, []);

  // `setTentandoRetry(false)` so' acontece DEPOIS que o `estado` novo
  // (vindo direto do corpo do POST, ja com proximaTentativaEm recalculado)
  // esta disponivel -- as duas atualizacoes de estado saem juntas no mesmo
  // callback assincrono, entao o React comita as duas no mesmo render. Isso
  // fecha a race apontada na revisao: antes, `setTentandoRetry(false)`
  // rodava sincronamente antes do POST resolver, deixando uma janela em
  // que o efeito de retry via `tentandoRetry=false` + `estado` ainda velho
  // (com proximaTentativaEm ja vencido) e disparava outra tentativa
  // imediata, sem respeitar os 20min de backoff.
  const onRetrySucesso = useCallback(() => {
    postarEvento("retry_sucesso").then(async (novoEstado) => {
      setEstado(novoEstado ?? (await buscarEstado()));
      setTentandoRetry(false);
    });
  }, []);

  const onRetryFalhou = useCallback(() => {
    postarEvento("retry_falhou").then(async (novoEstado) => {
      setEstado(novoEstado ?? (await buscarEstado()));
      setTentandoRetry(false);
    });
  }, []);

  useEffect(() => {
    if (!estado || tentandoRetry) return;
    // `estado.agora` (relogio do servidor, vindo na mesma resposta que
    // trouxe proximaTentativaEm), nao o relogio do navegador -- ver
    // RespostaMapaProvider acima.
    if (deveTentarRetryAgora(estado, estado.agora)) iniciarRetry();
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
