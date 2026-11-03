// Transporte da Central (RAS-06, auditoria 03/11): polls de /api/mapa e
// /api/alertas(-romaneio).
//   - saúde por FONTE: antes um carimbo só servia aos dois polls, e o mapa
//     falhando com os alertas ok nunca avisava;
//   - 401 = sessão vencida: para o poll e mostra a mensagem (dentro do iframe
//     da Central o operador não tem como renovar sem reabrir);
//   - fetch com AbortSignal.timeout(20 s) e descarte de resposta mais velha
//     que uma já aplicada (polls sobrepostos);
//   - pausa com a aba escondida e poll imediato quando ela volta.
export type FontePoll = "mapa" | "alertas";
export type ResultadoPoll = "ok" | "falha" | "sessao_vencida";

export const MSG_SESSAO_VENCIDA = "Sessão vencida, abra o monitoramento de novo pela Central";
export const TIMEOUT_POLL_MS = 20_000;
export const LIMIAR_DADO_PARADO_MS = 90_000;
export const FALHAS_PARA_AVISO = 3;

type SaudeFonte = { ultimoOk: number; falhasSeguidas: number };
export type SaudeTransporte = { mapa: SaudeFonte; alertas: SaudeFonte; sessaoVencida: boolean };

export function saudeInicial(agora: number): SaudeTransporte {
  return { mapa: { ultimoOk: agora, falhasSeguidas: 0 }, alertas: { ultimoOk: agora, falhasSeguidas: 0 }, sessaoVencida: false };
}

export function registrarPoll(s: SaudeTransporte, fonte: FontePoll, r: ResultadoPoll, agora: number): SaudeTransporte {
  if (r === "sessao_vencida") return { ...s, sessaoVencida: true };
  const f = r === "ok" ? { ultimoOk: agora, falhasSeguidas: 0 } : { ...s[fonte], falhasSeguidas: s[fonte].falhasSeguidas + 1 };
  return { ...s, [fonte]: f };
}

const NOME_FONTE: Record<FontePoll, string> = { mapa: "mapa", alertas: "alertas" };

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Aviso a mostrar (pior das duas fontes), ou null. */
export function avisoTransporte(s: SaudeTransporte, agora: number): { tipo: "sessao_vencida" | "desatualizado"; texto: string } | null {
  if (s.sessaoVencida) return { tipo: "sessao_vencida", texto: MSG_SESSAO_VENCIDA };
  const paradas = (["mapa", "alertas"] as const).filter(
    (f) => s[f].falhasSeguidas >= FALHAS_PARA_AVISO || agora - s[f].ultimoOk > LIMIAR_DADO_PARADO_MS,
  );
  if (!paradas.length) return null;
  const desde = Math.min(...paradas.map((f) => s[f].ultimoOk));
  const quais = paradas.map((f) => NOME_FONTE[f]).join(" e ");
  return { tipo: "desatualizado", texto: `⚠ ${quais[0].toUpperCase()}${quais.slice(1)} sem atualização desde ${hhmm(desde)}: os dados na tela podem estar desatualizados.` };
}

type DocMinimo = {
  hidden: boolean;
  addEventListener(t: "visibilitychange", f: () => void): void;
  removeEventListener(t: "visibilitychange", f: () => void): void;
};

/** Respostas 401 seguidas antes de considerar a sessão vencida e parar o poll. */
export const LIMITE_401_SEGUIDOS = 3;

export function criarPoll<T>(o: {
  url: () => string;
  intervaloMs: number;
  aoReceber: (dados: T) => void;
  aoResultado: (r: ResultadoPoll) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  doc?: DocMinimo;
  /** false = continua rodando com a aba escondida (poll de alertas: é ele que toca o som de pânico/desvio). */
  pausarComAbaOculta?: boolean;
}): { parar(): void } {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const doc = o.pausarComAbaOculta === false
    ? undefined
    : (o.doc ?? (typeof document !== "undefined" ? document : undefined));
  let seguidos401 = 0;
  let seq = 0;
  let aplicado = 0;
  let parado = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    if (parado) return;
    const meu = ++seq;
    try {
      const res = await f(o.url(), { signal: AbortSignal.timeout(TIMEOUT_POLL_MS) });
      if (parado) return;
      if (res.status === 401) {
        // Uma renovação de sessão que falha uma vez (ex.: login reiniciando) não pode parar o poll de vez.
        if (++seguidos401 >= LIMITE_401_SEGUIDOS) {
          parar();
          o.aoResultado("sessao_vencida");
        } else {
          o.aoResultado("falha");
        }
        return;
      }
      seguidos401 = 0;
      if (!res.ok) { o.aoResultado("falha"); return; }
      const dados = (await res.json()) as T;
      if (parado || meu < aplicado) return; // resposta mais velha que uma já aplicada
      aplicado = meu;
      o.aoReceber(dados);
      o.aoResultado("ok");
    } catch {
      if (!parado) o.aoResultado("falha");
    }
  };

  const iniciar = () => {
    if (timer || parado) return;
    tick();
    timer = setInterval(tick, o.intervaloMs);
  };
  const pausar = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const aoMudarVisibilidade = () => (doc?.hidden ? pausar() : iniciar());

  function parar() {
    parado = true;
    pausar();
    doc?.removeEventListener("visibilitychange", aoMudarVisibilidade);
  }

  doc?.addEventListener("visibilitychange", aoMudarVisibilidade);
  if (!doc?.hidden) iniciar();
  return { parar };
}
