// Geocodificacao por COERENCIA DE GRUPO -- achado real 05/09 (romaneio Rio
// Quality): o romaneio traz so' o NOME DA RUA por parada (sem numero, bairro
// ou cidade). Rua isolada e' loteria -- "RUA NOVE" existe em dezenas de
// municipios do RJ (na mesma rota, a cascata normal jogou uma parada na Mare
// e a seguinte em Duque de Caxias). Mas as paradas de um MESMO caminhao no
// mesmo dia ficam numa regiao compacta, e uma parte das ruas e' UNICA no
// estado (ex.: "AVENIDA AUTOMOVEL CLUBE", "ESTRADA DO MENDANHA") -- essas
// viram ANCORAS, e cada rua ambigua escolhe o candidato mais perto da
// ancora mais proxima.
//
// A ORDEM das paradas NAO entra no calculo de proposito: confirmado contra
// o alvoordem da Unitrac que a ordem das linhas do xlsx nao e' a ordem da
// rota (mesmas ruas, sequencia completamente diferente). Uma primeira versao
// por caminho minimo (Viterbi) media 38% dos pontos a <=1km do gabarito; o
// modelo de aglomerado por ancoras mediu 95% a <=1km / 88% a <=500m (zonas
// urbanas, gabarito = alvos confirmados por GPS na Unitrac do mesmo dia).
//
// Lib PURA (sem banco, sem fetch): os candidatos vem de fora (ver
// cnefe_candidatos_por_rua na migration 071 e a rota
// /api/romaneio/geocode-coerencia). Nunca importe nada de 'next' aqui.

export type CandidatoCluster = {
  municipioCodigo: string; // IBGE 7 digitos
  lat: number;
  lng: number;
  qtd: number; // quantos enderecos CNEFE no aglomerado (densidade)
  similaridade: number; // 1 = match exato do nome; <1 = veio do pg_trgm
};

export type ParadaEntrada = { nomeNormalizado: string };

export type Confianca = "alta" | "media" | "baixa" | "sem_candidato" | "isolado";

export type ResultadoParada = {
  lat: number | null;
  lng: number | null;
  municipioCodigo: string | null;
  confianca: Confianca;
  candidatos: number; // quantos candidatos restaram depois do prior de zona
  ancora: boolean;
};

// Raio (m) pra promover uma escolha a ancora / confianca alta. 2,5km cobre
// um bairro grande; acima disso ate' 8km ainda e' "mesma regiao" (media).
export const RAIO_ANCORA_M = 2_500;
export const RAIO_MEDIA_M = 8_000;
const ITERACOES_MAX = 6;

