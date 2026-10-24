// Escolha do ponto do cliente entre os candidatos do CNEFE (auditoria 20/10,
// geocodificacao.md GEO-02/03/04/05/07). Funcao PURA, sem I/O.
//
// Antes: o CEP do romaneio era ignorado, o desempate entre homonimos era a
// distancia ate um centroide do Nominatim, "numero mais proximo" aceitava o
// S/N do CNEFE (numero '0') e qualquer diferenca, e S/N sorteava 1 de 200
// pontos sem ORDER BY -- tudo saia como "confiavel". Agora:
//   1. subconjunto pelo CEP especifico do endereco; senao pela localidade do
//      Censo que bate com o bairro; senao a rua toda (sem confirmacao);
//   2. numero exato no subconjunto -> exato;
//   3. numero ausente -> interpola entre os vizinhos (mesma paridade quando
//      der) ou usa o vizinho a <= 20 numeros -> interpolado;
//   4. senao (e S/N) -> ponto central do subconjunto, com raio = metade da
//      extensao -> trecho (<= 300 m) ou rua.
// `confirmado` diz se o subconjunto veio do CEP/bairro: sem isso o chamador
// continua aplicando o teto de distancia ate' a referencia (rua homonima em
// outro bairro).

export type CandidatoCnefe = { lat: number; lng: number; numero?: string | null; cep?: string | null; localidade?: string | null; tipo?: string | null };
export type PrecisaoPonto = "exato" | "interpolado" | "trecho" | "rua";
export type PontoCnefe = { lat: number; lng: number; precisao: PrecisaoPonto; raioM: number; confirmado: boolean };

const DIF_MAX_VIZINHO = 20;
const DIF_MAX_INTERPOLACAO = 200;
const DIST_MAX_INTERPOLACAO_M = 600;
const ESPALHAMENTO_MAX_EXATO_M = 150;
const RAIO_MAX_TRECHO_M = 300;

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function extrairCepDoEndereco(enderecoBruto: string): string | null {
  const m = enderecoBruto.match(/(\d{5})-?(\d{3})\s*$/);
  return m ? m[1] + m[2] : null;
}

function cepEspecifico(cep: string | null | undefined): cep is string {
  return !!cep && /^\d{8}$/.test(cep) && !cep.endsWith("000");
}

