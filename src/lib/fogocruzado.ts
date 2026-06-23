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
