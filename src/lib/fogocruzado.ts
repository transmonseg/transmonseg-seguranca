// Cliente da API Fogo Cruzado (tiroteios/disparos no RJ).
// Auth por email+senha (env), troca por token JWT de 1h. Lib de servidor:
// nunca importe no client (as credenciais ficam só no backend).
// Docs: https://api.fogocruzado.org.br/docs

const BASE = "https://api-service.fogocruzado.org.br/api/v2";
const RJ_STATE_ID = "b112ffbe-17b3-4ad0-8f2a-2038745d1d14";

export type Tiroteio = {
  lat: number;
  lng: number;
  date: string; // ISO
  bairro: string;
  cidade: string;
  motivo: string | null;
  vitimas: number;
  acaoPolicial: boolean;
  idadeMin: number; // minutos desde o evento
  recente: boolean; // "acontecendo agora": últimas 3h
};

// Cache do token em memória do processo (vale ~55min; o token expira em 1h).
let tokenCache: { token: string; exp: number } | null = null;

async function obterToken(): Promise<string | null> {
  const agora = Date.now();
  if (tokenCache && tokenCache.exp > agora) return tokenCache.token;

  const email = process.env.FOGO_CRUZADO_EMAIL;
  const senha = process.env.FOGO_CRUZADO_SENHA;
  if (!email || !senha) return null; // sem credenciais: camada simplesmente não aparece

  try {
    const r = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password: senha }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { accessToken?: string } };
    const token = j?.data?.accessToken;
    if (!token) return null;
    tokenCache = { token, exp: agora + 55 * 60 * 1000 };
    return token;
  } catch {
    return null;
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Cache da lista por nº de dias (TTL curto): o motor (1 min) e o mapa
// compartilham sem estourar o limite da API.
const listaCache = new Map<number, { tiros: Tiroteio[]; exp: number }>();

// Tiroteios do RJ nos últimos `dias`. Retorna [] em qualquer falha
// (camada opcional: nunca derruba o mapa). Cacheado por ~2 min.
export async function buscarTiroteiosRJ(dias = 1): Promise<Tiroteio[]> {
  const agoraMs = Date.now();
  const cached = listaCache.get(dias);
  if (cached && cached.exp > agoraMs) return cached.tiros;

  const token = await obterToken();
  if (!token) return cached?.tiros ?? [];

  const fim = new Date();
  const ini = new Date(fim.getTime() - dias * 24 * 60 * 60 * 1000);
  const fimMs = fim.getTime();
  const limite3h = fimMs - 3 * 60 * 60 * 1000;
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };

  const tiros: Tiroteio[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const url = `${BASE}/occurrences?idState=${RJ_STATE_ID}&initialdate=${ymd(ini)}&finaldate=${ymd(fim)}&order=DESC&take=100&page=${page}`;
      const r = await fetch(url, { headers });
      if (!r.ok) break;
      const j = (await r.json()) as { data?: RawOcorrencia[]; pageMeta?: { hasNextPage?: boolean } };
      for (const o of j.data ?? []) {
        const lat = parseFloat(String(o.latitude));
        const lng = parseFloat(String(o.longitude));
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
        const t = new Date(o.date).getTime();
        tiros.push({
          lat,
          lng,
          date: o.date,
          bairro: o?.neighborhood?.name ?? o?.subNeighborhood?.name ?? "",
          cidade: o?.city?.name ?? "",
          motivo: o?.contextInfo?.mainReason?.name ?? null,
          vitimas: Array.isArray(o.victims) ? o.victims.length : 0,
          acaoPolicial: Boolean(o.policeAction),
          idadeMin: Math.max(0, Math.round((fimMs - t) / 60000)),
          recente: t >= limite3h,
        });
      }
      if (!j.pageMeta?.hasNextPage) break;
    }
  } catch {
    return cached?.tiros ?? tiros;
  }
  listaCache.set(dias, { tiros, exp: agoraMs + 2 * 60 * 1000 });
  return tiros;
}

type RawOcorrencia = {
  latitude: string | number;
  longitude: string | number;
  date: string;
  policeAction?: boolean;
  neighborhood?: { name?: string };
  subNeighborhood?: { name?: string };
  city?: { name?: string };
  contextInfo?: { mainReason?: { name?: string } };
  victims?: unknown[];
};