// Zonas GENERICAS (geografia do RJ), nao o nome da rota de um cliente
// especifico -- quem sabe que "SUDOESTE 2" e' capital ou "R. SERRRANA 1" e'
// serrana e' o parser do cliente (lado do KPI), que traduz pra uma dessas.
// Prior FRACO: so' descarta candidato fora da zona se sobrar algum dentro
// (rota pode cruzar a fronteira -- Itaguai atende Baixada e Costa Verde).
const ZONAS: Record<string, string[]> = {
  CAPITAL: ["3304557"],
  BAIXADA: [
    "3301702", // Duque de Caxias
    "3303500", // Nova Iguacu
    "3300456", // Belford Roxo
    "3305109", // Sao Joao de Meriti
    "3303203", // Nilopolis
    "3302858", // Mesquita
    "3304144", // Queimados
    "3302270", // Japeri
    "3302502", // Mage
    "3301850", // Guapimirim
    "3305554", // Seropedica
    "3302007", // Itaguai
    "3303609", // Paracambi
  ],
  LESTE: [
    "3303302", // Niteroi
    "3304904", // Sao Goncalo
    "3302700", // Marica
    "3301900", // Itaborai
    "3305752", // Tangua
    "3304300", // Rio Bonito
  ],
  LAGOS: [
    "3300704", // Cabo Frio
    "3300233", // Armacao dos Buzios
    "3300258", // Arraial do Cabo
    "3305208", // Sao Pedro da Aldeia
    "3300209", // Araruama
    "3305505", // Saquarema
    "3301876", // Iguaba Grande
    "3304524", // Rio das Ostras
    "3301306", // Casimiro de Abreu
    "3305604", // Silva Jardim
    "3302403", // Macae
  ],
  SERRANA: [
    "3303906", // Petropolis
    "3305802", // Teresopolis
    "3303401", // Nova Friburgo
    "3306008", // Tres Rios
    "3303708", // Paraiba do Sul
    "3300225", // Areal
    "3300506", // Bom Jardim
    "3301504", // Cordeiro
    "3301108", // Cantagalo
    "3301207", // Carmo
    "3305703", // Sumidouro
    "3301603", // Duas Barras
    "3305158", // Sao Jose do Vale do Rio Preto
    "3305406", // Sapucaia
    "3300803", // Cachoeiras de Macacu
    "3301850", // Guapimirim
  ],
  SUL_FLUMINENSE: [
    "3306305", // Volta Redonda
    "3300407", // Barra Mansa
    "3304201", // Resende
    "3302254", // Itatiaia
    "3304110", // Porto Real
    "3304128", // Quatis
    "3300308", // Barra do Pirai
    "3304003", // Pirai
    "3303955", // Pinheiral
    "3306107", // Valenca
    "3306206", // Vassouras
    "3304409", // Rio Claro
    "3304508", // Rio das Flores
    "3302809", // Mendes
    "3301801", // Engenheiro Paulo de Frontin
    "3302908", // Miguel Pereira
    "3303856", // Paty do Alferes
  ],
  NORTE_FLUMINENSE: [
    "3301009", // Campos dos Goytacazes
    "3302403", // Macae
    "3305000", // Sao Joao da Barra
    "3304151", // Quissama
    "3300936", // Carapebus
    "3301405", // Conceicao de Macabu
    "3304805", // Sao Fidelis
    "3302205", // Itaperuna
    "3300605", // Bom Jesus do Itabapoana
    "3304755", // Sao Francisco de Itabapoana
    "3301157", // Cardoso Moreira
    "3302056", // Italva
  ],
  COSTA_VERDE: [
    "3300100", // Angra dos Reis
    "3303807", // Parati
    "3302601", // Mangaratiba
    "3302007", // Itaguai
  ],
};

export function municipiosDaZona(zona: string | null | undefined): Set<string> | null {
  if (!zona) return null;
  const lista = ZONAS[zona.toUpperCase()];
  return lista ? new Set(lista) : null;
}

export function zonasConhecidas(): string[] {
  return Object.keys(ZONAS);
}

function distanciaM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = ((b.lat - a.lat) * Math.PI) / 180;
  const dl = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function ehExato(c: CandidatoCluster): boolean {
  return c.similaridade >= 0.999;
}

