"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import AlertaSonoro from "../components/AlertaSonoro";
import { resolverAlerta, marcarFalsoComCategoria, resolverVarios, limparVarios, type TabelaAlertas } from "../acoes-alertas";
import MenuMotivoFalso, { type CategoriaFalso } from "../components/MenuMotivoFalso";
import { enviarComandoVeiculo } from "@/lib/unitrac-comandos";
import { formatarProgressoDestino, formatarPlacarSombra, formatarConfiabilidadeDetector, IDADE_MINIMA_ACAO_MASSA_MIN, elegivelParaAcaoMassa } from "@/lib/detectores";
import type { VeiculoMapa, Parada, PontoEntrega, Tiroteio, GeoJsonCollection } from "./MapaLeafletV2";
import { COR_PENDENTE, COR_ENTREGUE, COR_OUTRO } from "./MapaLeafletV2";
import { DARK_TOKENS, LIGHT_TOKENS, SAT_TILE_URL, SAT_TILE_SUBDOMAINS } from "./tokens";
import { temaT, material, RAIO, MOLA, TIPO, FONT_SANS, FONT_MONO, NUM } from "./design";
import { acoesVisiveis, corStatus } from "./card-acoes";
import PopoverMapa from "./PopoverMapa";
import EscopoMapaSwitcher, { type EscopoMapa } from "./EscopoMapaSwitcher";
import SplitDivider from "./SplitDivider";
import { TIPOS_ABA_DESVIOS, TIPOS_REVISAO_INDIVIDUAL } from "./tipos-alerta";
import AvisoDesvioTopo, { type ItemAvisoDesvio } from "./AvisoDesvioTopo";
import { pedirConfirmacao, podeExecutar, aoTrocarVeiculo, type AcaoCritica, type EstadoConfirmacao } from "./confirmacao-acao";
import { delayEntradaEscalonada } from "@/lib/stagger";
import { motion, AnimatePresence } from "framer-motion";

const MapaLeafletV2 = dynamic(() => import("./MapaComFallback"), { ssr: false });

// ── Types ──────────────────────────────────────────────────────────────
interface AlertaEnriquecido {
  id: string;
  veiculo_id: string;
  cv: string;
  placa: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  status: string;
  score: number | null;
  lat: number | null;
  lng: number | null;
  origemLat: number | null;
  origemLng: number | null;
  velocidade: number | null;
  ignicao: boolean | null;
  atraso_min: number | null;
  local: string | null;
  progressoDestinoM: number | null;
  placarSombra: { placar: number; componentes: Record<string, number | boolean | string> } | null;
  calibracao: { segmento: string | null; taxa_falso_positivo: number } | null;
  // 21/09: "Reaberto — Nº episódio" quando um episódio novo reabriu este desvio
  // (lib/desvio-episodio.ts). Opcional: a Central Romaneio não preenche.
  reabertura?: string | null;
}

interface ClienteInfo { id: string; nome: string; cod: string; }

interface Props {
  cliente: string;
  clientes: ClienteInfo[];
  clienteAtivoId: string;
  veiculos: { placa: string; cv: string }[];
  alertasIniciais: AlertaEnriquecido[];
  // Task 3 (motor-romaneio-paralelo): permite a tela /central-romaneio reusar
  // este componente lendo de alertas_romaneio em vez de alertas. Default
  // preserva EXATAMENTE o comportamento da Central — não passar estas props
  // é o caminho atual e continua idêntico.
  fonteAlertas?: "central" | "romaneio";
  // Base do link do cliente-switcher (coluna esquerda da toolbar). Default
  // "/central-v2" é o valor hardcoded que já existia (redireciona pra "/").
  hrefBaseClientes?: string;
}

// ── Constants ──────────────────────────────────────────────────────────
const PERIODOS = [1, 2, 6, 12, 24, 48] as const;
const ZOOM_LABELS: [string, number][] = [["RUA", 17], ["QUADRA", 15], ["BAIRRO", 13], ["CIDADE", 11]];

const NOME_TIPO: Record<string, string> = {
  panico: "Pânico", bau: "Baú aberto", favela: "Favela/risco",
  tiroteio: "Tiroteio", jammer: "Jammer/sinal", saida_nao_autorizada: "Saída n.aut.",
  parada_anomala: "Par. anômala", parada_longa: "Par. longa", parada_cliente: "Par. cliente",
  ignicao_noturna: "Ign. noturna", desvio: "Desvio em movimento", parada_fora_tapete: "Parada fora do esperado", excesso: "Excesso vel.",
  retorno_tardio: "Retorno tardio", aceleracao: "Acel. brusca", sem_comunicacao: "Sem comunicação",
  parada_sem_marcacao: "Parada sem marcação",
  baseline_veiculo: "Anomalia de velocidade",
  romaneio_ausente: "Sem romaneio hoje",
};
function nomeT(tipo: string) { return NOME_TIPO[tipo] ?? tipo; }

// Prioridade por tipo (maior = mais urgente). parada_fora_tapete e' tipo
// proprio no banco (nao compartilha o slot de arbitracao do desvio de
// movimento, achado 27/07), mas pro operador ela conta como desvio de rota --
// mesma prioridade, mesmo nome, mesmo apito (ver TIPOS_NOTIFICAM_POR_CLIENTE).
const TIPO_PRIORITY: Record<string, number> = {
  desvio: 15, parada_fora_tapete: 15, parada_sem_marcacao: 14, panico: 12, saida_nao_autorizada: 10, jammer: 9,
  bau: 8, parada_cliente: 8, tiroteio: 7, parada_anomala: 6, ignicao_noturna: 5,
  retorno_tardio: 4, aceleracao: 3, favela: 2, parada_longa: 1, romaneio_ausente: 11,
};
function prioAlerta(a: { nivel: string; tipo: string }): number {
  return (a.nivel === "critico" ? 100 : 0) + (TIPO_PRIORITY[a.tipo] ?? 0);
}

// "Outros avisos": tipos de alto volume e baixo valor acionável (achado
// real 20/08 -- favela+baseline_veiculo sao 67% do volume de alertas em
// 14 dias com ~100% de taxa "correto", competindo por atencao com desvio
// sem trazer decisao nova pro operador na maioria das vezes). Continuam
// sendo detectados/salvos normalmente -- só saem do fluxo principal de
// revisão, numa seção separada colapsada por padrão.
const TIPOS_OUTROS_AVISOS = new Set(["favela", "baseline_veiculo"]);

// TIPOS_REVISAO_INDIVIDUAL vive em ./tipos-alerta (importado no topo) desde a
// revisão final de branch de 27/08 -- ver lá os dois motivos (qualidade de
// calibração + cooldown de re-disparo) e por que parada_anomala/parada_longa
// entraram na lista.

function separarOutrosAvisos<T extends { tipo: string }>(lista: T[]): { principais: T[]; outros: T[] } {
  const principais: T[] = [];
  const outros: T[] = [];
  for (const a of lista) {
    (TIPOS_OUTROS_AVISOS.has(a.tipo) ? outros : principais).push(a);
  }
  return { principais, outros };
}

// Tipos que disparam apito + flash de "novo" por cliente (cod_user_unitrac).
// Pedido do cliente (06/07/2026): parar de notificar tudo que vira crítico —
// cada operação só quer ser incomodada pelo que realmente importa pra ela.
// Todos os outros tipos continuam sendo detectados/salvos/visíveis na lista,
// só não tocam apito nem piscam como "novo". Cliente/tipo não mapeado aqui =
// não notifica nada (default seguro).
// PÂNICO é exceção de segurança e sempre notifica, em qualquer cliente —
// não é negociável mesmo se não estiver nessa lista.
const TIPOS_NOTIFICAM_POR_CLIENTE: Record<string, string[]> = {
  // parada_sem_marcacao adicionado 20/08 (achado real: virou crítico com
  // badge "possível desvio", mas ficava mudo -- operador só notava se
  // estivesse com a tela aberta na hora certa. Mesmo apito do desvio agora.
  // parada_anomala adicionado 25/08 -- pedido explícito do cliente no grupo
  // ("parada anomala e parada suspeita, tem que ir para aba do desvio"):
  // esses cards viviam fora da aba DESVIOS e mudos, cliente queria os dois.
  "4096": ["desvio", "parada_fora_tapete", "parada_sem_marcacao", "parada_anomala"],  // Nutry: desvio de rota (movimento + parada fora do tapete, já mostrado na faixa do topo) + parada sem marcação (possível desvio) + parada anômala/suspeita
  "4586": ["parada_cliente"],  // Benassi: só parada de 1h30+ dentro do cliente
};

// Aba "Desvios" (task A1, 27/08) -- FIXA e sempre visível pra QUALQUER
// cliente, independente de cod_user_unitrac. Antes disso a 2ª aba (então
// chamada "foco") só aparecia se o cliente estivesse mapeado em
// LABEL_FOCO_POR_CLIENTE/TIPOS_NOTIFICAM_POR_CLIENTE -- falha silenciosa:
// cliente novo sem entrada nesses Records nunca ganhava a aba, sem aviso
// nenhum. TIPOS_ABA_DESVIOS vive em ./tipos-alerta (importado no topo) desde a
// revisão final de branch de 27/08, pra que MonitorV2.test.ts leia a MESMA
// lista em vez de uma cópia.
const LABEL_ABA_DESVIOS = "DESVIOS";

function tempoAtras(desde: string): string {
  const diff = Math.floor((Date.now() - new Date(desde).getTime()) / 60000);
  if (diff < 60) return `${diff}min`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h`;
  return `${Math.floor(diff / 1440)}d`;
}

function minutosDesde(desde: string): number {
  return Math.round((Date.now() - new Date(desde).getTime()) / 60000);
}

// Achado real 13/08 (checagem ao vivo): alerta achado parado 19h sem
// nenhuma revisao, entre 92 alertas ativos -- nenhum destaque na tela
// distinguia "acabou de abrir" de "esta ha' horas esperando", entao a
// fila envelhecida ficava invisivel misturada com o resto. Limiares
// ORIGINAIS pedidos pelo usuario (13/08): 3h chama atencao, 8h+ fica
// critico (era aproximadamente a idade do alerta de 19h achado). Canal de
// cor SEPARADO do `cor` semantico de tipo/nivel do alerta (que ja' e'
// usado pra borda/fundo do card) -- escalonar por idade nao deve se
// confundir com "que tipo de alerta e'".
//
// RECALIBRADO 27/08 (Fase 2 do plano de latencia, autorizado pelo
// usuario): investigacao com dado real de banco (26/08) mostrou que a
// deteccao em si e' rapida (1,5-8min) -- o atraso percebido pelos
// operadores vinha de mediana real de 22min ate' o alerta ser tratado,
// p90 de 76min. Os limiares de 3h/8h so' pintavam os casos extremos e
// deixavam invisivel o problema tipico do dia a dia (22-76min). Novos
// valores: 30min pega quem esta' demorando mais que o normal sem pintar
// a maioria dos alertas em fluxo saudavel; 90min fica perto do p90 real
// (76min), do lado conservador.
const LIMIAR_ALERTA_ATENCAO_MIN = 30;
const LIMIAR_ALERTA_CRITICO_MIN = 90;
function corIdadeAlerta(desde: string, tema: "dark" | "light"): { cor: string; peso: number } {
  const min = minutosDesde(desde);
  if (min >= LIMIAR_ALERTA_CRITICO_MIN) return { cor: tema === "dark" ? "#ff6b5e" : "#c9392c", peso: 800 };
  if (min >= LIMIAR_ALERTA_ATENCAO_MIN) return { cor: tema === "dark" ? "#f2b84b" : "#a66a10", peso: 700 };
  return { cor: "", peso: 400 }; // "" = mantem a cor padrao (T.dim) de sempre
}

function formatarDist(m: number): string {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

// ── Static style helpers ───────────────────────────────────────────────
const BASE_BTN: React.CSSProperties = {
  background: "transparent", border: "none", borderRadius: RAIO.control,
  cursor: "pointer", color: "inherit",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: FONT_SANS,
};

function tinyBtn(color: string, opts?: { borderAlpha?: string; bgAlpha?: string }): React.CSSProperties {
  const borderAlpha = opts?.borderAlpha ?? "40";
  const bgAlpha = opts?.bgAlpha ?? "14";
  return {
    height: 28, padding: "0 12px", borderRadius: RAIO.capsule,
    border: `0.5px solid ${color}${borderAlpha}`, background: `${color}${bgAlpha}`,
    cursor: "pointer", fontSize: 12, fontWeight: 700, color,
    fontFamily: FONT_SANS,
  };
}

// Rotulo "TODOS · N" / "SELECIONADOS · N" no canto de cada painel do split
// view — sem isso os 2 mapas lado a lado ficam indistinguiveis a primeira vista.
function rotuloPainelStyle(
  lado: "left" | "right",
  T: { text: string; border: string },
  tema: "dark" | "light"
): React.CSSProperties {
  return {
    position: "absolute", top: 10, [lado]: 10,
    zIndex: 40, fontSize: 12, fontWeight: 700, letterSpacing: ".04em",
    color: T.text, fontFamily: FONT_MONO,
    background: tema === "dark" ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.85)",
    backdropFilter: "blur(6px)", border: `1px solid ${T.border}`,
    borderRadius: RAIO.control, padding: "3px 8px", pointerEvents: "none",
  };
}

// `toolbar` é o z-index do PRÓPRIO container da toolbar (não dos itens dentro
// dela). Isso importa porque `position: relative` + `zIndex` no container cria
// um stacking context novo: tudo que está DENTRO da toolbar (combo, settings)
// fica confinado a competir nesse valor lá fora, não no valor interno deles
// (achado real 27/08 -- settings tinha zIndex 900 mas a toolbar em si só
// tinha 50, então os pills do mapa com zIndex 100 competiam direto contra o
// "50" da toolbar no stacking context raiz e venciam, mesmo settings sendo
// 900 "por dentro"). Tem que ficar acima de tudo que fica sobre o mapa
// (badge/toasts/combo/drawer) e abaixo do overlay de pânico, que precisa
// cobrir a tela inteira incluindo a toolbar.
const Z = { badge: 100, toasts: 800, combo: 850, drawer: 1000, panico: 2000, settings: 900, toolbar: 1500 } as const;

// Duplicada de unitrac.ts (mesmo motivo do difAnguloGraus em detectores.ts:
// modulo client-side, sem importar lib de servidor). So pra mostrar "parado
// a Xm de [ponto]" no drawer -- nao alimenta nenhum detector.
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10}m`;
  return `${(m / 1000).toFixed(1).replace(".", ",")}km`;
}

// Acima disso (m), dois pontos com distancia parecida à posição não contam
// como "poderia ser qualquer um dos dois" — GPS comum tem uns 10-15m de
// erro; o dobro dá folga sem soar ambíguo à toa. Achado real (09/07,
// pesquisado a pedido do cliente): raro (2 de 309 pares de pontos
// comparados), mas quando acontece é grave — dois clientes a só 2m um do
// outro, GPS não distingue de jeito nenhum.
const MARGEM_AMBIGUIDADE_M = 30;