// Ocorrencias num periodo arbitrario (nao so "ativas") — usado pro perfil
// horario (camada 3 do desvio), nao pro tempo real. Mesma auth/paginacao de
// buscarTiroteiosRJ; teto de 20 paginas (2000 ocorrencias) pra nao rodar
// indefinidamente se o periodo pedido for muito longo.
async function buscarOcorrenciasPeriodo(inicio: Date, fim: Date): Promise<Tiroteio[]> {
  const token = await obterToken();
  if (!token) return [];
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const fimMs = fim.getTime();
  const tiros: Tiroteio[] = [];
  try {
    for (let page = 1; page <= 20; page++) {
      const url = `${BASE}/occurrences?idState=${RJ_STATE_ID}&initialdate=${ymd(inicio)}&finaldate=${ymd(fim)}&order=DESC&take=100&page=${page}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) break;
      const j = (await r.json()) as { data?: RawOcorrencia[]; pageMeta?: { hasNextPage?: boolean } };
      for (const o of j.data ?? []) {
        const lat = parseFloat(String(o.latitude));
        const lng = parseFloat(String(o.longitude));
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;
        const t = new Date(o.date).getTime();
        tiros.push({
          lat, lng, date: o.date,
          bairro: o?.neighborhood?.name ?? o?.subNeighborhood?.name ?? "",
          cidade: o?.city?.name ?? "",
          motivo: o?.contextInfo?.mainReason?.name ?? null,
          vitimas: Array.isArray(o.victims) ? o.victims.length : 0,
          acaoPolicial: Boolean(o.policeAction),
          idadeMin: Math.max(0, Math.round((fimMs - t) / 60000)),
          recente: false,
        });
      }
      if (!j.pageMeta?.hasNextPage) break;
    }
  } catch {
    return tiros; // parcial: melhor um perfil com menos dado que nenhum
  }
  return tiros;
}

// Perfil horario "aoristic" simples (0-23, horario de Brasilia): conta
// ocorrencias por hora do dia com shrinkage (suavizacao tipo Laplace) em
// direcao a media uniforme — evita que uma hora com poucos eventos
// historicos vire um fator extremo por ruido estatistico. Retorna fator
// MULTIPLICATIVO por hora, clampado a [FATOR_HORARIO_MIN, FATOR_HORARIO_MAX]
// (consenso da literatura STKDE/aoristic: fator, nunca bonus fixo somado).
// Funcao pura — nao faz I/O, so recebe ocorrencias ja buscadas.
export function calcularPerfilHorario(
  ocorrencias: { date: string }[],
  pseudoContagem = 24
): number[] {
  const porHora = new Array(24).fill(0) as number[];
  for (const o of ocorrencias) {
    const d = new Date(o.date);
    if (isNaN(d.getTime())) continue;
    const hora = parseInt(
      new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(d),
      10
    );
    if (hora >= 0 && hora <= 23) porHora[hora]++;
  }
  const total = porHora.reduce((a, b) => a + b, 0);
  if (total === 0) return new Array(24).fill(1);

  const FATOR_HORARIO_MIN = 0.7;
  const FATOR_HORARIO_MAX = 1.6;
  return porHora.map((n) => {
    // Dirichlet/Laplace smoothing em direcao a taxa uniforme (1/24 por hora).
    const taxaSuavizada = (n + pseudoContagem / 24) / (total + pseudoContagem);
    const fator = taxaSuavizada * 24;
    return Math.min(FATOR_HORARIO_MAX, Math.max(FATOR_HORARIO_MIN, fator));
  });
}

// Cache do perfil horario (24h) — recalculado 1x/dia, nao a cada ciclo do
// motor. Fonte: Fogo Cruzado (unico dado ja integrado com timestamp preciso
// por ocorrencia — o roubo_carga do ISP-RJ e so contagem mensal, sem hora).
let perfilHorarioCache: { perfil: number[]; exp: number } | null = null;
const JANELA_PERFIL_DIAS = 60;

export async function obterPerfilHorario(): Promise<number[]> {
  const agoraMs = Date.now();
  if (perfilHorarioCache && perfilHorarioCache.exp > agoraMs) return perfilHorarioCache.perfil;

  try {
    const fim = new Date();
    const inicio = new Date(fim.getTime() - JANELA_PERFIL_DIAS * 24 * 60 * 60 * 1000);
    const ocorrencias = await buscarOcorrenciasPeriodo(inicio, fim);
    // Mesmo filtro do tempo real: operacao policial de rotina nao e sinal
    // de risco de assalto, nao deve enviesar o perfil horario.
    const relevantes = ocorrencias.filter((o) => !o.acaoPolicial);
    const perfil = calcularPerfilHorario(relevantes);
    perfilHorarioCache = { perfil, exp: agoraMs + 24 * 60 * 60 * 1000 };
    return perfil;
  } catch {
    return perfilHorarioCache?.perfil ?? new Array(24).fill(1);
  }
}