export function resolverGrupoPorCoerencia(
  paradas: ParadaEntrada[],
  candidatosPorNome: Map<string, CandidatoCluster[]>,
  municipiosZona: Set<string> | null,
): ResultadoParada[] {
  const n = paradas.length;

  // 1) candidatos por parada, com prior fraco de zona
  const cands: CandidatoCluster[][] = paradas.map((p) => {
    const todos = candidatosPorNome.get(p.nomeNormalizado) ?? [];
    if (!municipiosZona) return todos;
    const dentro = todos.filter((c) => municipiosZona.has(c.municipioCodigo));
    return dentro.length > 0 ? dentro : todos;
  });

  const escolha: (CandidatoCluster | null)[] = new Array(n).fill(null);
  const ancora: boolean[] = new Array(n).fill(false);

  // 2) ancoras iniciais: 1 candidato EXATO (similaridade nunca ancora sozinha)
  for (let i = 0; i < n; i++) {
    if (cands[i].length === 1 && ehExato(cands[i][0])) {
      escolha[i] = cands[i][0];
      ancora[i] = true;
    }
  }

  // 3) sem ancora nenhuma: semente = par de candidatos (de paradas diferentes)
  //    mais proximos entre si -- o aglomerado mais denso do grupo. Grupo
  //    semeado assim nunca passa de "media": duas ruas ambiguas proximas se
  //    corroboram, mas pode ser coincidencia (sem rua unica confirmando).
  const temAncoraVerdadeira = ancora.some(Boolean);
  if (!temAncoraVerdadeira && n > 0) {
    let melhor: { i: number; a: CandidatoCluster; j: number; b: CandidatoCluster; d: number } | null = null;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (const a of cands[i]) {
          for (const b of cands[j]) {
            const d = distanciaM(a, b);
            if (!melhor || d < melhor.d) melhor = { i, a, j, b, d };
          }
        }
      }
    }
    if (melhor) {
      escolha[melhor.i] = melhor.a;
      escolha[melhor.j] = melhor.b;
      ancora[melhor.i] = true;
      ancora[melhor.j] = true;
    } else {
      // grupo de 1 parada ambigua: pega o aglomerado mais denso
      for (let i = 0; i < n; i++) {
        if (cands[i].length > 0) {
          escolha[i] = cands[i].reduce((m, c) => (c.qtd > m.qtd ? c : m));
        }
      }
    }
  }

  // 4) itera: cada ambigua escolhe o candidato mais perto da ancora mais proxima;
  //    quem ficou a <= RAIO_ANCORA_M de uma ancora (e e' exato) vira ancora tambem.
  for (let iter = 0; iter < ITERACOES_MAX; iter++) {
    const pontosAncora = escolha.filter((c, i): c is CandidatoCluster => ancora[i] && c !== null);
    if (pontosAncora.length === 0) break;
    let mudou = false;
    for (let i = 0; i < n; i++) {
      if (ancora[i] || cands[i].length === 0) continue;
      let melhorC: CandidatoCluster | null = null;
      let melhorD = Infinity;
      for (const c of cands[i]) {
        const d = Math.min(...pontosAncora.map((a) => distanciaM(a, c)));
        if (d < melhorD) {
          melhorD = d;
          melhorC = c;
        }
      }
      if (melhorC && escolha[i] !== melhorC) {
        escolha[i] = melhorC;
        mudou = true;
      }
    }
    for (let i = 0; i < n; i++) {
      const c = escolha[i];
      if (ancora[i] || !c || !ehExato(c)) continue;
      const d = Math.min(...pontosAncora.map((a) => distanciaM(a, c)));
      if (d <= RAIO_ANCORA_M) {
        ancora[i] = true;
        mudou = true;
      }
    }
    if (!mudou) break;
  }

  // 5) confianca
  return paradas.map((_, i): ResultadoParada => {
    const c = escolha[i];
    if (!c) {
      return { lat: null, lng: null, municipioCodigo: null, confianca: "sem_candidato", candidatos: cands[i].length, ancora: false };
    }
    const outrasAncoras = escolha.filter((o, k): o is CandidatoCluster => k !== i && ancora[k] && o !== null);
    let confianca: Confianca;
    if (outrasAncoras.length === 0) {
      confianca = cands[i].length === 1 && ehExato(c) ? "alta" : ancora[i] ? "media" : "isolado";
    } else {
      const d = Math.min(...outrasAncoras.map((a) => distanciaM(a, c)));
      confianca = cands[i].length === 1 || d <= RAIO_ANCORA_M ? "alta" : d <= RAIO_MEDIA_M ? "media" : "baixa";
    }
    if (!temAncoraVerdadeira && confianca === "alta") confianca = "media";
    // veio de similaridade: rebaixa um nivel (nunca "alta")
    if (!ehExato(c)) {
      if (confianca === "alta") confianca = "media";
      else if (confianca === "media") confianca = "baixa";
    }
    return { lat: c.lat, lng: c.lng, municipioCodigo: c.municipioCodigo, confianca, candidatos: cands[i].length, ancora: ancora[i] };
  });
}