// Ponto(s) de entrega (qualquer status -- pendente, feito ou "esteve no
// local") mais próximo(s) da posição atual. So informativo (ver
// renderDrawer "Parado no cliente"): pedido do cliente 09/07 apos
// investigar alertas de desvio travados em veículos parados -- ajuda o
// operador a ver rápido se o veículo está perto de algum ponto conhecido,
// sem o sistema decidir nada. Quando 2+ pontos DIFERENTES (pontoCodigo
// distinto) ficam a distância parecida da posição, retorna TODOS eles em
// vez de escolher 1 arbitrariamente — não dá pra saber qual é de verdade
// só pela distância.
function pontoMaisProximoQualquer(
  lat: number, lng: number, pontos: PontoEntrega[]
): { candidatos: { ponto: PontoEntrega; distM: number }[] } | null {
  // Deduplica por ponto/endereço — várias NFs (alvos) podem compartilhar o
  // mesmo pontoCodigo; isso não é ambiguidade, é o mesmo lugar.
  const porPonto = new Map<string, PontoEntrega>();
  for (const p of pontos) {
    const chave = p.pontoCodigo != null ? `pc:${p.pontoCodigo}` : `xy:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    if (!porPonto.has(chave)) porPonto.set(chave, p);
  }
  const distancias = [...porPonto.values()]
    .map(ponto => ({ ponto, distM: haversineM(lat, lng, ponto.lat, ponto.lng) }))
    .sort((a, b) => a.distM - b.distM);
  if (distancias.length === 0) return null;

  const candidatos = [distancias[0]];
  for (let i = 1; i < distancias.length; i++) {
    if (distancias[i].distM - distancias[0].distM <= MARGEM_AMBIGUIDADE_M) candidatos.push(distancias[i]);
    else break;
  }
  return { candidatos };
}

// ── Foco de veiculo (selecao + rastro/paradas/alvos + comandos + camera) ──
// Encapsula TUDO relacionado a "qual veiculo esta selecionado e o que
// mostra dele". Chamado 2x no componente principal (uma instancia por
// painel do split view) pra permitir selecionar um veiculo DIFERENTE em
// cada painel AO MESMO TEMPO — 2 sistemas de verdade, cada um com seu
// proprio drawer/camera/rastro, nao uma selecao compartilhada com "dono"
// alternando (bug real reportado 08/07: so dava pra ter 1 veiculo
// selecionado por vez entre os 2 paineis; selecionar no outro derrubava o
// primeiro). Fora do split view, so a 1a instancia e usada, exatamente como
// a selecao unica sempre funcionou.
function usePainelFoco(params: {
  veiculosMapa: VeiculoMapa[];
  veiculosBase: { placa: string; cv: string }[];
  alertas: AlertaEnriquecido[];
  alvosGlobais: PontoEntrega[];
  horas: number;
}) {
  const { veiculosMapa, veiculosBase, alertas, alvosGlobais, horas } = params;

  const [cvSelecionado, setCvSelecionado] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const gatilhoRef = useRef(0);

  const [rastro, setRastro] = useState<[number, number][]>([]);
  const [paradas, setParadas] = useState<Parada[]>([]);
  const [alvos, setAlvos] = useState<PontoEntrega[]>([]);
  const [mostrarRastro, setMostrarRastro] = useState(false);
  const [mostrarParadas, setMostrarParadas] = useState(false);
  const [carregando, setCarregando] = useState(false);

  const [cmdSirene, setCmdSirene] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
  const [cmdBloqueio, setCmdBloqueio] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  // Alterna a cada acionamento bem-sucedido — o rele fisico do veiculo alterna
  // (bloqueia/desbloqueia) a cada pulso do mesmo comando "bloqueio".
  const [motorBloqueado, setMotorBloqueado] = useState(false);

  const [seguir, setSeguir] = useState(false);
  const [flyPara, setFlyPara] = useState<{ lat: number; lng: number; gatilho: number } | null>(null);
  const [alertaAtivoId, setAlertaAtivoId] = useState<string | null>(null);

  const carregarVeiculo = useCallback(async (cv: string, h: number, temPosicaoAoVivo: boolean) => {
    // Cancela qualquer fetch anterior em voo (rastro do veículo antigo não pode vazar)
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    const { signal } = ctrl;

    setCarregando(true);
    try {
      // Cada fetch processa assim que a SUA resposta chega — antes, um
      // Promise.all fazia o rastro (rápido) esperar pelo mais lento dos 3
      // (às vezes stops/alvos demoravam bem mais), parecendo "rastro lento".
      //
      // Rastro BRUTO primeiro (rápido — só remove picos de GPS, sem ajuste
      // de rua): aparece na hora. O ajuste pra rua real (OSRM) pode levar
      // vários segundos em rastros com muitos saltos de GPS (achado real
      // 09/07: TTK-4D15, 322 saltos, ~12,7s só nessa etapa) — busca
      // separada, substitui o rastro sozinha quando terminar, sem travar
      // "carregando" nem os outros dados.
      const aplicarRastro = (rd: { pontos?: { lat: number; lng: number }[] } | null) => {
        if (signal.aborted || !rd) return;
        const tuples = (rd.pontos ?? []).map(p => [p.lat, p.lng] as [number, number]);
        setRastro(tuples);
        // Voa para o último ponto do rastro só como FALLBACK, quando ainda
        // não há posição ao vivo (ex.: veículo buscado por placa, fora de
        // posicoes_atuais). Com posição ao vivo já conhecida, focar de novo
        // no fim do rastro sobrescrevia com um ponto possivelmente mais
        // antigo (rastro vem de outro endpoint, pode estar defasado).
        if (!temPosicaoAoVivo && tuples.length > 0) {
          const [lat, lng] = tuples[tuples.length - 1];
          gatilhoRef.current += 1;
          setFlyPara({ lat, lng, gatilho: gatilhoRef.current });
        }
      };

      const rastroBrutoP = fetch(`/api/rastro?cv=${encodeURIComponent(cv)}&horas=${h}&bruto=1`, { signal })
        .then(r => r.ok ? r.json() : null)
        .then(aplicarRastro)
        .catch(() => {});

      // Ajustado: NÃO entra no Promise.allSettled abaixo (não deve travar o
      // "carregando") — roda em paralelo e troca o rastro sozinho quando
      // terminar. O `signal` já garante que não aplica em veículo trocado.
      fetch(`/api/rastro?cv=${encodeURIComponent(cv)}&horas=${h}`, { signal })
        .then(r => r.ok ? r.json() : null)
        .then(aplicarRastro)
        .catch(() => {});

      const stopsP = fetch(`/api/stops?cv=${encodeURIComponent(cv)}&horas=${h}`, { signal })
        .then(r => r.ok ? r.json() : null)
        .then((sd: { paradas?: Parada[] } | null) => { if (!signal.aborted && sd) setParadas(sd.paradas ?? []); })
        .catch(() => {});

      const alvosP = fetch(`/api/alvos?cv=${encodeURIComponent(cv)}`, { signal })
        .then(r => r.ok ? r.json() : null)
        .then((ad: { pontos?: PontoEntrega[] } | null) => { if (!signal.aborted && ad) setAlvos(ad.pontos ?? []); })
        .catch(() => {});

      await Promise.allSettled([rastroBrutoP, stopsP, alvosP]);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
    if (!signal.aborted) setCarregando(false);
  }, []);

  const selecionarVeiculo = useCallback((cv: string, coords?: { lat: number; lng: number }) => {
    // Abortar fetch IMEDIATAMENTE — antes do próximo render+useEffect. Sem isso, uma
    // resposta que chega entre o setState e o useEffect pode chamar setRastro(A_data)
    // depois do setRastro([]) daqui, deixando o rastro do veículo antigo visível.
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;

    setCvSelecionado(cv);
    // Incrementar reloadKey força o useEffect a disparar mesmo se cvSelecionado não mudou
    // (re-seleção do mesmo veículo). Garante que carregarVeiculo é chamado exatamente UMA vez.
    setReloadKey(k => k + 1);
    setSeguir(false);
    setMostrarRastro(true);
    setMostrarParadas(true);
    setRastro([]);
    setParadas([]);
    setAlvos([]);
    setCmdSirene("idle");
    setCmdBloqueio("idle");
    setMotorBloqueado(false);
    setFallbackUrl(null);
    const vm = veiculosMapa.find(v => v.cv === cv);
    const pos = (vm?.lat && vm?.lng) ? { lat: vm.lat, lng: vm.lng } : coords;
    if (pos) {
      gatilhoRef.current += 1;
      setFlyPara({ lat: pos.lat, lng: pos.lng, gatilho: gatilhoRef.current });
    }
  }, [veiculosMapa]);

  const limparSelecao = useCallback(() => {
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    setCvSelecionado(null);
    setAlertaAtivoId(null);
    setRastro([]);
    setParadas([]);
    setAlvos([]);
    setSeguir(false);
    setMostrarRastro(false);
    setMostrarParadas(false);
    setCarregando(false);
    setCmdSirene("idle");
    setCmdBloqueio("idle");
    setMotorBloqueado(false);
    setFallbackUrl(null);
  }, []);

  const handleVeiculoClick = useCallback((vm: VeiculoMapa) => {
    selecionarVeiculo(vm.cv);
  }, [selecionarVeiculo]);

  useEffect(() => {
    if (!cvSelecionado) return;
    const vm = veiculosMapa.find(v => v.cv === cvSelecionado);
    carregarVeiculo(cvSelecionado, horas, vm?.lat != null && vm?.lng != null);
    // reloadKey garante re-disparo ao re-selecionar o mesmo veículo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvSelecionado, horas, carregarVeiculo, reloadKey]);

  // Rastro vivo: anexa a posição nova do veículo focado (DESSE painel) ao
  // rastro já carregado, toda vez que o poll de posições (10-15s) atualiza
  // veiculosMapa. Sem isso o rastro azul só se atualizava na seleção,
  // ficando parado enquanto o carro andava.
  useEffect(() => {
    if (!cvSelecionado) return;
    const v = veiculosMapa.find(x => x.cv === cvSelecionado);
    if (v?.lat == null || v?.lng == null) return;
    const lat = v.lat, lng = v.lng;
    setRastro(r => {
      if (r.length === 0) return r; // fetch inicial ainda em voo
      const [la, lo] = r[r.length - 1];
      const dLat = (lat - la) * 111_320;
      const dLng = (lng - lo) * 111_320 * Math.cos((la * Math.PI) / 180);
      const distM = Math.sqrt(dLat * dLat + dLng * dLng);
      return distM > 10 ? [...r, [lat, lng] as [number, number]] : r;
    });
  }, [veiculosMapa, cvSelecionado]);

  const acionar = useCallback(async (tipo: "sirene" | "bloqueio") => {
    if (!cvSelecionado) return;
    const setter = tipo === "sirene" ? setCmdSirene : setCmdBloqueio;
    setter("loading");
    const resultado = await enviarComandoVeiculo(cvSelecionado, tipo);
    if (resultado.ok) {
      setter("ok");
      if (tipo === "bloqueio") setMotorBloqueado(v => !v);
      setTimeout(() => setter("idle"), 3000);
    } else {
      setter("fallback");
      if (resultado.portalUrl) setFallbackUrl(resultado.portalUrl);
    }
  }, [cvSelecionado]);

  // Confirmacao em 2 cliques de Sirene/Bloqueio/Desbloqueio (26/09): antes
  // disparavam no primeiro clique. Estado por painel (este hook existe 1x por
  // painel do split), expira em JANELA_CONFIRMACAO_MS e cai ao trocar de veiculo.
  const [confirmacao, setConfirmacao] = useState<EstadoConfirmacao>(null);
  // Trocar de veiculo cancela: ajuste de estado durante o render (padrao do
  // React pra "resetar quando a prop muda"), sem setState dentro de effect.
  const [cvDaConfirmacao, setCvDaConfirmacao] = useState(cvSelecionado);
  if (cvDaConfirmacao !== cvSelecionado) {
    setCvDaConfirmacao(cvSelecionado);
    setConfirmacao(e => aoTrocarVeiculo(e, cvSelecionado));
  }
  useEffect(() => {
    if (!confirmacao) return;
    const t = setTimeout(() => setConfirmacao(null), Math.max(0, confirmacao.ate - Date.now()));
    return () => clearTimeout(t);
  }, [confirmacao]);
  const cancelarConfirmacao = useCallback(() => setConfirmacao(null), []);
  const clicarAcaoCritica = useCallback((acao: AcaoCritica) => {
    if (!cvSelecionado) return;
    // Comando em voo: nada (sem disparo duplo nem re-armar a confirmacao).
    if ((acao === "sirene" ? cmdSirene : cmdBloqueio) === "loading") return;
    const agora = Date.now();
    if (podeExecutar(confirmacao, acao, cvSelecionado, agora)) {
      setConfirmacao(null);
      acionar(acao);
    } else {
      setConfirmacao(pedirConfirmacao(acao, cvSelecionado, agora));
    }
  }, [cvSelecionado, cmdSirene, cmdBloqueio, confirmacao, acionar]);

  const centralizar = useCallback(() => {
    const vm = cvSelecionado ? veiculosMapa.find(v => v.cv === cvSelecionado) : null;
    if (vm?.lat && vm?.lng) {
      gatilhoRef.current += 1;
      setFlyPara({ lat: vm.lat, lng: vm.lng, gatilho: gatilhoRef.current });
    }
  }, [cvSelecionado, veiculosMapa]);

  const vmAtual = cvSelecionado ? veiculosMapa.find(v => v.cv === cvSelecionado) ?? null : null;

  const placaSelecionada = cvSelecionado
    ? (veiculosBase.find(v => v.cv === cvSelecionado)?.placa
      ?? veiculosMapa.find(v => v.cv === cvSelecionado)?.placa
      ?? cvSelecionado)
    : null;

  // Ponto de início do desvio ativo do veículo selecionado (para o marcador
  // + linha no mapa). origemLat/origemLng vêm do próprio alerta (Task 4),
  // não da posição atual do veículo.
  const desvioSelecionado = useMemo(() => {
    if (!cvSelecionado) return null;
    const a = alertas.find(
      (x) => (x.tipo === "desvio" || x.tipo === "parada_fora_tapete") && x.cv === cvSelecionado && x.origemLat != null && x.origemLng != null
    );
    return a ? { lat: a.origemLat as number, lng: a.origemLng as number } : null;
  }, [alertas, cvSelecionado]);

  // Fallback: se o fetch individual retornou vazio mas alvosGlobais tem dados da placa, usa o global
  const alvosEfetivos = useMemo(() => {
    if (alvos.length > 0) return alvos;
    if (!cvSelecionado || !placaSelecionada) return [];
    const placa = veiculosBase.find(v => v.cv === cvSelecionado)?.placa ?? vmAtual?.placa;
    if (!placa) return [];
    return alvosGlobais.filter(a => a.placa === placa);
  }, [alvos, cvSelecionado, placaSelecionada, veiculosBase, vmAtual, alvosGlobais]);

  const alvosFeitos = alvosEfetivos.filter(p => p.feito).length;
  const alvosTotal = alvosEfetivos.length;

  // "Parado no cliente" -- so informativo, ver comentario em pontoMaisProximoQualquer.
  const paradoMin = vmAtual?.parado_desde ? minutosDesde(vmAtual.parado_desde) : null;
  const pontoMaisProximo = useMemo(() => {
    if (!vmAtual || vmAtual.lat == null || vmAtual.lng == null || alvosEfetivos.length === 0) return null;
    return pontoMaisProximoQualquer(vmAtual.lat, vmAtual.lng, alvosEfetivos);
  }, [vmAtual, alvosEfetivos]);

  const placaColor = vmAtual
    ? (vmAtual.ignicao && vmAtual.velocidade > 0 ? "verde" : vmAtual.ignicao ? "accent" : "muted")
    : "texto";

  return {
    cvSelecionado, reloadKey,
    rastro, paradas, alvos, mostrarRastro, setMostrarRastro, mostrarParadas, setMostrarParadas, carregando,
    cmdSirene, cmdBloqueio, fallbackUrl, motorBloqueado,
    seguir, setSeguir, flyPara,
    alertaAtivoId, setAlertaAtivoId,
    selecionarVeiculo, limparSelecao, handleVeiculoClick, carregarVeiculo,
    acionar, centralizar, confirmacao, clicarAcaoCritica, cancelarConfirmacao,
    vmAtual, placaSelecionada, desvioSelecionado, alvosEfetivos, alvosFeitos, alvosTotal, placaColorKey: placaColor,
    paradoMin, pontoMaisProximo,
  };
}

// ── Main Component ────────────────────────────────────────────────────
export default function MonitorV2({ cliente, clientes, clienteAtivoId, veiculos: veiculosBase, alertasIniciais, fonteAlertas = "central", hrefBaseClientes = "/central-v2" }: Props) {
  // Fix pos-revisao (2026-08-22): as acoes de operador (Correto/Falso/Resolver
  // todos/Limpar avisos) tem que escrever na MESMA tabela de onde o alerta
  // veio -- senao viram no-op silencioso (ver acoes-alertas.ts). Constante,
  // nao muda depois de montado (fonteAlertas vem de prop fixa por render).
  const tabelaAlertas: TabelaAlertas = fonteAlertas === "romaneio" ? "alertas_romaneio" : "alertas";
  const [alertas, setAlertas] = useState<AlertaEnriquecido[]>(alertasIniciais);
  const alertasRef = useRef<AlertaEnriquecido[]>(alertasIniciais);
  const [veiculosMapa, setVeiculosMapa] = useState<VeiculoMapa[]>([]);

  // Track/stops/alvos
  const [alvosGlobais, setAlvosGlobais] = useState<PontoEntrega[]>([]);
  // Pontos de entrega de TODA a frota — exibidos quando nenhum veículo está selecionado
  const [horas, setHoras] = useState<(typeof PERIODOS)[number]>(24);

  // Camadas de risco (favelas, tiroteios, roubo de carga) + perímetros das bases
  const [favelas, setFavelas] = useState<GeoJsonCollection | null>(null);
  const [tiroteios, setTiroteios] = useState<Tiroteio[]>([]);
  const [rouboCarga, setRouboCarga] = useState<GeoJsonCollection | null>(null);
  const [bases, setBases] = useState<GeoJsonCollection | null>(null);

  // Map controls (compartilhados pelos 2 paineis — controles gerais de
  // toolbar, nao ligados a um veiculo especifico)
  const [zoomCmd, setZoomCmd] = useState<{ zoom: number; g: number } | null>(null);
  const [gatilhoFrota, setGatilhoFrota] = useState(0);
  const [zoomAtual, setZoomAtual] = useState(11);
  const gatilhoRef = useRef(0);

  // Foco de veiculo — 2 instancias independentes (ver usePainelFoco), uma
  // por painel do split view. Fora do split, so painel1 e usado (equivale a
  // selecao unica de sempre, no painel esquerdo/unico).
  const painel1 = usePainelFoco({ veiculosMapa, veiculosBase, alertas, alvosGlobais, horas });
  const painel2 = usePainelFoco({ veiculosMapa, veiculosBase, alertas, alvosGlobais, horas });

  // UI
  const [vista, setVista] = useState<"tudo" | "desvios">("tudo");
  // Mapa de notificação (apito + faixa pulsante de desvio no mapa) continua
  // por cliente -- escopo DIFERENTE da aba "Desvios" acima (essa é fixa/
  // global pra qualquer cliente; apito/faixa continuam respeitando só o que
  // cada operação pediu pra ser avisada, ver TIPOS_NOTIFICAM_POR_CLIENTE).
  const tiposNotificamCliente = TIPOS_NOTIFICAM_POR_CLIENTE[cliente] ?? [];
  const [filtroComm, setFiltroComm] = useState<number | null>(null);
  const [busca, setBusca] = useState("");
  const [comboAberto, setComboAberto] = useState(false);
  const [novosIdsArr, setNovosIdsArr] = useState<string[]>([]);
  // Último lote de alertas notificáveis NOVOS vindos do poll (ids que não
  // existiam no poll anterior). seq muda a cada lote não vazio, pra o
  // AvisoDesvioTopo reagir mesmo se os ids se repetirem entre painéis.
  const [ultimoLoteNovos, setUltimoLoteNovos] = useState<{ ids: string[]; seq: number }>({ ids: [], seq: 0 });
  // Motivo do alerta truncado (nowrap+ellipsis) fica ilegivel quando e longo —
  // toggle por card pra expandir/recolher o texto completo sob demanda.
  const [motivosExpandidos, setMotivosExpandidos] = useState<Set<string>>(new Set());
  // So um menu de motivo de falso positivo pode estar aberto por vez em toda
  // a lista (mesmo padrao de alertaAtivoId) -- string|null, nao Set/boolean
  // por card. Chave "p1:<id>"/"p2:<id>" (lado do split + id), ver renderCardAlerta.
  const [menuFalsoAbertoId, setMenuFalsoAbertoId] = useState<string | null>(null);
  const toggleMotivoExpandido = useCallback((id: string) => {
    setMotivosExpandidos(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const [confirmarResolver, setConfirmarResolver] = useState(false);
  const [resolvendoTodos, startResolver] = useTransition();
  // "Limpar avisos" — irmao de "Resolver todos", mas so tira da tela (ver
  // limparVarios em acoes-alertas.ts). Estado de confirmacao/transicao
  // separado de proposito: os 2 botoes ficam lado a lado, cada um com seu
  // proprio fluxo de confirmar/cancelar.
  const [confirmarLimpar, setConfirmarLimpar] = useState(false);
  const [limpandoTodos, startLimpar] = useTransition();
  const [avisoRecentes, setAvisoRecentes] = useState<{ acao: "resolver" | "limpar"; quantidade: number } | null>(null);
  // Achado real 13/08 (usuario reportou "botao de limpar nao funciona"):
  // handleResolverTodos/handleLimparTodos removiam os alertas da TELA antes
  // mesmo de saber se o servidor confirmou (optimistic update), e nunca
  // checavam o retorno de resolverVarios/limparVarios -- se a sessao tivesse
  // expirado (erro: "Sessao expirada.") ou o update no banco falhasse por
  // qualquer motivo, os alertas sumiam da tela mas NUNCA eram de fato
  // fechados no banco, voltando no proximo reload/revalidate. Silencioso:
  // parecia que o botao "nao fazia nada" (ou fazia e desfazia sozinho).
  // Agora guarda o erro pra reverter a remocao otimista e avisar o operador.
  const [erroAcaoMassa, setErroAcaoMassa] = useState<string | null>(null);

  // Achado real 30/08 (varredura de sistema): falha de rede nos dois polls
  // principais (alertas, posições do mapa) era engolida em silêncio (catch
  // vazio) -- se o endpoint caísse por mais tempo (deploy, timeout, erro 5xx
  // persistente), a tela continuava mostrando os últimos dados como se
  // estivessem em dia, indefinidamente, sem nenhum sinal pro operador.
  // Guarda o timestamp do último poll bem-sucedido (qualquer um dos dois) --
  // usado só pra mostrar um aviso discreto quando passa muito tempo sem
  // atualização real, não muda nenhum comportamento de dado/detecção.
  const [ultimoPollOk, setUltimoPollOk] = useState<number>(Date.now());
  // Tick só pra forçar reavaliação do indicador de dado desatualizado --
  // se os polls ficarem falhando, nenhum outro setState dispara re-render
  // pra mostrar que o tempo parado está crescendo.
  const [, forcarTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forcarTick(x => x + 1), 20_000);
    return () => clearInterval(t);
  }, []);
  const LIMIAR_DADO_DESATUALIZADO_MS = 90_000;
  const dadoDesatualizado = Date.now() - ultimoPollOk > LIMIAR_DADO_DESATUALIZADO_MS;

  // Filtro por tipo de alerta (sidebar) — multi-select
  const [filtroTipos, setFiltroTipos] = useState<Set<string>>(new Set());

  // Grupos de frota Unitrac (gvc/gvn) — ex.: "H LOG SERVIÇOS", "PALETEIRAS", "COZINHA"
  const [grupos, setGrupos] = useState<{ gvc: number; gvn: string; veiculos: { placa: string; cv: string }[] }[]>([]);
  const [gruposOcultos, setGruposOcultos] = useState<Set<number>>(new Set());
  // Chips de grupo+tipo colapsados por padrão — clientes com muitos grupos/tipos
  // (ex.: Benassi com 7 grupos + 8 tipos) enchiam a sidebar de pilulas antes
  // mesmo de chegar na lista de alertas.
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);

  // "Outros avisos" -- SEMPRE comeca fechado a cada carregamento (nao
  // persiste em localStorage, ao contrario de filtrosAbertos): decisão
  // deliberada pra nunca "vazar aberto" e voltar a competir por atencao
  // com a lista principal (achado real 20/08, ver spec).
  const [outrosAbertos, setOutrosAbertos] = useState(false);

  // "Ver apenas selecionados" — filtro manual por placa (Configurações), independente
  // dos grupos/tipos. modoSelecionados só entra em vigor quando o usuário confirma
  // no seletor (tela dedicada); a lista de cv's marcados fica salva mesmo desligado.
  const [veiculosSelecionados, setVeiculosSelecionados] = useState<Set<string>>(new Set());
  const [modoSelecionados, setModoSelecionados] = useState(false);
  const [seletorAberto, setSeletorAberto] = useState(false);
  const [buscaSeletor, setBuscaSeletor] = useState("");

  // Split view: mapa "TODOS" e "SELECIONADOS" lado a lado, ao mesmo tempo.
  // splitRatio = largura (0..1) do painel esquerdo ("todos"); arrastavel
  // via SplitDivider. Igual modoSelecionados, NUNCA persiste entre sessoes
  // (mesmo motivo: evita ficar "preso" num layout que esconde parte da frota
  // sem o operador perceber ao reabrir a tela dias depois).
  const [splitView, setSplitView] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  // Modo "ROMANEIO": mostra so veiculos com romaneio geocodificado hoje.
  // Deliberadamente NAO persiste (mesmo motivo de modoSelecionados/splitView
  // — evitar ficar "preso" num filtro que esconde parte da frota sem o
  // operador perceber ao reabrir a tela).
  const [modoRomaneio, setModoRomaneio] = useState(false);
  const mapAreaRef = useRef<HTMLDivElement>(null);

  // Theme + satellite (satélite padrão = true)
  const [tema, setTema] = useState<"dark" | "light">("dark");
  const [satelite, setSatelite] = useState(true);
  const [settingsAberto, setSettingsAberto] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  // Fecha só ao clicar fora (não mais em onMouseLeave -- achado real: o
  // gap de 6px entre o botão e o dropdown fazia o menu fechar sozinho se
  // o mouse passasse por ali ao descer, mesmo com o handler no wrapper
  // externo).
  useEffect(() => {
    if (!settingsAberto) return;
    function aoClicarFora(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsAberto(false);
      }
    }
    document.addEventListener("mousedown", aoClicarFora);
    return () => document.removeEventListener("mousedown", aoClicarFora);
  }, [settingsAberto]);
  // Visibilidade das camadas de risco
  const [camFavelas, setCamFavelas] = useState(true);
  const [camTiroteios, setCamTiroteios] = useState(true);
  const [camRouboCarga, setCamRouboCarga] = useState(true);
  const [camTrafego, setCamTrafego] = useState(false);
  const [legendaAberta, setLegendaAberta] = useState(false);

  // Panico overlay
  const [panicoAlerta, setPanicoAlerta] = useState<AlertaEnriquecido | null>(null);
  const panicoVistosRef = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Carrega TODAS as configurações salvas no localStorage (roda uma vez na montagem)
  useEffect(() => {
    const tema = localStorage.getItem("transmonseg-tema") as "dark" | "light" | null;
    if (tema === "light") { document.documentElement.setAttribute("data-theme", "light"); setTema("light"); }
    // Satélite: padrão true — só desativa se usuário salvou "false" explicitamente
    if (localStorage.getItem("transmonseg-sat") === "false") setSatelite(false);
    if (localStorage.getItem("transmonseg-favelas") === "false") setCamFavelas(false);
    if (localStorage.getItem("transmonseg-tiroteios") === "false") setCamTiroteios(false);
    if (localStorage.getItem("transmonseg-roubo") === "false") setCamRouboCarga(false);
    if (localStorage.getItem("transmonseg-trafego") === "true") setCamTrafego(true);
    if (localStorage.getItem("transmonseg-legenda") === "true") setLegendaAberta(true);
    const vistaS = localStorage.getItem("transmonseg-vista");
    // "critico" e "foco" sao valores legados (pre-rename da 2a aba pra
    // "Desvios" fixa em 27/08, task A1) — tratados como "desvios" pra nao
    // perder a preferencia salva de quem ja usava.
    if (vistaS === "tudo") setVista("tudo");
    else if (vistaS === "critico" || vistaS === "foco" || vistaS === "desvios") setVista("desvios");
    const tiposS = localStorage.getItem("transmonseg-filtro-tipos");
    if (tiposS) { try { setFiltroTipos(new Set(JSON.parse(tiposS))); } catch { /* ignore */ } }
    const gruposOcultosS = localStorage.getItem("transmonseg-grupos-ocultos");
    if (gruposOcultosS) { try { setGruposOcultos(new Set(JSON.parse(gruposOcultosS))); } catch { /* ignore */ } }
    const veiculosSelS = localStorage.getItem("transmonseg-veiculos-selecionados");
    if (veiculosSelS) { try { setVeiculosSelecionados(new Set(JSON.parse(veiculosSelS))); } catch { /* ignore */ } }
    // modoSelecionados NUNCA persiste entre carregamentos — deliberado (achado
    // ao vivo 06/07: filtro ficou ligado com so 5 veiculos marcados e escondeu
    // a frota inteira, incluindo alertas ativos de OUTROS veiculos, sem que
    // ninguem percebesse ate reabrir a tela dias depois). A lista de veiculos
    // marcados continua salva pra reativar rapido, mas o modo em si sempre
    // comeca desligado a cada sessao — precisa de um clique consciente.
  }, []);

  const setTemaComPersistencia = useCallback((novo: "dark" | "light") => {
    localStorage.setItem("transmonseg-tema", novo);
    document.documentElement.setAttribute("data-theme", novo === "light" ? "light" : "");
    setTema(novo);
  }, []);

  const setSateliteComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-sat", String(v));
    setSatelite(v);
  }, []);

  const setCamFavelasComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-favelas", String(v));
    setCamFavelas(v);
  }, []);

  const setCamTiroteiosComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-tiroteios", String(v));
    setCamTiroteios(v);
  }, []);

  const setCamRouboCargaComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-roubo", String(v));
    setCamRouboCarga(v);
  }, []);

  const setCamTrafegoComPersistencia = useCallback((v: boolean) => {
    localStorage.setItem("transmonseg-trafego", String(v));
    setCamTrafego(v);
  }, []);

  const toggleLegenda = useCallback(() => {
    setLegendaAberta(v => {
      const next = !v;
      localStorage.setItem("transmonseg-legenda", String(next));
      return next;
    });
  }, []);

  const setVistaComPersistencia = useCallback((v: "tudo" | "desvios") => {
    localStorage.setItem("transmonseg-vista", v);
    setVista(v);
  }, []);

  const toggleFiltroTipo = useCallback((tipo: string) => {
    setFiltroTipos(prev => {
      const next = new Set(prev);
      if (next.has(tipo)) next.delete(tipo); else next.add(tipo);
      localStorage.setItem("transmonseg-filtro-tipos", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const toggleGrupoOculto = useCallback((gvc: number) => {
    setGruposOcultos(prev => {
      const next = new Set(prev);
      if (next.has(gvc)) next.delete(gvc); else next.add(gvc);
      localStorage.setItem("transmonseg-grupos-ocultos", JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Selecao vazia sempre desliga o filtro junto — evita o estado fantasma
  // "FILTRO: 0 VEÍC." ativo sem nenhum veiculo escolhido (ex.: usuario clicou
  // "Limpar" no seletor e fechou sem clicar "Mostrar todos").
  const salvarVeiculosSelecionados = useCallback((next: Set<string>) => {
    setVeiculosSelecionados(next);
    localStorage.setItem("transmonseg-veiculos-selecionados", JSON.stringify([...next]));
    if (next.size === 0) setModoSelecionados(false);
  }, []);

  const toggleVeiculoSelecionado = useCallback((cv: string) => {
    setVeiculosSelecionados(prev => {
      const next = new Set(prev);
      if (next.has(cv)) next.delete(cv); else next.add(cv);
      localStorage.setItem("transmonseg-veiculos-selecionados", JSON.stringify([...next]));
      if (next.size === 0) setModoSelecionados(false);
      return next;
    });
  }, []);

  // Deliberadamente NAO persiste em localStorage (ver comentario no useEffect
  // de carregamento) — o modo sempre volta a "desligado" numa nova sessao.
  const setModoSelecionadosSessao = useCallback((v: boolean) => {
    setModoSelecionados(v);
  }, []);

  // Traduz a escolha de 4 estados do EscopoMapaSwitcher pros booleans que ja
  // existiam (modoSelecionados + splitView) + o novo modoRomaneio — nao
  // substitui nada, so orquestra os 3.
  const escolherEscopoMapa = useCallback((modo: EscopoMapa) => {
    if (modo === "ambos") {
      setSplitView(true);
      setModoRomaneio(false);
      return;
    }
    setSplitView(false);
    if (modo === "romaneio") {
      setModoRomaneio(true);
      setModoSelecionadosSessao(false);
      return;
    }
    setModoRomaneio(false);
    setModoSelecionadosSessao(modo === "selecionados");
  }, [setModoSelecionadosSessao, setModoRomaneio]);

  const tocarPanico = useCallback(() => {
    try {
      const ctx = audioCtxRef.current ?? new AudioContext();
      audioCtxRef.current = ctx;
      ctx.resume();
      const tocar = (t0: number, freq: number, dur: number) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = "sawtooth";
        o.frequency.setValueAtTime(freq, t0);
        o.frequency.linearRampToValueAtTime(freq * 0.6, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.5, t0 + 0.05);
        g.gain.linearRampToValueAtTime(0.5, t0 + dur - 0.05);
        g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
        o.start(t0); o.stop(t0 + dur);
      };
      const n = ctx.currentTime;
      for (let i = 0; i < 3; i++) tocar(n + i * 0.55, 1200, 0.45);
    } catch { /* sem audio */ }
  }, []);

  // ── Theme tokens ── (26/09: fonte unica em design.ts; ver comentario la)
  const T = useMemo(() => temaT(tema), [tema]);

  const baseTokens = tema === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
  const mapTokens = satelite
    ? { ...baseTokens, tileUrl: SAT_TILE_URL, tileSubdomains: SAT_TILE_SUBDOMAINS }
    : baseTokens;

  // Botao de acao do cartao do veiculo: capsula 30px neutra; ativo = azul.
  function drawerOpBtn(active: boolean): React.CSSProperties {
    return {
      height: 30, padding: "0 12px", borderRadius: RAIO.capsule, cursor: "pointer",
      background: active ? T.accentDim : T.surface2,
      border: "none",
      color: active ? T.accent : T.text,
      fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
      transition: "background .15s, color .15s",
      fontFamily: FONT_SANS,
    };
  }

  // ── Polls (sem Supabase Realtime) ────────────────────────────────────
  // Migração pro Contabo (25/07): o motor roda a cada ~30s de verdade (2 jobs
  // de pg_cron — um no minuto cheio, outro com pg_sleep(30) antes de chamar
  // /api/motor). O broadcast via WebSocket do Supabase Realtime era só um
  // atalho pra avisar o painel que tinha dado novo; no Contabo confiamos só
  // no poll, que já existia como fallback (antes 45s) — ajustado pra 30s
  // pra bater mais perto do ritmo real do motor. Mais simples de manter,
  // sem precisar recriar o Realtime na nova stack.
  useEffect(() => {
    const endpointAlertas = fonteAlertas === "romaneio" ? "/api/alertas-romaneio" : "/api/alertas";
    const poll = async () => {
      try {
        const res = await fetch(`${endpointAlertas}?cliente=${encodeURIComponent(cliente)}`);
        if (!res.ok) return;
        const data: { alertas?: AlertaEnriquecido[] } = await res.json();
        const novos = data.alertas ?? [];
        const tiposQueNotificam = TIPOS_NOTIFICAM_POR_CLIENTE[cliente] ?? [];
        const ehNotificavel = (a: AlertaEnriquecido) => a.tipo === "panico" || tiposQueNotificam.includes(a.tipo);
        const idsAntes = new Set(alertasRef.current
          .filter(a => ehNotificavel(a) && a.status === "ativo").map(a => a.id));
        const novosParaNotificar = novos.filter(a => ehNotificavel(a) && a.status === "ativo" && !idsAntes.has(a.id));
        if (novosParaNotificar.length > 0) {
          setNovosIdsArr(arr => [...arr, ...novosParaNotificar.map(a => a.id)]);
          setUltimoLoteNovos(prev => ({
            ids: novosParaNotificar.filter(a => a.tipo !== "panico").map(a => a.id),
            seq: prev.seq + 1,
          }));

          const panicos = novosParaNotificar.filter(a => a.tipo === "panico" && !panicoVistosRef.current.has(a.id));
          if (panicos.length > 0) {
            panicos.forEach(a => panicoVistosRef.current.add(a.id));
            setPanicoAlerta(panicos[0]);
            tocarPanico();
          }
        }
        alertasRef.current = novos;
        setAlertas(novos);
        setUltimoPollOk(Date.now());
      } catch { /* ignore -- ver ultimoPollOk pro indicador de dado desatualizado */ }
    };
    poll();
    const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
  }, [cliente, fonteAlertas]);

  // Mapa: a fonte do alerta que colore o marcador acompanha a fonte da tela
  // (?fonte=romaneio em /central-romaneio). Sem isso, o mapa da tela nova
  // mostrava o veredito da CENTRAL — carro marcado pela Central colorido sem
  // card correspondente na lista, e alerta que só o pipeline novo viu sem
  // colorir nada, numa tela cujo propósito é justamente comparar as duas
  // fontes.
  useEffect(() => {
    const qsFonte = fonteAlertas === "romaneio" ? "&fonte=romaneio" : "";
    const poll = async () => {
      try {
        const res = await fetch(`/api/mapa?cliente=${encodeURIComponent(cliente)}${qsFonte}`);
        if (!res.ok) return;
        const data: { veiculos?: VeiculoMapa[] } = await res.json();
        const vs = data.veiculos ?? [];
        // `nivel` vem de posicoes_atuais, escrito SÓ pelo motor da Central
        // (tabela somente-leitura pra este pipeline — nunca escrever lá).
        // corVeiculo (MapaLeafletV2) pinta de vermelho/amarelo por `nivel`
        // OU por `tipo`, então na tela do romaneio o `nivel` da Central
        // reintroduziria exatamente o veredito que acabamos de trocar — e
        // desfaria, no poll seguinte, o feedback otimista de
        // handleResolver/handleFalso (que zera nivel/tipo do marcador).
        // Descartado aqui, no cliente: `nivel` só alimenta cor e zIndex do
        // marcador, nada mais (conferido em MapaLeafletV2:137-138, 987,
        // 1016), então `tipo` — que agora vem de alertas_romaneio — passa a
        // ser a ÚNICA fonte de cor nesta tela.
        setVeiculosMapa(fonteAlertas === "romaneio" ? vs.map(v => ({ ...v, nivel: null })) : vs);
        setUltimoPollOk(Date.now());
      } catch { /* ignore -- ver ultimoPollOk pro indicador de dado desatualizado */ }
    };
    poll();
    const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
  }, [cliente, fonteAlertas]);

  // Grupos de frota Unitrac (gvc/gvn) — fetcha uma vez por cliente
  useEffect(() => {
    if (!cliente) return;
    fetch(`/api/grupos?cliente=${encodeURIComponent(cliente)}`)
      .then(r => r.ok ? r.json() : { grupos: [] })
      .then((d: { grupos?: typeof grupos }) => setGrupos(d.grupos ?? []))
      .catch(() => setGrupos([]));
  }, [cliente]);

  // Bases do cliente (perímetros geográficos) — fetcha uma vez por montagem
  useEffect(() => {
    fetch(`/api/bases?clienteId=${encodeURIComponent(clienteAtivoId)}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: GeoJsonCollection | null) => { if (d) setBases(d); })
      .catch(() => {});
  }, [clienteAtivoId]);

  // Camadas de risco: favelas (estática), roubo-carga (diária), tiroteios (30min)
  useEffect(() => {
    fetch("/api/favelas")
      .then(r => r.ok ? r.json() : null)
      .then((d: GeoJsonCollection | null) => { if (d) setFavelas(d); })
      .catch(() => {});
    fetch("/api/roubo-carga")
      .then(r => r.ok ? r.json() : null)
      .then((d: { geojson?: GeoJsonCollection } | null) => { if (d?.geojson) setRouboCarga(d.geojson); })
      .catch(() => {});
    const buscarTiroteios = () => {
      fetch("/api/tiroteios")
        .then(r => r.ok ? r.json() : null)
        .then((d: { tiroteios?: Tiroteio[] } | null) => { if (d?.tiroteios) setTiroteios(d.tiroteios); })
        .catch(() => {});
    };
    buscarTiroteios();
    const t = setInterval(buscarTiroteios, 30 * 60_000);
    return () => clearInterval(t);
  }, []);

  // Pontos de entrega globais — busca em segundo plano, lotes de 50
  useEffect(() => {
    if (veiculosBase.length === 0) return;
    const lotes: { cv: string }[][] = [];
    for (let i = 0; i < veiculosBase.length; i += 50)
      lotes.push(veiculosBase.slice(i, i + 50));
    const buscar = async () => {
      try {
        const results = await Promise.all(
          lotes.map(lote => {
            const qs = lote.map(v => `cv=${encodeURIComponent(v.cv)}`).join("&");
            return fetch(`/api/alvos?${qs}`).then(r => r.ok ? r.json() : { pontos: [] });
          })
        );
        const todos = results.flatMap((d: { pontos?: PontoEntrega[] }) => d.pontos ?? []);
        setAlvosGlobais(todos);
      } catch {/* silencioso */}
    };
    buscar();
    const t = setInterval(buscar, 5 * 60_000);
    return () => clearInterval(t);
  }, [veiculosBase]);

  // Click no mapa vazio: apenas fecha popups, nao deseleciona veiculo
  const stableHandleMapaVazio = useCallback(() => {}, []);

  // ── Alert actions ────────────────────────────────────────────────────
  // Resolver/marcar falso positivo só tirava o card da sidebar — a cor do
  // veiculo no mapa vem de posicoes_atuais.nivel, escrito só pelo motor
  // (a cada 1min), então o marcador continuava vermelho até o próximo ciclo.
  // Agora, se não sobrar OUTRO alerta ativo pro mesmo veículo, atualiza a
  // cor na hora (otimista); se a condição real ainda existir, o motor
  // recria o alerta no próximo ciclo e a cor volta — corretamente.
  // Achado real 30/08 (varredura de sistema): ao contrário das ações em
  // massa (handleResolverTodos/handleLimparTodos, abaixo), estas duas
  // descartavam o resultado do servidor -- se a sessão expirasse ou o
  // update falhasse no banco, o card já tinha sumido e o carro já tinha
  // perdido a cor otimisticamente, sem NADA avisar o operador. O alerta
  // continuava ativo no servidor até o próximo poll (até 30s depois)
  // reintroduzir o card, sem explicação. Mesmo tratamento de
  // erroAcaoMassa já usado pelas ações em massa: se falhar, devolve o
  // alerta pra tela e mostra o aviso.
  const handleResolver = useCallback(async (id: string) => {
    let alvoRemovido: AlertaEnriquecido | undefined;
    setAlertas(a => {
      const alvo = a.find(x => x.id === id);
      alvoRemovido = alvo;
      const restante = a.filter(x => x.id !== id);
      if (alvo && !restante.some(x => x.cv === alvo.cv)) {
        setVeiculosMapa(vs => vs.map(v => v.cv === alvo.cv ? { ...v, nivel: null, tipo: null } : v));
      }
      return restante;
    });
    const resultado = await resolverAlerta(id, tabelaAlertas);
    if (resultado.erro || !resultado.ok) {
      if (alvoRemovido) {
        const alvo = alvoRemovido;
        setAlertas(a => (a.some(x => x.id === id) ? a : [...a, alvo]));
      }
      setErroAcaoMassa(resultado.erro ?? "Não foi possível resolver o alerta.");
    }
  }, [tabelaAlertas]);

  const handleFalso = useCallback(async (id: string, categoria: CategoriaFalso, detalhe: string) => {
    let alvoRemovido: AlertaEnriquecido | undefined;
    setAlertas(a => {
      const alvo = a.find(x => x.id === id);
      alvoRemovido = alvo;
      const restante = a.filter(x => x.id !== id);
      if (alvo && !restante.some(x => x.cv === alvo.cv)) {
        setVeiculosMapa(vs => vs.map(v => v.cv === alvo.cv ? { ...v, nivel: null, tipo: null } : v));
      }
      return restante;
    });
    const resultado = await marcarFalsoComCategoria(id, categoria, tabelaAlertas, detalhe);
    if (resultado.erro || !resultado.ok) {
      if (alvoRemovido) {
        const alvo = alvoRemovido;
        setAlertas(a => (a.some(x => x.id === id) ? a : [...a, alvo]));
      }
      setErroAcaoMassa(resultado.erro ?? "Não foi possível marcar o alerta como falso.");
    }
  }, [tabelaAlertas]);

  // ── Map controls ─────────────────────────────────────────────────────
  const cmdZoom = useCallback((z: number) => {
    gatilhoRef.current += 1;
    setZoomCmd({ zoom: z, g: gatilhoRef.current });
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────
  const cvParaGrupo = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of grupos) for (const v of g.veiculos) m.set(v.cv, g.gvc);
    return m;
  }, [grupos]);

  // Veiculos com romaneio geocodificado hoje — fonte do modo "ROMANEIO" do
  // EscopoMapaSwitcher (ver docs/superpowers/specs/2026-07-18-modo-romaneio-escopo-mapa-design.md).
  const cvsComRomaneio = useMemo(
    () => new Set(veiculosMapa.filter(v => v.tem_romaneio_hoje).map(v => v.cv)),
    [veiculosMapa]
  );

  // Extraido de proposito (nao so um useMemo): o split view precisa das DUAS
  // variantes (com e sem o filtro de selecionados) simultaneamente, pros 2
  // paineis lado a lado — ver vmTodos/vmSelecionados abaixo. cvForcado: o
  // veiculo selecionado NESSE painel (painel1/painel2) sempre permanece
  // visivel, mesmo que outros filtros o esconderiam.
  const aplicarFiltrosVeiculos = useCallback((comSelecao: boolean, cvForcado: string | null, comRomaneio = false): VeiculoMapa[] => {
    let base = filtroComm ? veiculosMapa.filter(v => v.atraso_min <= filtroComm) : veiculosMapa;
    if (comSelecao && veiculosSelecionados.size > 0) {
      // Veículo selecionado sempre permanece visível, mesmo fora da lista escolhida
      base = base.filter(v => veiculosSelecionados.has(v.cv) || v.cv === cvForcado);
    }
    if (comRomaneio) {
      // Veículo selecionado sempre permanece visível, mesmo sem romaneio hoje
      base = base.filter(v => cvsComRomaneio.has(v.cv) || v.cv === cvForcado);
    }
    if (gruposOcultos.size > 0) {
      // Veículo selecionado sempre permanece visível no mapa, mesmo se o grupo dele estiver oculto
      base = base.filter(v => {
        const g = cvParaGrupo.get(v.cv);
        return g === undefined || !gruposOcultos.has(g) || v.cv === cvForcado;
      });
    }
    if (filtroTipos.size > 0) {
      const cvsComTipo = new Set(alertas.filter(a => filtroTipos.has(a.tipo)).map(a => a.cv));
      // Veículo selecionado sempre permanece visível no mapa, mesmo sem o tipo filtrado
      base = base.filter(v => cvsComTipo.has(v.cv) || v.cv === cvForcado);
    }
    if (!cvForcado || base.some(v => v.cv === cvForcado)) return base;
    // Veículo selecionado via alerta mas fora do feed ao vivo — injeta posição do alerta
    const al = alertas.find(a => a.cv === cvForcado && a.lat && a.lng);
    if (!al) return base;
    const sintetico: VeiculoMapa = {
      placa: al.placa, cv: al.cv,
      nivel: "vermelho",
      velocidade: al.velocidade ?? 0, ignicao: al.ignicao ?? false,
      atraso_min: al.atraso_min ?? 999, tipo: al.tipo,
      lat: al.lat, lng: al.lng, local: al.local, rumo: null,
    };
    return [...base, sintetico];
  }, [veiculosMapa, filtroComm, veiculosSelecionados, cvsComRomaneio, gruposOcultos, cvParaGrupo, filtroTipos, alertas]);

  const vmFiltrado: VeiculoMapa[] = useMemo(
    () => aplicarFiltrosVeiculos(modoSelecionados, painel1.cvSelecionado, modoRomaneio),
    [aplicarFiltrosVeiculos, modoSelecionados, painel1.cvSelecionado, modoRomaneio]
  );
  // Paineis do split view: "todos" ignora o filtro de selecionados sempre;
  // "selecionados" aplica ele sempre — independente do modoSelecionados
  // usado pelo mapa unico (fora do split). Cada painel forca a visibilidade
  // do SEU proprio veiculo selecionado (painel1 -> todos, painel2 -> selecionados).
  const vmTodos: VeiculoMapa[] = useMemo(
    () => aplicarFiltrosVeiculos(false, painel1.cvSelecionado),
    [aplicarFiltrosVeiculos, painel1.cvSelecionado]
  );
  const vmSelecionados: VeiculoMapa[] = useMemo(
    () => aplicarFiltrosVeiculos(true, painel2.cvSelecionado),
    [aplicarFiltrosVeiculos, painel2.cvSelecionado]
  );

  const alertasFiltrados = alertas.filter(a => {
    if (vista === "desvios" && !TIPOS_ABA_DESVIOS.includes(a.tipo)) return false;
    if (filtroTipos.size > 0 && !filtroTipos.has(a.tipo)) return false;
    if (modoSelecionados && veiculosSelecionados.size > 0 && !veiculosSelecionados.has(a.cv)) return false;
    if (modoRomaneio && !cvsComRomaneio.has(a.cv)) return false;
    if (gruposOcultos.size > 0) {
      const g = cvParaGrupo.get(a.cv);
      if (g !== undefined && gruposOcultos.has(g)) return false;
    }
    return true;
  });

  // Ordena só por prioridade — seleção não move o card, só brilha no lugar
  const alertasOrdenadosCompleto = [...alertasFiltrados].sort((a, b) => prioAlerta(b) - prioAlerta(a));
  // Achado real 20/08 (revisão de branch inteira): quando o operador escolhe
  // um chip de tipo explícito (filtroTipos), isso é uma decisão deliberada,
  // não "ruído ambiente" -- não faz sentido separar em "Outros avisos" algo
  // que o operador pediu explicitamente pra ver. Mesmo raciocínio já usado
  // pra excluir a coluna SELECIONADOS do split view dessa separação (ver
  // spec). filtroTipos.size > 0 pula a separação inteiramente.
  const { principais: alertasOrdenados, outros: outrosAvisos } = filtroTipos.size > 0
    ? { principais: alertasOrdenadosCompleto, outros: [] as typeof alertasOrdenadosCompleto }
    : separarOutrosAvisos(alertasOrdenadosCompleto);

  // "Resolver todos" nunca inclui desvio nem os 3 tipos de parada (ver
  // TIPOS_REVISAO_INDIVIDUAL em ./tipos-alerta) -- exige clique individual por
  // card pra esses, que é a única origem_acao que arma o cooldown de
  // re-disparo nos motores.
  const alertasResolviveisEmMassa = alertasOrdenados.filter(a => !TIPOS_REVISAO_INDIVIDUAL.has(a.tipo));

  // Split view: sidebar mostra 2 secoes independentes (TODOS + SELECIONADOS)
  // em vez de 1 lista unica — mesma logica de vmTodos/vmSelecionados no mapa.
  // Recalculado A PARTE de alertasFiltrados (que respeita modoSelecionados,
  // usado so pelo modo unico fora do split) pra secao TODOS nunca ficar
  // filtrada por selecao — mesma classe de bug ja corrigida na malha de
  // pontos de entrega (alvosGlobaisSelecionados).
  const alertasFiltradosSplitBase = alertas.filter(a => {
    if (vista === "desvios" && !TIPOS_ABA_DESVIOS.includes(a.tipo)) return false;
    if (filtroTipos.size > 0 && !filtroTipos.has(a.tipo)) return false;
    if (gruposOcultos.size > 0) {
      const g = cvParaGrupo.get(a.cv);
      if (g !== undefined && gruposOcultos.has(g)) return false;
    }
    return true;
  });
  const alertasOrdenadosSplitTodosCompleto = [...alertasFiltradosSplitBase].sort((a, b) => prioAlerta(b) - prioAlerta(a));
  // Mesmo raciocínio do bloco não-split acima: filtro de tipo explícito
  // pula a separação "Outros avisos".
  const { principais: alertasOrdenadosSplitTodos, outros: outrosAvisosSplit } = filtroTipos.size > 0
    ? { principais: alertasOrdenadosSplitTodosCompleto, outros: [] as typeof alertasOrdenadosSplitTodosCompleto }
    : separarOutrosAvisos(alertasOrdenadosSplitTodosCompleto);
  const alertasOrdenadosSplitSelecionados = veiculosSelecionados.size > 0
    ? alertasOrdenadosSplitTodosCompleto.filter(a => veiculosSelecionados.has(a.cv))
    : alertasOrdenadosSplitTodosCompleto;

  // Resolve os alertas VISÍVEIS na aba atual (Crítico/Tudo), não só
  // os críticos — antes travava em nivel==="critico" e nao fazia nada nas
  // outras abas.
  const handleResolverTodos = useCallback(() => {
    const alvos = alertasResolviveisEmMassa;
    if (alvos.length === 0) return;
    setAvisoRecentes(null);
    setErroAcaoMassa(null);
    // Guard de idade minima (achado real 08/08, caso TTH-3C94): alerta
    // recem-nascido nunca some da tela por acao em massa -- ver
    // docs/superpowers/specs/2026-08-09-idade-minima-acao-massa-design.md.
    // Espelha o guard do servidor (acoes-alertas.ts) pra nunca nem piscar
    // um alerta jovem como removido -- servidor continua sendo a
    // autoridade final, isso e' so pra UX consistente.
    // elegivelParaAcaoMassa (nao minutosDesde, que arredonda pra exibicao)
    // -- reusa a MESMA funcao pura do servidor, evita o servidor rejeitar
    // um id que o cliente achou elegivel por causa de arredondamento no
    // limite exato dos 5min (minutosDesde arredonda: 4min36s vira "5min"
    // no texto do card, mas o servidor compara sem arredondar).
    const agora = new Date();
    const elegiveis = alvos.filter(a => elegivelParaAcaoMassa(a.desde, agora));
    const recentes = alvos.length - elegiveis.length;
    if (elegiveis.length === 0) {
      if (recentes > 0) setAvisoRecentes({ acao: "resolver", quantidade: recentes });
      setConfirmarResolver(false);
      return;
    }
    startResolver(async () => {
      const ids = new Set(elegiveis.map(a => a.id));
      const cvsResolvidos = new Set(elegiveis.map(a => a.cv));
      setAlertas(a => {
        const restante = a.filter(x => !ids.has(x.id));
        const cvsAindaComAlerta = new Set(restante.map(x => x.cv));
        setVeiculosMapa(vs => vs.map(v =>
          cvsResolvidos.has(v.cv) && !cvsAindaComAlerta.has(v.cv) ? { ...v, nivel: null, tipo: null } : v
        ));
        return restante;
      });
      const resultado = await resolverVarios(elegiveis.map(a => a.id), tabelaAlertas);
      if (resultado.erro || !resultado.ok) {
        // Servidor nao confirmou -- devolve os alertas pra tela (senao
        // ficam invisiveis ate o proximo reload, dando a impressao de que
        // "resolveu" quando na verdade nada mudou no banco).
        setAlertas(a => {
          const idsPresentes = new Set(a.map(x => x.id));
          const devolvidos = elegiveis.filter(e => !idsPresentes.has(e.id));
          return devolvidos.length > 0 ? [...a, ...devolvidos] : a;
        });
        setErroAcaoMassa(resultado.erro ?? "Não foi possível resolver os alertas.");
        setConfirmarResolver(false);
        return;
      }
      if (recentes > 0) setAvisoRecentes({ acao: "resolver", quantidade: recentes });
      setConfirmarResolver(false);
    });
  }, [alertasResolviveisEmMassa, tabelaAlertas]);

  // Limpa os alertas VISÍVEIS na aba atual (Crítico/Tudo) — so tira da tela,
  // SEM afirmar que foi revisado caso a caso (diferente de "Resolver todos":
  // não chama registrarCasosDesvioRevisao, não alimenta calibração). Ver
  // limparVarios em acoes-alertas.ts.
  const handleLimparTodos = useCallback(() => {
    const alvos = alertasOrdenados;
    if (alvos.length === 0) return;
    setAvisoRecentes(null);
    setErroAcaoMassa(null);
    // Mesmo guard de idade minima de handleResolverTodos acima.
    // elegivelParaAcaoMassa (nao minutosDesde, que arredonda pra exibicao)
    // -- reusa a MESMA funcao pura do servidor, evita o servidor rejeitar
    // um id que o cliente achou elegivel por causa de arredondamento no
    // limite exato dos 5min (minutosDesde arredonda: 4min36s vira "5min"
    // no texto do card, mas o servidor compara sem arredondar).
    const agora = new Date();
    const elegiveis = alvos.filter(a => elegivelParaAcaoMassa(a.desde, agora));
    const recentes = alvos.length - elegiveis.length;
    if (elegiveis.length === 0) {
      if (recentes > 0) setAvisoRecentes({ acao: "limpar", quantidade: recentes });
      setConfirmarLimpar(false);
      return;
    }
    startLimpar(async () => {
      const ids = new Set(elegiveis.map(a => a.id));
      const cvsLimpos = new Set(elegiveis.map(a => a.cv));
      setAlertas(a => {
        const restante = a.filter(x => !ids.has(x.id));
        const cvsAindaComAlerta = new Set(restante.map(x => x.cv));
        setVeiculosMapa(vs => vs.map(v =>
          cvsLimpos.has(v.cv) && !cvsAindaComAlerta.has(v.cv) ? { ...v, nivel: null, tipo: null } : v
        ));
        return restante;
      });
      const resultado = await limparVarios(elegiveis.map(a => a.id), tabelaAlertas);
      if (resultado.erro || !resultado.ok) {
        // Mesmo raciocinio de handleResolverTodos: sem isso, sessao expirada
        // ou falha no banco fazia os alertas sumirem da tela sem realmente
        // serem limpos -- pareciam "voltar sozinhos" no proximo reload.
        setAlertas(a => {
          const idsPresentes = new Set(a.map(x => x.id));
          const devolvidos = elegiveis.filter(e => !idsPresentes.has(e.id));
          return devolvidos.length > 0 ? [...a, ...devolvidos] : a;
        });
        setErroAcaoMassa(resultado.erro ?? "Não foi possível limpar os alertas.");
        setConfirmarLimpar(false);
        return;
      }
      if (recentes > 0) setAvisoRecentes({ acao: "limpar", quantidade: recentes });
      setConfirmarLimpar(false);
    });
  }, [alertasOrdenados, tabelaAlertas]);

  // Desvios de rota — faixa dedicada no topo do mapa, sempre visivel independente
  // dos filtros da sidebar (vista/tipo). Ordenado do mais recente pro mais antigo.
  const desviosAtivos = alertas
    .filter(a => tiposNotificamCliente.includes(a.tipo) && a.tipo !== "panico")
    .filter(a => {
      if (modoSelecionados && veiculosSelecionados.size > 0 && !veiculosSelecionados.has(a.cv)) return false;
      if (modoRomaneio && !cvsComRomaneio.has(a.cv)) return false;
      if (gruposOcultos.size === 0) return true;
      const g = cvParaGrupo.get(a.cv);
      return g === undefined || !gruposOcultos.has(g);
    })
    .sort((a, b) => new Date(b.desde).getTime() - new Date(a.desde).getTime());

  // Split view: mesma malha de desviosAtivos, mas SEM o gate de
  // modoSelecionados (que so vale pro modo unico) — a secao TODOS da faixa
  // nunca pode ficar filtrada por selecao (mesma classe de bug ja corrigida
  // na malha de entregas e na lista de alertas da sidebar).
  const desviosAtivosSplitTodos = alertas
    .filter(a => tiposNotificamCliente.includes(a.tipo) && a.tipo !== "panico")
    .filter(a => {
      if (gruposOcultos.size === 0) return true;
      const g = cvParaGrupo.get(a.cv);
      return g === undefined || !gruposOcultos.has(g);
    })
    .sort((a, b) => new Date(b.desde).getTime() - new Date(a.desde).getTime());
  const desviosAtivosSplitSelecionados = veiculosSelecionados.size > 0
    ? desviosAtivosSplitTodos.filter(a => veiculosSelecionados.has(a.cv))
    : desviosAtivosSplitTodos;

  const veiculosBusca = busca.length >= 2
    ? veiculosBase.filter(v => v.placa.toLowerCase().includes(busca.toLowerCase())).slice(0, 8)
    : [];

  const nCriticos = alertas.filter(a => a.nivel === "critico").length;

  // Pontos de entrega exibidos no mapa (camada de fundo, todas as placas) —
  // quando "ver apenas selecionados" está ativo, só mostra os pontos das
  // placas escolhidas. alvosGlobais (não filtrado) continua servindo o
  // progressoPorPlaca e o fallback de alvosEfetivos acima.
  //
  // Calculado À PARTE do modo único (alvosGlobaisMapa abaixo) porque o split
  // view (splitView="ambos") renderiza os DOIS paineis (TODOS + SELECIONADOS)
  // ao mesmo tempo, cada um precisando da sua própria malha de pontos — bug
  // real corrigido: antes os dois paineis compartilhavam o mesmo valor via
  // propsMapaComuns, então ativar "ver apenas selecionados" (modoSelecionados)
  // também filtrava o painel TODOS, escondendo a malha completa da frota nele.
  const alvosGlobaisSelecionados = useMemo(() => {
    if (veiculosSelecionados.size === 0) return alvosGlobais;
    // PontoEntrega não tem cv, só placa — traduz o Set de cv's selecionados pras placas correspondentes
    const placas = new Set(veiculosBase.filter(v => veiculosSelecionados.has(v.cv)).map(v => v.placa));
    return alvosGlobais.filter(a => a.placa && placas.has(a.placa));
  }, [alvosGlobais, veiculosSelecionados, veiculosBase]);

  // Modo único (não-split): mesma regra de sempre, gated por modoSelecionados.
  const alvosGlobaisMapa = modoSelecionados ? alvosGlobaisSelecionados : alvosGlobais;

  // Progresso de entregas por placa (para exibir nos cards de alerta)
  const progressoPorPlaca = useMemo(() => {
    const m = new Map<string, { feitos: number; total: number }>();
    for (const a of alvosGlobais) {
      if (!a.placa) continue;
      const e = m.get(a.placa) ?? { feitos: 0, total: 0 };
      e.total++;
      if (a.feito) e.feitos++;
      m.set(a.placa, e);
    }
    return m;
  }, [alvosGlobais]);

  // Cor de status do veiculo selecionado em cada painel (drawer)
  const placaColorDe = (vmAtual: VeiculoMapa | null) => vmAtual
    ? (vmAtual.ignicao && vmAtual.velocidade > 0 ? T.green : vmAtual.ignicao ? T.accent : T.muted)
    : T.text;

  // Props compartilhadas pelos paineis de mapa (controles gerais, nao
  // ligados a um veiculo especifico). Cada painel (1/2) monta as SUAS
  // proprias props de selecao (cvSelecionado/rastro/paradas/etc, ver
  // propsPainelTodos/propsPainelSelecionados perto do render) — os 2
  // paineis do split view tem cada um seu proprio veiculo selecionado
  // (ver usePainelFoco).
  const propsMapaComuns = {
    bases,
    favelas: camFavelas ? favelas : null,
    tiroteios: camTiroteios ? tiroteios : [],
    rouboCarga: camRouboCarga ? rouboCarga : null,
    gatilhoFrota, zoomCmd,
    onMapaVazioClick: stableHandleMapaVazio,
    mapTokens, tema, satelite, trafego: camTrafego, onZoomChange: setZoomAtual,
  };

  // Card de alerta da sidebar — extraido pra funcao (em vez de JSX inline
  // duplicado) porque o split view precisa da MESMA renderizacao completa
  // em 3 lugares (lista unica fora do split, coluna TODOS e coluna
  // SELECIONADOS dentro do split). Cards SEMPRE com detalhe completo
  // (motivo/progresso/acoes) — pedido explicito do cliente 08/07: "afinar"
  // era sobre a LARGURA DA COLUNA, nao sobre remover informacao do card.
  // `painel` garante que focar o veiculo por esse card selecione no painel1
  // ou painel2 correto — cada painel tem sua propria selecao (usePainelFoco).
  const renderCardAlerta = (
    a: AlertaEnriquecido,
    opts: { painel: ReturnType<typeof usePainelFoco>; index?: number }
  ) => {
    const painel = opts.painel;
    // Stagger pequeno por posicao na lista, com teto pra nao atrasar
    // demais quando ha' muitos alertas. So' tem efeito real na entrada
    // de itens novos: AnimatePresence initial={false} ja suprime a
    // animacao de entrada no primeiro carregamento da pagina.
    const atrasoEntrada = delayEntradaEscalonada(opts.index ?? 0);
    const cor = corStatus(a.nivel, T);
    const ativo = painel.alertaAtivoId === a.id;
    const doCarro = painel.cvSelecionado === a.cv;
    // No split (AMBOS) o mesmo alerta aparece nas 2 laterais: hover e menu
    // Falso sao chaveados por lado+id pra nao vazar pro card gemeo.
    const chaveCard = `${painel === painel2 ? "p2" : "p1"}:${a.id}`;
    const menuFalsoAberto = menuFalsoAbertoId === chaveCard;
    // Hover/foco revelam as acoes via CSS (.card-alerta, globals.css) pra nao
    // re-renderizar o MonitorV2 inteiro (e os mapas) a cada mouseenter.
    const acoesFixas = acoesVisiveis({ ativo, menuFalsoAberto });
    // Clique no card inteiro = o antigo botao Focar (removido 26/09).
    const focar = () => {
      painel.setAlertaAtivoId(a.id);
      painel.selecionarVeiculo(a.cv, a.lat && a.lng ? { lat: a.lat, lng: a.lng } : undefined);
    };
    // Elementos internos (Correto/Falso/menu/ver motivo) nao podem focar junto:
    // onMouseDown com stopPropagation nao impede o click de borbulhar ate o card.
    const pararClique = (e: React.SyntheticEvent) => e.stopPropagation();
    // Faixa de 3px a esquerda carrega o nivel; ativo ganha anel accent e o card
    // do veiculo selecionado (doCarro) um anel accent mais fraco.
    const anel = ativo ? `, 0 0 0 1px ${T.accent}` : doCarro ? `, 0 0 0 1px ${T.accent}55` : "";

    return (
      <motion.div key={a.id}
        layout="position"
        initial={{ opacity: 0, y: -6, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ ...MOLA, delay: atrasoEntrada }}
        onClick={focar}
        onKeyDown={e => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focar(); }
        }}
        data-acoes={acoesFixas ? "on" : undefined}
        role="button"
        tabIndex={0}
        aria-label={`Focar ${a.placa}`}
        className="v2-alert-card card-alerta"
        style={{
          margin: "6px 0", borderRadius: RAIO.panel, padding: "12px 14px",
          background: ativo || doCarro ? T.surface2 : T.card,
          boxShadow: `inset 3px 0 0 ${cor}${anel}`,
          cursor: "pointer",
        }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: cor, flexShrink: 0 }} />
          <span style={{ ...NUM, fontSize: 15, fontWeight: 700, color: T.text }}>
            {a.placa}
          </span>
          {(() => {
            const idade = corIdadeAlerta(a.desde, tema);
            const tituloIdade = idade.cor
              ? `Parado sem revisao ha' muito tempo (detectado ha' ${tempoAtras(a.desde)})`
              : `Detectado ha' ${tempoAtras(a.desde)}`;
            return (
              <span suppressHydrationWarning title={tituloIdade} style={{
                ...NUM, fontSize: 12, color: idade.cor || T.dim, marginLeft: "auto",
                fontWeight: idade.peso,
              }}>
                {tempoAtras(a.desde)}
              </span>
            );
          })()}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "4px 0 6px" }}>
          <span style={{ ...TIPO.footnote, color: cor }}>
            {nomeT(a.tipo)}
          </span>
          {a.tipo === "parada_sem_marcacao" && (
            <span style={{
              fontSize: 12, fontWeight: 600, padding: "1px 8px", borderRadius: RAIO.capsule,
              background: `${T.red}14`, color: T.red,
            }}>
              POSSÍVEL DESVIO
            </span>
          )}
          {a.atraso_min != null && a.atraso_min >= 10 && (
            <span title={`GPS deste veiculo chegou com ${Math.round(a.atraso_min)}min de atraso da origem (Unitrac)`} style={{
              fontSize: 12, fontWeight: 600, padding: "1px 8px", borderRadius: RAIO.capsule,
              background: `${T.yellow}14`, color: T.yellow,
            }}>
              GPS +{Math.round(a.atraso_min)}min
            </span>
          )}
          {a.reabertura && (
            <span title="Novo episodio de desvio neste veiculo: o alerta ja estava aberto e foi reaberto (o horario ao lado e' do episodio atual)" style={{
              fontSize: 12, fontWeight: 600, padding: "1px 8px", borderRadius: RAIO.capsule,
              background: `${T.accent}14`, color: T.accent,
            }}>
              ↻ {a.reabertura}
            </span>
          )}
        </div>
        {a.motivo && (() => {
          const expandido = motivosExpandidos.has(a.id);
          // Heuristica de tamanho (sem medir layout real): sidebar de 190-280px
          // a 13px da ~30-38 caracteres/linha, entao 2 linhas cortam ~60-75.
          // Erra pra oferecer expansao.
          const longoDemaisPraCard = a.motivo.length > 60;
          return (
            <div style={{ margin: "0 0 4px" }}>
              <p style={{
                margin: 0, fontSize: 13, color: T.muted, lineHeight: 1.4,
                ...(expandido ? {} : {
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
                  overflow: "hidden",
                }),
              }}>
                {a.motivo}
              </p>
              {longoDemaisPraCard && (
                <button
                  onMouseDown={e => { e.stopPropagation(); toggleMotivoExpandido(a.id); }}
                  onClick={pararClique}
                  className="v2-btn-tiny"
                  style={{
                    ...BASE_BTN, height: 18, padding: 0, marginTop: 2,
                    fontSize: 12, fontWeight: 600, color: T.accent,
                    justifyContent: "flex-start",
                  }}
                >
                  {expandido ? "ver menos" : "ver motivo completo"}
                </button>
              )}
            </div>
          );
        })()}
        {a.progressoDestinoM != null && (() => {
          const { texto, aproximando } = formatarProgressoDestino(a.progressoDestinoM);
          return (
            <p style={{
              margin: "0 0 2px", fontSize: 12, fontWeight: 600,
              color: aproximando ? T.accent : T.dim,
            }}>
              {texto}
            </p>
          );
        })()}
        {a.placarSombra != null && (
          <p style={{
            margin: "0 0 2px", fontSize: 12, color: T.dim,
          }}>
            {formatarPlacarSombra(a.placarSombra.placar, a.placarSombra.componentes)}
          </p>
        )}
        {a.calibracao != null && (() => {
          const texto = formatarConfiabilidadeDetector(a.calibracao.taxa_falso_positivo);
          if (texto == null) return null;
          return (
            <p style={{
              margin: "0 0 2px", fontSize: 12, color: T.dim,
            }}>
              {texto}
            </p>
          );
        })()}
        {a.local && (
          <p style={{
            margin: "0 0 6px", fontSize: 12, color: T.dim, lineHeight: 1.3,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {a.local}
          </p>
        )}
        {(() => {
          const prog = progressoPorPlaca.get(a.placa);
          if (!prog || prog.total === 0) return null;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
              <span style={{ ...NUM, fontSize: 12, color: T.dim, flexShrink: 0 }}>
                {prog.feitos}/{prog.total} entr.
              </span>
              <div style={{ flex: 1, height: 4, background: T.border, borderRadius: RAIO.capsule, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width: `${prog.total > 0 ? Math.round((prog.feitos / prog.total) * 100) : 0}%`,
                  background: prog.feitos === prog.total ? T.green : T.accent,
                  borderRadius: RAIO.capsule, transition: "width .3s",
                }} />
              </div>
            </div>
          );
        })()}
        <div className="card-alerta-acoes" style={{ gap: 6, flexWrap: "wrap", marginTop: 8, position: "relative" }}>
          <motion.button whileTap={{ scale: 0.92 }}
            onMouseDown={e => { e.stopPropagation(); handleResolver(a.id); }}
            onClick={pararClique}
            className="v2-btn-tiny" style={tinyBtn(T.green, { borderAlpha: "55", bgAlpha: "22" })}>
            Correto
          </motion.button>
          <div onClick={pararClique} onKeyDown={pararClique}>
            <motion.button whileTap={{ scale: 0.92 }}
              onMouseDown={e => { e.stopPropagation(); setMenuFalsoAbertoId(v => v === chaveCard ? null : chaveCard); }}
              className="v2-btn-tiny" style={tinyBtn(T.yellow, { borderAlpha: "40", bgAlpha: "18" })}>
              Falso
            </motion.button>
            <MenuMotivoFalso
              compacto
              larguraDaLinha
              aberto={menuFalsoAberto}
              onFechar={() => setMenuFalsoAbertoId(null)}
              onEscolher={(categoria, detalhe) => handleFalso(a.id, categoria, detalhe)}
            />
          </div>
        </div>
      </motion.div>
    );
  };

  // Cartao flutuante do veiculo selecionado (26/09: era barra de largura
  // total colada no rodape; agora material translucido, max 760px) — extraido pra funcao
  // porque agora existe 1 POR PAINEL (painel1/painel2, ver usePainelFoco):
  // o split view permite selecionar um veiculo DIFERENTE em cada painel ao
  // MESMO TEMPO (pedido explicito do cliente 08/07 — antes so dava pra ter
  // 1 selecao ativa entre os 2 paineis). `pos` e' a caixa do painel em % da
  // area do mapa (mesma conta do AvisoDesvioTopo no split): o cartao fica
  // 12px dentro dela e nunca passa da largura do proprio painel.
  // Altura REAL de cada cartao (p1/p2), medida por ResizeObserver, pro badge
  // de veiculos e a Legenda subirem exatamente acima dele. Ref callback com
  // cleanup (React 19) desconecta o observer ao desmontar; so grava quando a
  // altura arredondada muda (sem loop de setState).
  const [alturaCartao, setAlturaCartao] = useState<{ p1: number; p2: number }>({ p1: 0, p2: 0 });
  const observarCartao = useCallback((chave: "p1" | "p2") => (el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const medir = () => {
      const h = Math.round(el.offsetHeight);
      setAlturaCartao(a => (a[chave] === h ? a : { ...a, [chave]: h }));
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const refCartaoP1 = useMemo(() => observarCartao("p1"), [observarCartao]);
  const refCartaoP2 = useMemo(() => observarCartao("p2"), [observarCartao]);

  const renderDrawer = (
    painel: ReturnType<typeof usePainelFoco>,
    pos: { left: string; width: string },
    refCartao: (el: HTMLDivElement | null) => void,
  ) => {
    const placaColor = placaColorDe(painel.vmAtual);
    const aberto = !!painel.cvSelecionado;
    const confirmandoSirene = painel.confirmacao?.pendente === "sirene" && painel.cmdSirene !== "loading";
    const confirmandoBloqueio = painel.confirmacao?.pendente === "bloqueio" && painel.cmdBloqueio !== "loading";
    const botaoCritico = (estado: "idle" | "loading" | "ok" | "fallback", confirmando: boolean, corBase: string): React.CSSProperties => ({
      height: 30, padding: "0 14px", borderRadius: RAIO.capsule,
      cursor: estado === "loading" ? "wait" : "pointer",
      border: confirmando ? `0.5px solid ${T.red}` : `0.5px solid ${
        estado === "ok" ? T.green + "44" : estado === "fallback" ? T.yellow + "44" : corBase + "44"
      }`,
      background: confirmando ? T.red :
        estado === "ok" ? `${T.green}14` : estado === "fallback" ? `${T.yellow}14` : `${corBase}14`,
      color: confirmando ? "#ffffff" :
        estado === "ok" ? T.green : estado === "fallback" ? T.yellow : corBase,
      fontSize: 12, fontWeight: 700, fontFamily: FONT_SANS, whiteSpace: "nowrap",
      transition: "background .15s, color .15s",
    });
    const cancelar = (
      <button onClick={painel.cancelarConfirmacao} style={drawerOpBtn(false)}>
        Cancelar
      </button>
    );

    const metricas: { label: string; value: string; color?: string; wide?: boolean; num?: boolean }[] = [
      {
        label: "VELOCIDADE",
        value: painel.vmAtual ? `${painel.vmAtual.velocidade} km/h` : "—",
        color: painel.vmAtual && painel.vmAtual.velocidade > 80 ? T.yellow : undefined,
        num: true,
      },
      {
        label: "IGNIÇÃO",
        value: painel.vmAtual ? (painel.vmAtual.ignicao ? "Ligada" : "Desligada") : "—",
        color: painel.vmAtual ? (painel.vmAtual.ignicao ? T.green : T.muted) : undefined,
      },
      {
        label: "COMUNICAÇÃO",
        value: painel.vmAtual ? (painel.vmAtual.atraso_min > 0 ? `${Math.round(painel.vmAtual.atraso_min)}min` : "ao vivo") : "—",
        color: painel.vmAtual && painel.vmAtual.atraso_min > 30 ? T.yellow : undefined,
        num: true,
      },
      { label: "LOCAL", value: painel.vmAtual?.local || "—", wide: true },
      ...(painel.vmAtual?.velocidade === 0 && painel.paradoMin != null
        ? [{
            label: "PARADO",
            value: !painel.pontoMaisProximo
              ? `${painel.paradoMin}min`
              : painel.pontoMaisProximo.candidatos.length === 1
                ? `${painel.paradoMin}min · ${fmtDist(painel.pontoMaisProximo.candidatos[0].distM)} de ${painel.pontoMaisProximo.candidatos[0].ponto.nome || "ponto"}`
                // 2+ pontos a distancia parecida: nao dá pra saber qual é
                // so pela distância (ver MARGEM_AMBIGUIDADE_M) — mostra
                // todos em vez de escolher 1 arbitrariamente.
                : `${painel.paradoMin}min · pode ser: ${painel.pontoMaisProximo.candidatos.map(c => c.ponto.nome || "ponto").join(" ou ")}`,
            wide: true,
            color: painel.pontoMaisProximo && painel.pontoMaisProximo.candidatos[0].distM <= 500 ? T.green : undefined,
          }]
        : []),
    ];

    return (
      <motion.div
        ref={refCartao}
        initial={false}
        animate={{ y: aberto ? 0 : "130%", opacity: aberto ? 1 : 0 }}
        transition={MOLA}
        aria-hidden={!aberto}
        // Fechado ele so fica transparente/fora da tela: sem inert o Tab ainda
        // chegava nos botoes invisiveis (Sirene/Bloqueio).
        inert={!aberto}
        style={{
          position: "absolute", bottom: 12, zIndex: Z.drawer,
          left: `calc(${pos.left} + 12px)`,
          width: `min(760px, calc(${pos.width} - 24px))`,
          ...material(tema),
          borderRadius: RAIO.panel, overflow: "hidden",
          pointerEvents: aberto ? "auto" : "none",
          fontFamily: FONT_SANS,
        }}>

        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
          flexWrap: "wrap", rowGap: 8,
        }}>
          <span style={{ ...NUM, fontSize: 20, fontWeight: 700, letterSpacing: ".02em", color: placaColor }}>
            {painel.placaSelecionada ?? "—"}
          </span>

          {painel.vmAtual && (
            <span style={{
              fontSize: 12, fontWeight: 600, padding: "2px 9px", borderRadius: RAIO.capsule,
              background: painel.vmAtual.ignicao ? `${T.green}1f` : T.surface2,
              color: painel.vmAtual.ignicao ? T.green : T.muted,
            }}>
              {painel.vmAtual.ignicao ? "IGN ON" : "IGN OFF"}
            </span>
          )}

          {painel.carregando && (
            <span style={{ fontSize: 12, color: T.dim }}>carregando…</span>
          )}

          {/* Sem romaneio hoje: aviso discreto no header (a metrica ROTA DO DIA
              so aparece quando ha rota). */}
          {painel.cvSelecionado && !painel.carregando && painel.alvosTotal === 0 && (
            <span style={{ fontSize: 12, color: T.muted }}>Sem rota hoje</span>
          )}

          <div style={{ flex: 1 }} />

          {/* Periodo: segmented capsula (thumb neutro) */}
          <div role="radiogroup" aria-label="Período do rastro" style={{
            display: "flex", gap: 2, padding: 2, borderRadius: RAIO.capsule, background: T.surface2,
          }}>
            {PERIODOS.map(h => (
              <button key={h} role="radio" aria-checked={horas === h} onClick={() => setHoras(h)} style={{
                ...NUM, height: 24, padding: "0 9px", borderRadius: RAIO.capsule, border: "none", cursor: "pointer",
                background: horas === h ? T.thumb : "transparent",
                boxShadow: horas === h ? T.thumbShadow : "none",
                color: horas === h ? T.text : T.muted,
                fontSize: 12, fontWeight: 600,
                transition: "background .15s, color .15s",
              }}>
                {h}h
              </button>
            ))}
          </div>

          <button onClick={painel.limparSelecao} aria-label="Fechar"
            style={{
              ...BASE_BTN, width: 28, height: 28, borderRadius: "50%",
              background: T.surface2, fontSize: 16, color: T.muted,
            }}>
            &times;
          </button>
        </div>

        {/* Metricas */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(120px, calc(50% - 8px)), 1fr))", gridAutoFlow: "row dense",
          gap: "10px 16px", padding: "2px 14px 12px",
        }}>
          {metricas.map((item, i) => (
            <div key={i} style={{ minWidth: 0, gridColumn: item.wide ? "span 2" : undefined }}>
              <div style={{ ...TIPO.caption, color: T.muted, marginBottom: 2 }}>
                {item.label}
              </div>
              <div style={{
                ...(item.num ? NUM : {}),
                fontSize: 15, fontWeight: 600,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                color: item.color ?? T.text,
              }}>
                {item.value}
              </div>
            </div>
          ))}

          {/* Rota do dia — so quando ha rota ("Sem rota hoje" fica no header) */}
          {painel.cvSelecionado && painel.alvosTotal > 0 && (
            <div style={{ minWidth: 0, gridColumn: "span 2" }}>
              <div style={{ ...TIPO.caption, color: T.muted, marginBottom: 2 }}>
                ROTA DO DIA
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, height: 20 }}>
                <span style={{ ...NUM, fontSize: 15, fontWeight: 600, color: T.text, flexShrink: 0 }}>
                  {painel.alvosFeitos}/{painel.alvosTotal}
                </span>
                <div style={{ flex: 1, height: 4, background: T.surface2, borderRadius: RAIO.capsule, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${Math.round((painel.alvosFeitos / painel.alvosTotal) * 100)}%`,
                    background: T.green, borderRadius: RAIO.capsule, transition: "width .4s",
                  }} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Acoes + sirene/bloqueio */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6, padding: "10px 14px 12px", flexWrap: "wrap",
          borderTop: `0.5px solid ${T.border}`,
        }}>
          <button onClick={() => painel.setMostrarRastro(v => !v)} aria-pressed={painel.mostrarRastro} style={drawerOpBtn(painel.mostrarRastro)}>
            Rastro
          </button>
          <button onClick={() => painel.setMostrarParadas(v => !v)} aria-pressed={painel.mostrarParadas} style={drawerOpBtn(painel.mostrarParadas)}>
            Paradas
          </button>
          <button onClick={() => painel.setSeguir(v => !v)} aria-pressed={painel.seguir} style={drawerOpBtn(painel.seguir)}>
            Seguir
          </button>
          <button onClick={painel.centralizar} style={drawerOpBtn(false)}>
            Centralizar
          </button>
          {painel.cvSelecionado && painel.vmAtual?.lat && painel.vmAtual?.lng && (
            <a
              href={`https://www.google.com/maps?q=${painel.vmAtual.lat},${painel.vmAtual.lng}`}
              target="_blank" rel="noreferrer"
              style={{ ...drawerOpBtn(false), display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
              Maps
            </a>
          )}
          {painel.cvSelecionado && (
            <button onClick={() => {
              const vm = veiculosMapa.find(v => v.cv === painel.cvSelecionado);
              painel.carregarVeiculo(painel.cvSelecionado as string, horas, vm?.lat != null && vm?.lng != null);
            }} disabled={painel.carregando}
              style={drawerOpBtn(false)}>
              Atualizar
            </button>
          )}

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {/* Sirene — 1o clique arma a confirmacao, 2o (em 5 s) dispara */}
            <button
              onClick={() => painel.clicarAcaoCritica("sirene")}
              disabled={painel.cmdSirene === "loading"}
              style={botaoCritico(painel.cmdSirene, confirmandoSirene, T.accent)}>
              {confirmandoSirene ? "Confirmar sirene?" :
                painel.cmdSirene === "loading" ? "Acionando..." :
                painel.cmdSirene === "ok" ? "Sirene acionada" :
                painel.cmdSirene === "fallback" ? "Ver portal" : "Sirene"}
            </button>
            {confirmandoSirene && cancelar}

            {/* Bloquear/desbloquear motor — alterna a cada acionamento; ambos confirmam */}
            <button
              onClick={() => painel.clicarAcaoCritica("bloqueio")}
              disabled={painel.cmdBloqueio === "loading"}
              style={botaoCritico(painel.cmdBloqueio, confirmandoBloqueio, painel.motorBloqueado ? T.green : T.red)}>
              {confirmandoBloqueio ? (painel.motorBloqueado ? "Confirmar desbloqueio?" : "Confirmar bloqueio?") :
                painel.cmdBloqueio === "loading" ? (painel.motorBloqueado ? "Desbloqueando..." : "Bloqueando...") :
                painel.cmdBloqueio === "ok" ? (painel.motorBloqueado ? "Motor bloqueado" : "Motor desbloqueado") :
                painel.cmdBloqueio === "fallback" ? "Ver portal" :
                painel.motorBloqueado ? "Desbloquear motor" : "Bloquear motor"}
            </button>
            {confirmandoBloqueio && cancelar}
          </div>
        </div>

        {/* Fallback portal link */}
        {(painel.cmdSirene === "fallback" || painel.cmdBloqueio === "fallback") && painel.fallbackUrl && (
          <div style={{ padding: "0 14px 12px", fontSize: 12, color: T.muted }}>
            Acao nao confirmada automaticamente.{" "}
            <a href={painel.fallbackUrl} target="_blank" rel="noreferrer" style={{ color: T.accent }}>
              Abrir portal Unitrac
            </a>
          </div>
        )}

      </motion.div>
    );
  };

  // Cada painel tem sua PROPRIA selecao de verdade agora (painel1/painel2,
  // ver usePainelFoco) — nao precisa mais "zerar" campos condicionalmente
  // pra evitar vazar pro outro painel, porque nunca compartilharam o mesmo
  // estado pra comecar. Isso tambem permite selecionar um veiculo DIFERENTE
  // em cada painel AO MESMO TEMPO (pedido explicito do cliente 08/07).
  const propsPainelTodos = {
    ...propsMapaComuns,
    cvSelecionado: painel1.cvSelecionado,
    flyPara: painel1.flyPara,
    seguir: painel1.seguir,
    desvioInicio: painel1.desvioSelecionado,
    pontoDestaque: painel1.vmAtual?.velocidade === 0 && painel1.pontoMaisProximo
      ? painel1.pontoMaisProximo.candidatos.map(c => ({ lat: c.ponto.lat, lng: c.ponto.lng, raio: c.ponto.raio, distM: c.distM }))
      : undefined,
    rastro: painel1.rastro,
    paradas: painel1.paradas,
    alvos: painel1.alvosEfetivos,
    mostrarRastro: painel1.mostrarRastro,
    mostrarParadas: painel1.mostrarParadas,
    alvosGlobais,
    onVeiculoClick: painel1.handleVeiculoClick,
  };
  const propsPainelSelecionados = {
    ...propsMapaComuns,
    cvSelecionado: painel2.cvSelecionado,
    flyPara: painel2.flyPara,
    seguir: painel2.seguir,
    desvioInicio: painel2.desvioSelecionado,
    pontoDestaque: painel2.vmAtual?.velocidade === 0 && painel2.pontoMaisProximo
      ? painel2.pontoMaisProximo.candidatos.map(c => ({ lat: c.ponto.lat, lng: c.ponto.lng, raio: c.ponto.raio, distM: c.distM }))
      : undefined,
    rastro: painel2.rastro,
    paradas: painel2.paradas,
    alvos: painel2.alvosEfetivos,
    mostrarRastro: painel2.mostrarRastro,
    mostrarParadas: painel2.mostrarParadas,
    alvosGlobais: alvosGlobaisSelecionados,
    onVeiculoClick: painel2.handleVeiculoClick,
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: T.bg, color: T.text, overflow: "hidden",
      fontFamily: FONT_SANS,
    }}>

      {/* ================================================================
          TOOLBAR — 3 colunas: [clientes] [busca centrada] [Mapa + ações]
          26/09 (redesign Apple): zoom/VEÍCULOS/SAT/TRÂNSITO foram pro
          popover "Mapa" (PopoverMapa) e o COMM 10/30/60min foi pro bloco
          FILTROS da lateral -- mesmas funções, só mudaram de lugar.
      ================================================================ */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 0,
        height: 48,
        borderBottom: `0.5px solid ${T.border}`,
        background: T.toolbarBg,
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        flexShrink: 0,
        position: "relative",
        zIndex: Z.toolbar,
        paddingLeft: 8,
        paddingRight: 8,
      }}>

        {/* ── Coluna ESQUERDA: cliente switchers (segmented cápsula, thumb neutro) ── */}
        <div style={{ display: "flex", alignItems: "center", paddingRight: 8 }}>
          {clientes.length > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 2, padding: 2,
              borderRadius: RAIO.capsule,
              background: tema === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
            }}>
              {clientes.map(c => {
                const active = c.cod === cliente;
                return (
                  <Link key={c.cod} href={`${hrefBaseClientes}?cliente=${encodeURIComponent(c.cod)}`}
                    style={{
                      position: "relative", display: "flex", alignItems: "center",
                      height: 28, padding: "0 12px", borderRadius: RAIO.capsule,
                      fontSize: 12, fontWeight: active ? 600 : 500, letterSpacing: ".04em",
                      color: active ? T.text : T.muted,
                      textDecoration: "none", whiteSpace: "nowrap",
                      transition: "color .12s",
                      fontFamily: FONT_SANS,
                    }}>
                    {active && (
                      <motion.span layoutId="thumbCliente" transition={MOLA}
                        style={{ position: "absolute", inset: 0, borderRadius: RAIO.capsule, background: T.thumb, boxShadow: T.thumbShadow }} />
                    )}
                    <span style={{ position: "relative" }}>{c.nome.split(" ")[0].toUpperCase()}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Coluna CENTRAL: busca de placa centralizada ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          gap: 5, minWidth: 0,
        }}>
          {/* Busca placa */}
          <div style={{ position: "relative", flexShrink: 0, width: "clamp(220px, 28vw, 380px)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={busca}
              onChange={e => { setBusca(e.target.value); setComboAberto(true); }}
              onFocus={() => setComboAberto(true)}
              onBlur={() => setTimeout(() => setComboAberto(false), 200)}
              placeholder="Buscar placa"
              style={{
                background: painel1.cvSelecionado ? T.accentDim : tema === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
                border: `1px solid ${painel1.cvSelecionado ? T.accent + "66" : "transparent"}`,
                borderRadius: RAIO.capsule, color: painel1.cvSelecionado ? T.accent : T.text,
                padding: "0 12px 0 32px", height: 32, width: "100%", boxSizing: "border-box",
                fontSize: 13, fontFamily: FONT_SANS, outline: "none",
                fontWeight: painel1.cvSelecionado ? 600 : 400,
              }}
            />
            {comboAberto && veiculosBusca.length > 0 && (
              <div style={{
                position: "absolute", top: 38, left: 0, right: 0,
                ...material(tema), borderRadius: RAIO.panel, overflow: "hidden",
                padding: 4, zIndex: Z.combo,
              }}>
                {veiculosBusca.map(v => {
                  const al = alertas.find(a => a.placa === v.placa);
                  return (
                    <button key={v.cv}
                      onMouseDown={() => { painel1.selecionarVeiculo(v.cv); setBusca(v.placa); setComboAberto(false); }}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        width: "100%", padding: "8px 10px", background: "transparent", border: "none",
                        borderRadius: RAIO.control, color: T.text,
                        fontSize: 13, fontFamily: FONT_SANS, cursor: "pointer",
                      }}>
                      <span style={{ fontWeight: 600, fontFamily: FONT_MONO }}>{v.placa}</span>
                      {al && (
                        <span style={{ fontSize: 12, color: al.nivel === "critico" ? T.red : T.yellow }}>
                          {nomeT(al.tipo)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Coluna DIREITA: Mapa + settings + apito ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 8 }}>
          {/* Popover "Mapa": dentro do container da toolbar (zIndex 1500),
              então pinta acima do mapa sem portal. Chama exatamente as
              mesmas funções dos botões antigos (cmdZoom, setGatilhoFrota,
              setSateliteComPersistencia, setCamTrafegoComPersistencia). */}
          <PopoverMapa
            tema={tema}
            T={T}
            zoomLabels={ZOOM_LABELS}
            zoomAtual={zoomAtual}
            onZoom={cmdZoom}
            onEnquadrarFrota={() => setGatilhoFrota(g => g + 1)}
            satelite={satelite}
            onSatelite={setSateliteComPersistencia}
            trafego={camTrafego}
            onTrafego={setCamTrafegoComPersistencia}
          />
          {/* Settings gear */}
          <div ref={settingsRef} style={{ position: "relative" }}>
            <button
              onClick={() => setSettingsAberto(v => !v)}
              title="Configuracoes"
              style={{
                ...BASE_BTN, width: 32, height: 32, borderRadius: "50%",
                color: settingsAberto ? T.accent : T.muted,
                border: `1px solid ${settingsAberto ? T.accent + "55" : T.border}`,
                background: settingsAberto ? `${T.accent}10` : "transparent",
              }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>

            {settingsAberto && (
              <div style={{
                position: "absolute", top: 38, right: 0,
                width: 196, zIndex: Z.settings,
                ...material(tema),
                borderRadius: RAIO.panel,
                overflow: "hidden",
              }}>
                <div style={{ padding: "10px 14px 6px", fontSize: 12, color: T.dim, letterSpacing: ".04em", fontWeight: 700 }}>
                  CONFIGURAÇÕES
                </div>
                <div style={{ padding: "4px 8px 8px" }}>
                  <div style={{ fontSize: 12, color: T.muted, padding: "2px 6px 6px", fontWeight: 600, letterSpacing: ".05em" }}>
                    TEMA
                  </div>
                  {(["dark", "light"] as const).map(t => (
                    <button key={t} onClick={() => { setTemaComPersistencia(t); setSettingsAberto(false); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        width: "100%", padding: "8px 10px", borderRadius: RAIO.control,
                        background: tema === t ? `${T.accent}12` : "transparent",
                        border: `1px solid ${tema === t ? T.accent + "44" : "transparent"}`,
                        color: tema === t ? T.accent : T.text,
                        fontSize: 12, cursor: "pointer", fontWeight: tema === t ? 700 : 400,
                        marginBottom: 2, fontFamily: FONT_SANS,
                      }}>
                      {t === "dark" ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/>
                          <line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/>
                          <line x1="21" y1="12" x2="23" y2="12"/>
                        </svg>
                      )}
                      {t === "dark" ? "Modo escuro" : "Modo claro"}
                      {tema === t && <span style={{ marginLeft: "auto", fontSize: 12, color: T.accent }}>●</span>}
                    </button>
                  ))}
                </div>

                {/* Camadas de risco */}
                <div style={{ borderTop: `1px solid ${T.border}`, padding: "6px 8px 8px" }}>
                  <div style={{ fontSize: 12, color: T.muted, padding: "4px 6px 4px", fontWeight: 600, letterSpacing: ".05em" }}>
                    CAMADAS
                  </div>
                  {([
                    { label: "Favelas", val: camFavelas, set: setCamFavelasComPersistencia, cor: "#ff2d2d" },
                    { label: "Tiroteios (24h)", val: camTiroteios, set: setCamTiroteiosComPersistencia, cor: "#f97316" },
                    { label: "Roubo de carga", val: camRouboCarga, set: setCamRouboCargaComPersistencia, cor: "#fbbf24" },
                  ] as { label: string; val: boolean; set: (v: boolean) => void; cor: string }[]).map(({ label, val, set, cor }) => (
                    <button key={label} onClick={() => set(!val)}
                      style={{
                        display: "flex", alignItems: "center", gap: 9,
                        width: "100%", padding: "7px 10px", borderRadius: RAIO.control,
                        background: val ? `${cor}12` : "transparent",
                        border: `1px solid ${val ? cor + "33" : "transparent"}`,
                        color: val ? T.text : T.dim,
                        fontSize: 12, cursor: "pointer",
                        marginBottom: 2, fontFamily: FONT_SANS,
                        transition: "all .1s",
                      }}>
                      <div style={{
                        width: 14, height: 14, borderRadius: RAIO.check, flexShrink: 0,
                        background: val ? cor : "transparent",
                        border: `1.5px solid ${val ? cor : T.dim}`,
                        transition: "all .1s",
                      }} />
                      {label}
                    </button>
                  ))}
                </div>

                {/* Ver apenas veículos selecionados — abre tela dedicada de escolha */}
                <div style={{ borderTop: `1px solid ${T.border}`, padding: "6px 8px 8px" }}>
                  <div style={{ fontSize: 12, color: T.muted, padding: "4px 6px 4px", fontWeight: 600, letterSpacing: ".05em" }}>
                    VEÍCULOS
                  </div>
                  <button onClick={() => { setSeletorAberto(true); setSettingsAberto(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 9,
                      width: "100%", padding: "7px 10px", borderRadius: RAIO.control,
                      background: modoSelecionados ? `${T.accent}12` : "transparent",
                      border: `1px solid ${modoSelecionados ? T.accent + "44" : "transparent"}`,
                      color: modoSelecionados ? T.accent : T.text,
                      fontSize: 12, cursor: "pointer", fontFamily: FONT_SANS,
                      fontWeight: modoSelecionados ? 700 : 400,
                    }}>
                    <div style={{
                      width: 14, height: 14, borderRadius: RAIO.check, flexShrink: 0,
                      background: modoSelecionados ? T.accent : "transparent",
                      border: `1.5px solid ${modoSelecionados ? T.accent : T.dim}`,
                    }} />
                    Ver apenas selecionados
                    {modoSelecionados && veiculosSelecionados.size > 0 && (
                      <span style={{ marginLeft: "auto", fontSize: 12, fontFamily: FONT_MONO, color: T.accent }}>
                        {veiculosSelecionados.size}
                      </span>
                    )}
                  </button>
                </div>

              </div>
            )}
          </div>

          <AlertaSonoro idsParaApitar={novosIdsArr} />
        </div>
      </div>

      {/* ================================================================
          MAIN BODY
      ================================================================ */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ============================================================
            LEFT SIDEBAR (coluna do painel TODOS) — mais fina em split view
            (2 colunas dividem a largura, uma de cada lado do mapa) do que
            no modo unico (1 coluna so).
        ============================================================ */}
        <div style={{
          width: splitView ? "clamp(190px, 14vw, 230px)" : "clamp(220px, 18vw, 280px)",
          flexShrink: 0, display: "flex", flexDirection: "column",
          borderRight: `0.5px solid ${T.border}`,
          background: T.sidebarBg,
          overflow: "hidden",
        }}>
          {/* Contadores (26/09): dois stats lado a lado, sem fundo vermelho no
              bloco -- so o numero fica vermelho quando ha' critico. */}
          <div style={{
            display: "flex", alignItems: "stretch",
            borderBottom: `0.5px solid ${T.border}`, flexShrink: 0,
          }}>
            <div style={{ flex: 1, padding: 14 }}>
              <div style={{ ...TIPO.title, ...NUM, color: nCriticos > 0 ? T.red : T.text, lineHeight: 1 }}>
                {nCriticos}
              </div>
              <div style={{ ...TIPO.caption, color: T.muted, marginTop: 4 }}>Críticos</div>
            </div>
            <div style={{ flex: 1, padding: 14 }}>
              <div style={{ ...TIPO.title, ...NUM, color: T.text, lineHeight: 1 }}>
                {veiculosMapa.length}
              </div>
              <div style={{ ...TIPO.caption, color: T.muted, marginTop: 4 }}>Veículos</div>
            </div>
          </div>

          {/* Filtro ativo de "ver apenas selecionados" — sempre visível pra não confundir o operador.
              Guarda size>0 pra nunca mostrar "FILTRO: 0 VEÍC." (estado fantasma). */}
          {modoSelecionados && veiculosSelecionados.size > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
              borderBottom: `1px solid ${T.border}`, flexShrink: 0,
              background: `${T.accent}0c`,
            }}>
              <span style={{ fontSize: 12, color: T.accent, fontWeight: 700, letterSpacing: ".05em" }}>
                FILTRO: {veiculosSelecionados.size} VEÍC.
              </span>
              <button onClick={() => setSeletorAberto(true)} style={{ ...tinyBtn(T.accent), marginLeft: "auto" }}>Editar</button>
              <button onClick={() => { setModoSelecionadosSessao(false); setModoRomaneio(false); }} style={tinyBtn(T.dim)}>Mostrar todos</button>
            </div>
          )}

          {/* Filter tabs — "Desvios" (task A1, 27/08) é FIXA e sempre visível
              pra qualquer cliente (desvio + parada_anomala), sem depender de
              mapeamento por cod_user_unitrac. "TUDO" continua mostrando
              literalmente todos os tipos, sem mudança de comportamento --
              rede de segurança deliberada, aditiva à aba nova. */}
          <div style={{ padding: "8px 10px", borderBottom: `0.5px solid ${T.border}`, flexShrink: 0 }}>
            <div style={{ display: "flex", padding: 2, gap: 2, borderRadius: RAIO.capsule, background: T.surface2 }}>
              {(["tudo", "desvios"] as const).map(v => {
                const ativo = vista === v;
                // Segmented neutro (26/09): thumb do sistema, sem cor por aba.
                // Rotulo em caixa normal; a constante LABEL_ABA_DESVIOS segue a fonte.
                const rotulo = v === "tudo" ? "Tudo" : LABEL_ABA_DESVIOS.charAt(0) + LABEL_ABA_DESVIOS.slice(1).toLowerCase();
                return (
                  <motion.button key={v} whileTap={{ scale: 0.96 }} onClick={() => setVistaComPersistencia(v)} style={{
                    position: "relative", flex: 1, height: 28, borderRadius: RAIO.capsule, border: "none", cursor: "pointer",
                    background: "transparent",
                    color: ativo ? T.text : T.muted,
                    fontSize: 13, fontWeight: 600,
                    fontFamily: FONT_SANS, transition: "color .12s",
                  }}>
                    {ativo && (
                      <motion.div layoutId="pillVista" transition={MOLA}
                        style={{ position: "absolute", inset: 0, borderRadius: RAIO.capsule, background: T.thumb, boxShadow: T.thumbShadow, zIndex: 0 }} />
                    )}
                    <span style={{ position: "relative", zIndex: 1 }}>{rotulo}</span>
                  </motion.button>
                );
              })}
            </div>
          </div>

          {/* Filtros de grupo de frota + tipo — colapsados por padrão, um único
              cabeçalho compacto em vez de duas faixas de pílulas sempre abertas */}
          {(() => {
            const tiposDisponiveis = [...new Set(alertas.filter(a => {
              if (vista === "desvios" && !TIPOS_ABA_DESVIOS.includes(a.tipo)) return false;
              return true;
            }).map(a => a.tipo))].sort((a, b) => (TIPO_PRIORITY[b] ?? 0) - (TIPO_PRIORITY[a] ?? 0));
            const temGrupos = grupos.length > 1;
            const temTipos = tiposDisponiveis.length > 0;
            // 26/09: sempre renderiza -- o filtro "sem comunicação há" (COMM,
            // antes na toolbar) vive aqui e vale pra qualquer cliente, mesmo
            // sem grupos/tipos. Conta no indicador do cabeçalho pra o operador
            // saber que há filtro ligado com o bloco fechado.
            const filtrosAtivos = gruposOcultos.size + filtroTipos.size + (filtroComm != null ? 1 : 0);
            return (
              <div style={{ borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
                <button onClick={() => setFiltrosAbertos(v => !v)} style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%",
                  padding: "6px 8px", background: "transparent", border: "none",
                  cursor: "pointer", fontFamily: FONT_SANS,
                }}>
                  <span style={{ fontSize: 12, color: T.muted, fontWeight: 700, letterSpacing: ".06em" }}>
                    FILTROS
                  </span>
                  {filtrosAtivos > 0 && (
                    <span style={{
                      fontSize: 12, fontFamily: FONT_MONO, color: T.accent,
                      background: `${T.accent}18`, borderRadius: RAIO.control, padding: "1px 5px",
                    }}>
                      {filtrosAtivos}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: 12, color: T.dim }}>
                    {filtrosAbertos ? "▾" : "▸"}
                  </span>
                </button>

                {filtrosAbertos && (
                  <div style={{ paddingBottom: 4 }}>
                    {/* Sem comunicação há — mesmo setter/regra dos antigos botões
                        COMM 10/30/60min da toolbar (clicar no ativo desliga). */}
                    <div style={{ ...TIPO.caption, color: T.dim, padding: "2px 8px 4px" }}>
                      Sem comunicação há
                    </div>
                    <div style={{ display: "flex", gap: 3, padding: "0 6px 6px", flexWrap: "wrap" }}>
                      {[10, 30, 60].map(m => {
                        const ativo = filtroComm === m;
                        return (
                          <button key={m} onClick={() => setFiltroComm(filtroComm === m ? null : m)} style={{
                            height: 24, padding: "0 10px", borderRadius: RAIO.capsule,
                            border: `1px solid ${ativo ? T.accent : T.border}`,
                            background: ativo ? T.accentDim : "transparent",
                            color: ativo ? T.accent : T.muted,
                            fontSize: 12, fontWeight: ativo ? 600 : 500,
                            cursor: "pointer", fontFamily: FONT_SANS, whiteSpace: "nowrap",
                          }}>
                            {m} min
                          </button>
                        );
                      })}
                    </div>
                    {/* Chips de grupo de frota (gvc/gvn) — clique oculta/mostra o grupo */}
                    {temGrupos && (
                      <div style={{ display: "flex", gap: 3, padding: "2px 6px 5px", flexWrap: "wrap" }}>
                        {grupos.map(g => {
                          const oculto = gruposOcultos.has(g.gvc);
                          return (
                            <button key={g.gvc} onClick={() => toggleGrupoOculto(g.gvc)} title={oculto ? "Grupo oculto — clique pra mostrar" : "Clique pra ocultar este grupo"} style={{
                              height: 22, padding: "0 7px", borderRadius: RAIO.control,
                              border: `1px solid ${oculto ? T.border : T.accent}`,
                              background: oculto ? "transparent" : `${T.accent}18`,
                              color: oculto ? T.dim : T.accent,
                              fontSize: 12, fontWeight: oculto ? 500 : 700,
                              cursor: "pointer", fontFamily: FONT_SANS, whiteSpace: "nowrap",
                              display: "flex", alignItems: "center", gap: 4,
                              textDecoration: oculto ? "line-through" : "none",
                            }}>
                              <span>{g.gvn.trim()}</span>
                              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{g.veiculos.length}</span>
                            </button>
                          );
                        })}
                        {gruposOcultos.size > 0 && (
                          <button onClick={() => { setGruposOcultos(new Set()); localStorage.removeItem("transmonseg-grupos-ocultos"); }} style={{
                            height: 22, padding: "0 8px", borderRadius: RAIO.control,
                            border: `1px solid ${T.border}`, background: "transparent",
                            color: T.dim, fontSize: 12, cursor: "pointer",
                          }}>✕</button>
                        )}
                      </div>
                    )}

                    {/* Chips de tipo — multi-select, filtra sidebar + mapa */}
                    {temTipos && (
                      <div style={{ display: "flex", gap: 3, padding: "2px 6px 5px", flexWrap: "wrap" }}>
                        {tiposDisponiveis.map(tipo => {
                          const ativo = filtroTipos.has(tipo);
                          const count = alertas.filter(a => a.tipo === tipo).length;
                          return (
                            <button key={tipo} onClick={() => toggleFiltroTipo(tipo)} style={{
                              height: 22, padding: "0 7px", borderRadius: RAIO.control,
                              border: `1px solid ${ativo ? T.accent : T.border}`,
                              background: ativo ? `${T.accent}22` : "transparent",
                              color: ativo ? T.accent : T.muted,
                              fontSize: 12, fontWeight: ativo ? 700 : 500,
                              cursor: "pointer", fontFamily: FONT_SANS, whiteSpace: "nowrap",
                              display: "flex", alignItems: "center", gap: 4,
                            }}>
                              <span>{NOME_TIPO[tipo] ?? tipo}</span>
                              <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: ativo ? T.accent : T.dim }}>{count}</span>
                            </button>
                          );
                        })}
                        {filtroTipos.size > 0 && (
                          <button onClick={() => { setFiltroTipos(new Set()); localStorage.removeItem("transmonseg-filtro-tipos"); }} style={{
                            height: 22, padding: "0 8px", borderRadius: RAIO.control,
                            border: `1px solid ${T.border}`, background: "transparent",
                            color: T.dim, fontSize: 12, cursor: "pointer",
                          }}>✕</button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Resolver todos / Limpar avisos — os VISÍVEIS na aba atual
              (Crítico/Tudo), sobre o MESMO conjunto (alertasOrdenados) em
              QUALQUER modo de tela, inclusive split view -- pedido explicito
              do usuario 12/08 (antes sumiam em split view por ambiguidade
              conceitual entre TODOS/SELECIONADOS; a implementacao sempre foi
              bem definida, agia sempre sobre o mesmo conjunto, so a
              visibilidade que escondia). "Resolver todos" (resolverVarios)
              afirma veredito humano e alimenta a calibracao; "Limpar avisos"
              (limparVarios) so tira da tela, sem fingir revisao caso a caso
              — pedido do usuario 28/07 depois do achado de que "Resolver
              todos" clicado em massa contaminava a leitura de "quantos
              confirmados de verdade". Cada botao tem seu proprio fluxo de
              confirmar/cancelar (confirmarResolver/confirmarLimpar), so um
              ativo por vez.
              Achado real 20/08 (revisão de branch inteira): usa
              alertasOrdenados (pós-separação "Outros avisos"), NÃO
              alertasFiltrados (pré-separação) -- deliberadamente exclui
              favela/baseline_veiculo, que ficaram escondidos na seção
              colapsada "Outros avisos". Antes desta correção, esses botões
              agiam sobre alertas que o operador nunca viu (dentro da seção
              colapsada), incluindo "Resolver todos" registrando veredito
              humano (resolver_massa) sobre alertas não revisados — exatamente
              o problema que essa iniciativa inteira existe pra reduzir.
              Achado real 20/08 (varredura de origem_acao, dia 19/08): 29 de
              35 "corretos" de desvio vieram de "Resolver todos" em lote, só
              6 de revisão individual -- "Resolver todos" agora usa
              alertasResolviveisEmMassa (exclui desvio + os 3 tipos de parada,
              ver TIPOS_REVISAO_INDIVIDUAL), forçando clique individual por
              card pra esse tipo. "Limpar avisos" continua sobre
              alertasOrdenados inteiro -- nunca afirmou revisão caso a caso,
              não é o alvo desta mudança. */}
          {alertasOrdenados.length > 0 && (
            <div style={{ padding: "8px 10px", borderBottom: `0.5px solid ${T.border}`, flexShrink: 0 }}>
              {confirmarResolver ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={handleResolverTodos} disabled={resolvendoTodos} style={{
                    flex: 1, height: 30, borderRadius: RAIO.capsule,
                    background: `${T.red}18`, border: "none", color: T.red,
                    fontSize: 12, cursor: "pointer", fontWeight: 600, fontFamily: FONT_SANS,
                  }}>
                    {resolvendoTodos ? "..." : "CONFIRMAR"}
                  </button>
                  <button onClick={() => setConfirmarResolver(false)} style={{
                    flex: 1, height: 30, borderRadius: RAIO.capsule,
                    background: T.surface2, border: "none",
                    color: T.text, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT_SANS,
                  }}>
                    Cancelar
                  </button>
                </div>
              ) : confirmarLimpar ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={handleLimparTodos} disabled={limpandoTodos} style={{
                    flex: 1, height: 30, borderRadius: RAIO.capsule,
                    background: `${T.accent}22`, border: "none", color: T.accent,
                    fontSize: 12, cursor: "pointer", fontWeight: 600, fontFamily: FONT_SANS,
                  }}>
                    {limpandoTodos ? "..." : "CONFIRMAR"}
                  </button>
                  <button onClick={() => setConfirmarLimpar(false)} style={{
                    flex: 1, height: 30, borderRadius: RAIO.capsule,
                    background: T.surface2, border: "none",
                    color: T.text, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT_SANS,
                  }}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6 }}>
                  {alertasResolviveisEmMassa.length > 0 && (
                    <button onClick={() => setConfirmarResolver(true)} style={{
                      flex: 1, height: 30, borderRadius: RAIO.capsule,
                      background: T.surface2, border: "none",
                      color: T.text, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT_SANS,
                    }}>
                      {vista === "desvios" ? `Resolver ${LABEL_ABA_DESVIOS.toLowerCase()} (${alertasResolviveisEmMassa.length})`
                        : `Resolver todos (${alertasResolviveisEmMassa.length})`}
                    </button>
                  )}
                  <button onClick={() => setConfirmarLimpar(true)} style={{
                    flex: 1, height: 30, borderRadius: RAIO.capsule,
                    background: T.surface2, border: "none",
                    color: T.text, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT_SANS,
                  }}>
                    {`Limpar avisos (${alertasOrdenados.length})`}
                  </button>
                </div>
              )}
            </div>
          )}

          {avisoRecentes && (
            <div style={{ padding: "5px 8px", fontSize: 12, color: T.dim, borderBottom: `1px solid ${T.border}` }}>
              {avisoRecentes.quantidade} alerta{avisoRecentes.quantidade > 1 ? "s" : ""} recente{avisoRecentes.quantidade > 1 ? "s" : ""} (menos de {IDADE_MINIMA_ACAO_MASSA_MIN}min) {avisoRecentes.quantidade > 1 ? "ficaram" : "ficou"} de fora d{avisoRecentes.acao === "resolver" ? "a resolução" : "a limpeza"} em massa — revise individualmente.
            </div>
          )}

          {erroAcaoMassa && (
            <div style={{ padding: "5px 8px", fontSize: 12, color: "#f87171", borderBottom: `1px solid ${T.border}` }}>
              {erroAcaoMassa} Nada foi alterado — os alertas continuam na lista.
            </div>
          )}

          {dadoDesatualizado && (
            <div style={{ padding: "5px 8px", fontSize: 12, color: T.yellow, borderBottom: `1px solid ${T.border}` }}>
              ⚠ Sem atualização desde {new Date(ultimoPollOk).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} — os dados na tela podem estar desatualizados.
            </div>
          )}

          {/* Alert list. Fora do split view: 1 lista so, como sempre foi.
              Em split view: essa coluna mostra SO o TODOS (a coluna do
              SELECIONADOS fica do lado do MAPA dele, depois do MAP AREA —
              "uma coluna do lado de cada tela", pedido do cliente 08/07,
              nao 2 secoes empilhadas numa sidebar so). Cards sempre com
              detalhe completo (motivo/progresso/acoes) nas 2 colunas. */}
          <div style={{ flex: 1, overflowY: "auto", padding: "2px 8px 8px" }}>
            {/* Achado real 20/08 (revisão de branch inteira): checar só a
                lista principal aqui mentia quando "Outros avisos" tinha
                conteúdo -- favela/baseline_veiculo são 67% do volume, então
                "lista principal vazia mas Outros avisos cheio" é estado
                rotineiro, não edge case. "Nenhum alerta ativo" só aparece
                quando as DUAS listas (principal + outros avisos) estão
                vazias. */}
            {(splitView ? alertasOrdenadosSplitTodos : alertasOrdenados).length === 0 &&
             (splitView ? outrosAvisosSplit : outrosAvisos).length === 0 && (
              <div style={{ padding: "28px 16px", textAlign: "center", color: T.dim, fontSize: 12 }}>
                <div style={{ marginBottom: 6, opacity: 0.6 }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ display: "inline-block" }}>
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                Nenhum alerta ativo
              </div>
            )}
            <AnimatePresence initial={false}>
              {(splitView ? alertasOrdenadosSplitTodos : alertasOrdenados).map((a, i) => renderCardAlerta(a, { painel: painel1, index: i }))}
            </AnimatePresence>
          </div>

          {(splitView ? outrosAvisosSplit : outrosAvisos).length > 0 && (
            <div style={{ borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
              <button onClick={() => setOutrosAbertos(v => !v)} style={{
                display: "flex", alignItems: "center", gap: 6, width: "100%",
                padding: "6px 8px", background: "transparent", border: "none",
                cursor: "pointer", fontFamily: FONT_SANS,
              }}>
                <span style={{ fontSize: 12, color: T.muted, fontWeight: 700, letterSpacing: ".06em" }}>
                  OUTROS AVISOS
                </span>
                <span style={{
                  fontSize: 12, fontFamily: FONT_MONO, color: T.dim,
                  background: `${T.dim}18`, borderRadius: RAIO.control, padding: "1px 5px",
                }}>
                  {(splitView ? outrosAvisosSplit : outrosAvisos).length}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: T.dim }}>
                  {outrosAbertos ? "▾" : "▸"}
                </span>
              </button>

              {outrosAbertos && (
                <div style={{ padding: "0 6px 8px", maxHeight: 320, overflowY: "auto" }}>
                  <AnimatePresence initial={false}>
                    {(splitView ? outrosAvisosSplit : outrosAvisos).map((a, i) => renderCardAlerta(a, { painel: painel1, index: i }))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ============================================================
            MAP AREA
        ============================================================ */}
        <div ref={mapAreaRef} style={{ flex: 1, position: "relative", overflow: "hidden", minWidth: 0 }}>

          {splitView ? (
            <div style={{ display: "flex", width: "100%", height: "100%" }}>
              <div style={{ width: `${splitRatio * 100}%`, height: "100%", position: "relative", overflow: "hidden", flexShrink: 0 }}>
                <MapaLeafletV2 veiculosMapa={vmTodos} {...propsPainelTodos} />
                <div style={rotuloPainelStyle("left", T, tema)}>TODOS · {vmTodos.length}</div>
              </div>

              <SplitDivider
                containerRef={mapAreaRef}
                ratio={splitRatio}
                onChange={setSplitRatio}
                onFundir={(ladoQueFicaCheio) => {
                  // Arrastou o divisor ate a borda e soltou: funde pra tela
                  // cheia daquele lado (igual arrastar uma aba de janela ate
                  // a beirada) — volta a razao pro meio pra proxima vez que
                  // abrir o split de novo comece equilibrado.
                  escolherEscopoMapa(ladoQueFicaCheio);
                  setSplitRatio(0.5);
                }}
                accent={T.accent}
              />

              <div style={{ width: `${(1 - splitRatio) * 100}%`, height: "100%", position: "relative", overflow: "hidden", flexShrink: 0 }}>
                <MapaLeafletV2 veiculosMapa={vmSelecionados} {...propsPainelSelecionados} />
                <div style={rotuloPainelStyle("right", T, tema)}>SELECIONADOS · {vmSelecionados.length}</div>
              </div>
            </div>
          ) : (
            <MapaLeafletV2 veiculosMapa={vmFiltrado} {...propsPainelTodos} alvosGlobais={alvosGlobaisMapa} />
          )}

          {/* Alternador TODOS / AMBOS / SELECIONADOS / ROMANEIO — topo central do mapa.
              Clique direto num rotulo OU arraste o thumb pelos 4 estados
              (estilo iPad Split View: extremos = tela cheia de um lado,
              meio = os dois lado a lado, divisor arrastavel via SplitDivider).
              Reaproveita modoSelecionados/veiculosSelecionados que ja existiam
              (antes so acessivel via checkbox enterrado em Configurações). */}
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: Z.badge }}>
            <EscopoMapaSwitcher
              modo={splitView ? "ambos" : (modoRomaneio ? "romaneio" : (modoSelecionados ? "selecionados" : "todos"))}
              totalSelecionados={veiculosSelecionados.size}
              temSelecao={veiculosSelecionados.size > 0}
              totalComRomaneio={cvsComRomaneio.size}
              onEscolher={escolherEscopoMapa}
              onAbrirSeletor={() => setSeletorAberto(true)}
              tema={tema}
              accent={T.accent}
              text={T.text}
              thumb={T.thumb}
              thumbShadow={T.thumbShadow}
              border={T.border}
              muted={T.muted}
            />
          </div>

          {/* Topo do mapa: aviso de desvio (spec 2026-09-26-topo-mapa-aviso-desvio). */}
          {(() => {
            // Mesmo gate da faixa antiga: cliente sem "desvio" nos tipos que
            // notificam (ex.: Benassi) não ganha pílula.
            if (!tiposNotificamCliente.includes("desvio")) return null;
            const cores = { red: T.red, yellow: T.yellow, text: T.text, muted: T.muted, dim: T.dim, border: T.border, card: T.card };
            const focarCom = (painel: ReturnType<typeof usePainelFoco>) => (a: ItemAvisoDesvio) => {
              painel.setAlertaAtivoId(a.id);
              painel.selecionarVeiculo(a.cv, a.lat && a.lng ? { lat: a.lat, lng: a.lng } : undefined);
            };
            const comum = { lote: ultimoLoteNovos, tema, cores, nomeTipo: nomeT, tempoAtras };
            return !splitView ? (
              <AvisoDesvioTopo {...comum} itens={desviosAtivos} left="0%" width="100%" onVerNoMapa={focarCom(painel1)} />
            ) : (
              <>
                <AvisoDesvioTopo {...comum} itens={desviosAtivosSplitTodos} compacto
                  left="0%" width={`${splitRatio * 100}%`} onVerNoMapa={focarCom(painel1)} />
                <AvisoDesvioTopo {...comum} itens={desviosAtivosSplitSelecionados}
                  left={`${splitRatio * 100}%`} width={`${(1 - splitRatio) * 100}%`} onVerNoMapa={focarCom(painel2)} />
              </>
            );
          })()}

          {/* Badge de veiculos + Legenda sobem acima do cartao do veiculo do
              painel em que estao (badge = esquerda = painel1; Legenda =
              direita = painel2 no split, painel1 fora dele), pela altura
              MEDIDA do cartao (alturaCartao, ResizeObserver). */}
          {(() => {
            const acima = (painel: ReturnType<typeof usePainelFoco>, h: number) =>
              painel.cvSelecionado ? 12 + h + 12 : 12;
            const bottomEsq = acima(painel1, alturaCartao.p1);
            const bottomDir = splitView ? acima(painel2, alturaCartao.p2) : bottomEsq;
            const transicao = "bottom .35s cubic-bezier(.32,.72,0,1)";
            return (
              <>
                <div style={{
                  position: "absolute", bottom: bottomEsq, left: 12, zIndex: Z.badge,
                  transition: transicao,
                  ...material(tema), borderRadius: RAIO.capsule,
                  padding: "5px 12px", fontSize: 12, fontWeight: 600, color: T.text,
                  pointerEvents: "none", fontFamily: FONT_SANS,
                }}>
                  <span style={NUM}>{vmFiltrado.length}</span> veículos
                  {filtroComm != null && <span style={{ ...NUM, color: T.accent }}> &lt;{filtroComm}min</span>}
                </div>

                {/* Legenda dos símbolos do mapa — recolhida por padrão */}
                <div style={{
                  position: "absolute", bottom: bottomDir, right: 12, zIndex: Z.badge,
                  transition: transicao,
                  display: "flex", flexDirection: "column-reverse", alignItems: "flex-end", gap: 8,
                }}>
                  <button onClick={toggleLegenda} aria-expanded={legendaAberta} style={{
                    ...BASE_BTN,
                    ...material(tema), borderRadius: RAIO.capsule,
                    padding: "5px 12px", fontSize: 12, fontWeight: 600, color: T.text, gap: 6,
                  }}>
                    <span style={{ fontSize: 12, color: T.muted }}>{legendaAberta ? "▾" : "▴"}</span>
                    Legenda
                  </button>

                  {legendaAberta && (
                    <div style={{
                      ...material(tema), borderRadius: RAIO.panel,
                      padding: "12px 14px", minWidth: 190,
                      fontFamily: FONT_SANS,
                    }}>
                      <div style={{ ...TIPO.caption, color: T.muted, marginBottom: 6 }}>
                        Veículo
                      </div>
                      {[
                        { cor: T.red, label: "Alerta crítico" },
                        { cor: T.green, label: "Em movimento" },
                        { cor: mapTokens.parado, label: "Parado, motor ligado" },
                        { cor: T.dim, label: "Motor desligado" },
                      ].map(({ cor, label }) => (
                        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ width: 9, height: 9, borderRadius: "50%", background: cor, flexShrink: 0, border: "1px solid rgba(255,255,255,0.25)" }} />
                          <span style={{ fontSize: 12, color: T.text }}>{label}</span>
                        </div>
                      ))}

                      <div style={{ ...TIPO.caption, color: T.muted, margin: "8px 0 6px", borderTop: `0.5px solid ${T.border}`, paddingTop: 8 }}>
                        Ponto de entrega
                      </div>
                      {[
                        { cor: COR_PENDENTE, label: "Pendente" },
                        { cor: COR_ENTREGUE, label: "Entregue" },
                        { cor: COR_OUTRO, label: "Esteve no local" },
                      ].map(({ cor, label }) => (
                        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ width: 9, height: 9, borderRadius: "50%", background: cor, flexShrink: 0, border: "1px solid rgba(255,255,255,0.25)" }} />
                          <span style={{ fontSize: 12, color: T.text }}>{label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            );
          })()}


          {/* ================================================================
              BOTTOM DRAWER — 1 por painel (painel1/painel2), pra permitir 2
              veiculos selecionados ao mesmo tempo (1 por lado do split view).
              Fora do split, so o drawer do painel1 aparece (full width).
          ================================================================ */}
          {renderDrawer(painel1, {
            left: "0%",
            width: splitView ? `${splitRatio * 100}%` : "100%",
          }, refCartaoP1)}
          {splitView && renderDrawer(painel2, {
            left: `${splitRatio * 100}%`,
            width: `${(1 - splitRatio) * 100}%`,
          }, refCartaoP2)}

        </div>{/* MAP AREA end */}

        {/* ============================================================
            RIGHT SIDEBAR (coluna do painel SELECIONADOS) — so em split
            view, ao lado do mapa SELECIONADOS (que fica na ponta direita
            do MAP AREA). Mesma largura fina da esquerda; cards com o
            MESMO detalhe completo (nao compactado).
        ============================================================ */}
        {splitView && (
          <div style={{
            width: "clamp(190px, 14vw, 230px)",
            flexShrink: 0, display: "flex", flexDirection: "column",
            borderLeft: `0.5px solid ${T.border}`,
            background: T.sidebarBg,
            overflow: "hidden",
          }}>
            <div style={{
              display: "flex", alignItems: "center", padding: 14,
              borderBottom: `0.5px solid ${T.border}`, flexShrink: 0,
            }}>
              <div style={{ ...TIPO.caption, color: T.muted }}>SELECIONADOS</div>
              <div style={{ ...TIPO.headline, ...NUM, marginLeft: "auto", color: T.text }}>
                {alertasOrdenadosSplitSelecionados.length}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "2px 8px 8px" }}>
              {alertasOrdenadosSplitSelecionados.length === 0 && (
                <div style={{ padding: "28px 12px", textAlign: "center", color: T.dim, fontSize: 12 }}>
                  <div style={{ marginBottom: 6, opacity: 0.6 }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ display: "inline-block" }}>
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                      <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                  </div>
                  Nenhum alerta nos selecionados
                </div>
              )}
              <AnimatePresence initial={false}>
                {alertasOrdenadosSplitSelecionados.map((a, i) => renderCardAlerta(a, { painel: painel2, index: i }))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>{/* MAIN BODY end */}

      {/* ================================================================
          PANICO OVERLAY
      ================================================================ */}
      {panicoAlerta && (
        <div style={{
          position: "fixed", inset: 0, zIndex: Z.panico,
          background: "rgba(100,0,0,0.15)", backdropFilter: "blur(3px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: "fadeInPanico .18s ease-out",
        }}
          onClick={e => { if (e.target === e.currentTarget) setPanicoAlerta(null); }}>
          <div style={{
            background: "#0e0000", border: "2px solid #ef4444",
            borderRadius: RAIO.panel, padding: "40px 56px 36px",
            textAlign: "center", maxWidth: 480, width: "90%",
            boxShadow: "0 0 0 1px #ef444416, 0 0 80px #ef444440",
            animation: "scalePanico .2s cubic-bezier(.34,1.56,.64,1)",
            fontFamily: FONT_SANS,
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: "#ef444418", border: "2px solid #ef4444",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 20px",
              animation: "pulsarPanico 1.2s ease-in-out infinite",
            }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/>
                <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>

            <div style={{ fontSize: 12, letterSpacing: ".04em", color: "#ef4444", fontWeight: 700, marginBottom: 12 }}>
              BOTÃO DE PÂNICO ACIONADO
            </div>

            <div style={{
              fontFamily: FONT_MONO, fontSize: 42, fontWeight: 900,
              color: "#ffffff", letterSpacing: ".04em", marginBottom: 16,
            }}>
              {panicoAlerta.placa}
            </div>

            {panicoAlerta.local && (
              <div style={{ fontSize: 13, color: "#a8a29e", marginBottom: 8, lineHeight: 1.4 }}>
                {panicoAlerta.local}
              </div>
            )}
            {panicoAlerta.motivo && (
              <div style={{ fontSize: 12, color: "#78716c", marginBottom: 8 }}>
                {panicoAlerta.motivo}
              </div>
            )}
            {panicoAlerta.velocidade != null && (
              <div style={{ fontSize: 12, color: "#78716c", marginBottom: 20, fontFamily: FONT_MONO }}>
                {panicoAlerta.velocidade} km/h &nbsp;·&nbsp; <span suppressHydrationWarning>{tempoAtras(panicoAlerta.desde)}</span> atras
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              {panicoAlerta.lat && panicoAlerta.lng && (
                <button
                  onClick={() => {
                    painel1.selecionarVeiculo(panicoAlerta!.cv, { lat: panicoAlerta!.lat!, lng: panicoAlerta!.lng! });
                    setPanicoAlerta(null);
                  }}
                  style={{
                    height: 40, padding: "0 20px", borderRadius: 8,
                    background: "#ef444414", border: "1px solid #ef444450",
                    color: "#ef4444", fontSize: 13, fontWeight: 700, cursor: "pointer",
                    fontFamily: FONT_SANS,
                  }}>
                  Ir para o veiculo
                </button>
              )}
              <button
                onClick={() => setPanicoAlerta(null)}
                style={{
                  height: 40, padding: "0 20px", borderRadius: 8,
                  background: "#ffffff10", border: "1px solid #ffffff20",
                  color: "#a8a29e", fontSize: 13, cursor: "pointer",
                  fontFamily: FONT_SANS,
                }}>
                Reconhecer
              </button>
              <button
                onClick={tocarPanico}
                title="Repetir som"
                style={{
                  height: 40, width: 40, borderRadius: 8,
                  background: "transparent", border: "1px solid #ffffff14",
                  color: "#78716c", fontSize: 16, cursor: "pointer",
                }}>
                ♪
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================
          SELETOR DE VEÍCULOS — "ver apenas selecionados" (Configurações)
      ================================================================ */}
      {seletorAberto && (
        <div style={{
          position: "fixed", inset: 0, zIndex: Z.panico,
          background: "rgba(0,0,0,0.55)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={e => { if (e.target === e.currentTarget) setSeletorAberto(false); }}>
          <div style={{
            width: "min(420px, 92vw)", maxHeight: "80vh",
            background: T.card, border: `1px solid ${T.border}`, borderRadius: RAIO.panel,
            boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
            display: "flex", flexDirection: "column", overflow: "hidden",
            fontFamily: FONT_SANS,
          }}>
            <div style={{
              padding: "14px 16px 10px", borderBottom: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
                Ver apenas veículos selecionados
              </span>
              <button onClick={() => setSeletorAberto(false)}
                style={{ background: "none", border: "none", color: T.dim, fontSize: 18, cursor: "pointer", lineHeight: 1 }}>
                ×
              </button>
            </div>

            <div style={{ padding: "10px 16px 6px" }}>
              <input
                autoFocus
                value={buscaSeletor}
                onChange={e => setBuscaSeletor(e.target.value)}
                placeholder="Digite a placa..."
                style={{
                  width: "100%", height: 32, borderRadius: RAIO.control, border: `1px solid ${T.border}`,
                  background: tema === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
                  color: T.text, padding: "0 10px", fontSize: 13,
                  fontFamily: FONT_MONO, outline: "none", boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ padding: "6px 16px 6px", display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={() => salvarVeiculosSelecionados(new Set(veiculosBase.map(v => v.cv)))}
                style={tinyBtn(T.accent)}>
                Marcar todos
              </button>
              <button onClick={() => salvarVeiculosSelecionados(new Set())} style={tinyBtn(T.dim)}>
                Limpar
              </button>
              <span style={{ marginLeft: "auto", fontSize: 12, color: T.dim, fontFamily: FONT_MONO }}>
                {veiculosSelecionados.size} selecionado{veiculosSelecionados.size === 1 ? "" : "s"}
              </span>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 10px", minHeight: 120 }}>
              {veiculosBase
                .filter(v => v.placa.toLowerCase().includes(buscaSeletor.toLowerCase()))
                .map(v => {
                  const marcado = veiculosSelecionados.has(v.cv);
                  return (
                    <button key={v.cv} onClick={() => toggleVeiculoSelecionado(v.cv)}
                      style={{
                        display: "flex", alignItems: "center", gap: 9, width: "100%",
                        padding: "7px 8px", borderRadius: RAIO.control, marginBottom: 2,
                        background: marcado ? `${T.accent}12` : "transparent",
                        border: "1px solid transparent", cursor: "pointer",
                        color: T.text, fontSize: 12, fontFamily: FONT_MONO, textAlign: "left",
                      }}>
                      <div style={{
                        width: 14, height: 14, borderRadius: RAIO.check, flexShrink: 0,
                        background: marcado ? T.accent : "transparent",
                        border: `1.5px solid ${marcado ? T.accent : T.dim}`,
                      }} />
                      {v.placa}
                    </button>
                  );
                })}
              {veiculosBase.length === 0 && (
                <div style={{ padding: "16px 8px", fontSize: 12, color: T.dim, textAlign: "center" }}>
                  Nenhum veículo carregado.
                </div>
              )}
            </div>

            <div style={{ padding: "10px 16px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 8 }}>
              <button onClick={() => { setModoSelecionadosSessao(false); setModoRomaneio(false); setSeletorAberto(false); }}
                style={{
                  flex: 1, height: 32, borderRadius: RAIO.control, border: `1px solid ${T.border}`,
                  background: "transparent", color: T.dim, fontSize: 12, cursor: "pointer", fontFamily: FONT_SANS,
                }}>
                Mostrar todos
              </button>
              <button onClick={() => { setModoSelecionadosSessao(true); setModoRomaneio(false); setSeletorAberto(false); }}
                disabled={veiculosSelecionados.size === 0}
                style={{
                  flex: 1, height: 32, borderRadius: RAIO.control, border: "none",
                  background: veiculosSelecionados.size === 0 ? T.border : T.accent,
                  color: veiculosSelecionados.size === 0 ? T.dim : "#fff",
                  fontSize: 12, fontWeight: 700,
                  cursor: veiculosSelecionados.size === 0 ? "default" : "pointer",
                  fontFamily: FONT_SANS,
                }}>
                Gerar mapa ({veiculosSelecionados.size})
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideInToast {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes fadeInPanico {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes scalePanico {
          from { transform: scale(.88); opacity: 0; }
          to   { transform: scale(1); opacity: 1; }
        }
        @keyframes pulsarPanico {
          0%, 100% { box-shadow: 0 0 0 0 #ef444438; }
          50%       { box-shadow: 0 0 0 12px #ef444406; }
        }
        .v2-btn, .v2-btn-tiny, .v2-drawer-btn, .v2-alert-card {
          transition: opacity 180ms ease, filter 180ms ease;
        }
        .v2-btn:hover { opacity: 0.72; }
        .v2-btn-tiny:hover { filter: brightness(1.18); }
        .v2-drawer-btn:hover { filter: brightness(1.12); }
        .v2-alert-card:hover { filter: brightness(1.05); }
      `}</style>
    </div>
  );
}