function normalizarLocalidade(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function localidadeBate(localidade: string | null | undefined, bairro: string | null): boolean {
  if (!localidade || !bairro) return false;
  const a = normalizarLocalidade(localidade);
  const b = normalizarLocalidade(bairro);
  if (a.length < 4 || b.length < 4) return a === b;
  return a === b || a.includes(b) || b.includes(a);
}

// Numero do CNEFE como inteiro; '0' (S/N no CNEFE) e sem digito -> null.
function numeroCnefe(n: string | null | undefined): number | null {
  if (!n) return null;
  const m = String(n).match(/\d+/);
  if (!m) return null;
  const v = Number(m[0]);
  return v > 0 ? v : null;
}

// Ponto central deterministico: o candidato real mais perto da mediana das
// coordenadas (ordem dos candidatos nao importa). Raio = maior distancia
// desse ponto ate' os demais.
function pontoCentral(cands: CandidatoCnefe[]): { lat: number; lng: number; raioM: number } {
  const med = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const alvo = { lat: med(cands.map((x) => x.lat)), lng: med(cands.map((x) => x.lng)) };
  let melhor = cands[0];
  let menor = Infinity;
  for (const x of cands) {
    const d = haversineM(alvo, x);
    if (d < menor || (d === menor && (x.lat < melhor.lat || (x.lat === melhor.lat && x.lng < melhor.lng)))) { menor = d; melhor = x; }
  }
  const raioM = Math.round(Math.max(...cands.map((x) => haversineM(melhor, x))));
  return { lat: melhor.lat, lng: melhor.lng, raioM };
}

// GEO-06 (auditoria 20/10): o nome normalizado descarta o tipo -- ENTRADA e
// ESTRADA da Fazenda Inglesa viravam a mesma rua. Tipo canonico dos dois lados
// (abreviacao do romaneio, "1A TRAVESSA DA RUA" do CNEFE).
const TIPOS: [RegExp, string][] = [
  [/^(R|RUA)$/, "RUA"], [/^(AV|AVN|AVENIDA)$/, "AVENIDA"], [/^(EST|ESTR|ESTRADA)$/, "ESTRADA"],
  [/^(ROD|RODOVIA)$/, "RODOVIA"], [/^(TV|TRAV|TRAVESSA)$/, "TRAVESSA"], [/^(AL|ALAMEDA)$/, "ALAMEDA"],
  [/^(PC|PCA|PRACA)$/, "PRACA"], [/^ENTRADA$/, "ENTRADA"], [/^(BC|BECO)$/, "BECO"], [/^(LG|LARGO)$/, "LARGO"],
];
export function tipoCanonico(tipo: string | null | undefined): string | null {
  if (!tipo) return null;
  const t = normalizarLocalidade(tipo);
  if (/\bTRAVESSA\b/.test(t)) return "TRAVESSA";
  for (const [re, canon] of TIPOS) if (re.test(t)) return canon;
  return t || null;
}

// Filtra pelo tipo pedido quando ha' candidato desse tipo no `universo` (por
// padrao a propria lista); candidato sem tipo nunca e' descartado. Sem tipo
// pedido ou sem nenhum candidato do tipo, devolve a lista inteira (nao perde o
// endereco). F2-14: os fallbacks de geocodificarCnefe passam a rua inteira
// como universo, para o numero exato de OUTRO tipo nao ganhar da via pedida.
export function filtrarPorTipo<T extends CandidatoCnefe>(cands: T[], tipo: string | null | undefined, universo: CandidatoCnefe[] = cands): T[] {
  const tipoAlvo = tipoCanonico(tipo);
  if (!tipoAlvo) return cands;
  const doTipo = (x: CandidatoCnefe) => x.tipo != null && tipoCanonico(x.tipo) === tipoAlvo;
  if (!universo.some(doTipo)) return cands;
  return [...cands.filter(doTipo), ...cands.filter((x) => x.tipo == null)];
}

export function escolherPontoCnefe(
  candidatos: CandidatoCnefe[],
  alvo: { numero: number | null; cep: string | null; bairro: string | null; tipo?: string | null },
): PontoCnefe | null {
  if (candidatos.length === 0) return null;
  let sub: CandidatoCnefe[] = [];
  if (cepEspecifico(alvo.cep)) sub = candidatos.filter((x) => x.cep === alvo.cep);
  if (sub.length === 0) sub = candidatos.filter((x) => localidadeBate(x.localidade, alvo.bairro));
  const confirmado = sub.length > 0;
  if (!confirmado) {
    sub = candidatos;
    // O tipo so' desempata sem CEP/bairro confirmando: o IBGE grava a mesma via
    // com outro tipo (RUA NATAL = PRACA NATAL; ESTRADA = ENTRADA DO GUANDU DO
    // SENA) e, com o CEP batendo, filtrar pelo tipo jogava fora o ponto certo
    // (medicao 21/10: 2 de 2.136 foram parar a 0,4 e 41 km).
    sub = filtrarPorTipo(sub, alvo.tipo);
  }

  if (alvo.numero != null) {
    const exatos = sub.filter((x) => numeroCnefe(x.numero) === alvo.numero);
    // Exato de varias localidades (sem confirmacao): prefere o do bairro.
    const exatosBairro = exatos.filter((x) => localidadeBate(x.localidade, alvo.bairro));
    const usar = exatosBairro.length > 0 ? exatosBairro : exatos;
    if (usar.length > 0) {
      const p = pontoCentral(usar);
      if (p.raioM <= ESPALHAMENTO_MAX_EXATO_M) return { lat: p.lat, lng: p.lng, precisao: "exato", raioM: Math.max(30, p.raioM), confirmado: confirmado || exatosBairro.length > 0 };
      return { lat: p.lat, lng: p.lng, precisao: "rua", raioM: p.raioM, confirmado };
    }
    const comNumero = sub.map((x) => ({ x, n: numeroCnefe(x.numero) })).filter((y): y is { x: CandidatoCnefe; n: number } => y.n != null);
    const vizinhos = (mesmaParidade: boolean) => {
      const ok = comNumero.filter((y) => !mesmaParidade || y.n % 2 === alvo.numero! % 2);
      const lo = ok.filter((y) => y.n < alvo.numero!).sort((a, b) => b.n - a.n || a.x.lat - b.x.lat)[0];
      const hi = ok.filter((y) => y.n > alvo.numero!).sort((a, b) => a.n - b.n || a.x.lat - b.x.lat)[0];
      return { lo, hi };
    };
    for (const mesma of [true, false]) {
      const { lo, hi } = vizinhos(mesma);
      if (lo && hi && hi.n - lo.n <= DIF_MAX_INTERPOLACAO && haversineM(lo.x, hi.x) <= DIST_MAX_INTERPOLACAO_M) {
        const t = (alvo.numero - lo.n) / (hi.n - lo.n);
        return {
          lat: lo.x.lat + (hi.x.lat - lo.x.lat) * t,
          lng: lo.x.lng + (hi.x.lng - lo.x.lng) * t,
          precisao: "interpolado",
          raioM: Math.max(30, Math.round(haversineM(lo.x, hi.x) / 2)),
          confirmado,
        };
      }
    }
    const perto = comNumero
      .map((y) => ({ ...y, dif: Math.abs(y.n - alvo.numero!) }))
      .filter((y) => y.dif <= DIF_MAX_VIZINHO)
      .sort((a, b) => a.dif - b.dif || a.x.lat - b.x.lat || a.x.lng - b.x.lng)[0];
    if (perto) return { lat: perto.x.lat, lng: perto.x.lng, precisao: "interpolado", raioM: 50, confirmado };
    // Sem vizinho perto: o numero mais proximo DENTRO do trecho certo ainda
    // localiza melhor que o centro do trecho em rua longa (achado 05/09;
    // medido 20/10 contra o cadastro Unitrac). Precisao fica "rua".
    const maisPerto = comNumero
      .map((y) => ({ ...y, dif: Math.abs(y.n - alvo.numero!) }))
      .sort((a, b) => a.dif - b.dif || a.x.lat - b.x.lat || a.x.lng - b.x.lng)[0];
    if (maisPerto) return { lat: maisPerto.x.lat, lng: maisPerto.x.lng, precisao: "rua", raioM: pontoCentral(sub).raioM, confirmado };
  }

  const p = pontoCentral(sub);
  return { lat: p.lat, lng: p.lng, precisao: p.raioM <= RAIO_MAX_TRECHO_M ? "trecho" : "rua", raioM: p.raioM, confirmado };
}
