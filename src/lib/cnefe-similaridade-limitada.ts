// Incidente real 01/10/2026: uma geracao do KPI Rio Quality com ~1.800
// enderecos novos fez a ponte /api/romaneio/geocode disparar ate' 10
// chamadas SIMULTANEAS da RPC cnefe_buscar_por_similaridade (pg_trgm sobre
// o CNEFE inteiro, 5-15s cada) -- o pre-check de ponto de referencia roda
// Promise.all sobre o lote inteiro. O Postgres ficou com CPU 100% por ~1h30
// e a geracao da Nutry Max (mesmo banco) nao conseguia gerar.
//
// Tudo que passa por aqui divide UM semaforo por processo (guardado em
// globalThis: o Next empacota cada rota separado e um `let` de modulo
// poderia virar duas instancias), entao duas geracoes simultaneas somam no
// mesmo teto. Timeout por busca: o chamador segue sem a resposta (passo
// "nao achado"), mas a vaga so' volta quando a consulta termina de verdade
// -- o banco continua trabalhando nela -- ou no aborto duro.

export const MAX_BUSCAS_SIMILARIDADE_SIMULTANEAS = 2;
export const TIMEOUT_BUSCA_SIMILARIDADE_MS = 20_000;
// Aborto duro da requisicao HTTP ao PostgREST: libera a vaga mesmo se a
// resposta nunca chegar (sem isso uma consulta pendurada prenderia 1 das 2
// vagas pra sempre).
export const ABORTO_BUSCA_SIMILARIDADE_MS = 90_000;

export type Semaforo = {
  readonly limite: number;
  executar<T>(fn: () => Promise<T>): Promise<T>;
  emUso(): number;
};

export function criarSemaforo(limite: number): Semaforo {
  let ativos = 0;
  const fila: (() => void)[] = [];
  const liberar = () => {
    ativos--;
    const proximo = fila.shift();
    if (proximo) {
      ativos++;
      proximo();
    }
  };
  return {
    limite,
    emUso: () => ativos,
    async executar<T>(fn: () => Promise<T>): Promise<T> {
      if (ativos < limite) ativos++;
      else await new Promise<void>((r) => fila.push(r));
      try {
        return await fn();
      } finally {
        liberar();
      }
    },
  };
}

const CHAVE_GLOBAL = "__semaforoSimilaridadeCnefe";
export function semaforoSimilaridadeGlobal(): Semaforo {
  const g = globalThis as unknown as Record<string, Semaforo | undefined>;
  return (g[CHAVE_GLOBAL] ??= criarSemaforo(MAX_BUSCAS_SIMILARIDADE_SIMULTANEAS));
}

export type ResultadoBuscaSimilaridade<T> = { status: "ok"; data: T[] } | { status: "timeout" } | { status: "pulado" };

export async function buscarSimilaridadeLimitada<T>(
  consulta: (sinal: AbortSignal) => Promise<T[]>,
  opcoes: { semaforo?: Semaforo; timeoutMs?: number; abortoMs?: number; pular?: boolean; rotulo?: string } = {},
): Promise<ResultadoBuscaSimilaridade<T>> {
  if (opcoes.pular) return { status: "pulado" };
  const semaforo = opcoes.semaforo ?? semaforoSimilaridadeGlobal();
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_BUSCA_SIMILARIDADE_MS;
  const abortoMs = opcoes.abortoMs ?? ABORTO_BUSCA_SIMILARIDADE_MS;

  return new Promise((resolve) => {
    let respondido = false;
    const responder = (r: ResultadoBuscaSimilaridade<T>) => {
      if (respondido) return;
      respondido = true;
      resolve(r);
    };
    semaforo
      .executar(async () => {
        const ctrl = new AbortController();
        const timerAborto = setTimeout(() => ctrl.abort(), abortoMs);
        // O relogio do timeout so' corre depois de pegar a vaga -- esperar
        // na fila nao conta (senao a fila em si derrubaria todo mundo).
        const timerTimeout = setTimeout(() => {
          console.warn(
            `[cnefe-similaridade] busca passou de ${timeoutMs}ms${opcoes.rotulo ? ` (${opcoes.rotulo})` : ""} -- segue sem esse passo`,
          );
          responder({ status: "timeout" });
        }, timeoutMs);
        try {
          const data = await consulta(ctrl.signal);
          responder({ status: "ok", data: data ?? [] });
        } catch {
          responder({ status: "ok", data: [] });
        } finally {
          clearTimeout(timerAborto);
          clearTimeout(timerTimeout);
        }
      })
      .catch(() => responder({ status: "ok", data: [] }));
  });
}
