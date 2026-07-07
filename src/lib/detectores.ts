// Motor de detecção de alertas — funções PURAS (sem I/O).
// Cada detector avalia uma PosicaoNormalizada e retorna Alerta | null.
// Nunca importe nada de 'next' aqui — lib pura TypeScript.

import type { PosicaoNormalizada } from "./unitrac";

export type Alerta = {
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string;
  score: number;
};

// Informativo de veiculo sem comunicacao (atraso > 60 min).
// Nao e um alerta critico nem de atencao — apenas contexto informativo.
export type InfoSemComunicacao = {
  tipo: "sem_comunicacao";
  nivel: "informativo";
  motivo: string;
  atraso: number;
};

export function detectarSemComunicacao(p: PosicaoNormalizada): InfoSemComunicacao | null {
  if (p.fresco) return null;
  return {
    tipo: "sem_comunicacao",
    nivel: "informativo",
    motivo: `Sem comunicacao ha ${formataDuracao(p.atraso)}`,
    atraso: p.atraso,
  };
}

// Formata minutos como '1h35min' ou '45min'.
export function formataDuracao(minutos: number): string {
  if (minutos >= 60) {
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return m > 0 ? `${h}h${m}min` : `${h}h`;
  }
  return `${minutos}min`;
}

export function detectarPanico(p: PosicaoNormalizada): Alerta | null {
  if (!p.panico) return null;
  return { nivel: "critico", tipo: "panico", motivo: "PANICO acionado", score: 100 };
}

export function detectarBau(
  p: PosicaoNormalizada,
  ctx?: { noCliente?: boolean }
): Alerta | null {
  if (!p.bau) return null;
  // Descarga no cliente: operacao normal, nao e alerta.
  if (ctx?.noCliente) return null;
  // Bau aberto em movimento e mais grave: perda de carga em transito.
  if (p.velocidade > 0) {
    return {
      nivel: "critico",
      tipo: "bau",
      motivo: `Bau aberto em movimento a ${p.velocidade} km/h — risco de perda de carga`,
      score: 95,
    };
  }
  return { nivel: "critico", tipo: "bau", motivo: "Bau aberto fora do ponto de entrega", score: 90 };
}

// 30-59 min: pode ser tunel/garagem — atencao. 60-180 min: critico.
// Acima de 180 min: defeito de rastreador ou veiculo recolhido, nao jammer real.
const JAMMER_ATENCAO_MIN = 30;
const JAMMER_CRITICO_MIN = 60;
const JAMMER_TETO_MIN = 180;

export function detectarJammer(p: PosicaoNormalizada): Alerta | null {
  if (!p.ignicao) return null;
  if (p.atraso < JAMMER_ATENCAO_MIN || p.atraso > JAMMER_TETO_MIN) return null;
  if (p.atraso < JAMMER_CRITICO_MIN) {
    return {
      nivel: "critico",
      tipo: "jammer",
      motivo: `Sinal ausente ha ${p.atraso}min com ignicao ligada (monitorar)`,
      score: 55,
    };
  }
  return {
    nivel: "critico",
    tipo: "jammer",
    motivo: `Sinal perdido ha ${p.atraso}min com ignicao ligada (possivel bloqueador GPS)`,
    score: 80,
  };
}

// Veiculo fora da base, motor ligado e SEM rota/entrega programada no dia.
// Roda 24h: o que define a suspeita NAO e o horario (existe entrega de madrugada),
// e sim nao ter rota. Motor ligado parado pode ser recarga/descanso (atencao);
// em movimento fora da base sem rota e deslocamento indevido (critico).
// Substitui o antigo detector "ignicao_noturna", que disparava por horario.
export function detectarSaidaNaoAutorizada(
  p: PosicaoNormalizada,
  ctx: {
    foraDaBase: boolean;
    temPendentes: boolean;
    entregasTotal?: number;
    rumoMovimento?: number | null;
    rumoBase?: number | null;
    distBaseM?: number | null;
    temPOIProximo?: boolean;
  }
): Alerta | null {
  if (!p.fresco || !p.ignicao) return null;
  if (!ctx.foraDaBase || ctx.temPendentes) return null;
  // undefined = API de rota indisponivel; sem saber se ha entregas, nao dispara.
  if (ctx.entregasTotal === undefined) return null;
  // Tem (ou teve) entregas no dia = esta trabalhando legitimamente.
  if (ctx.entregasTotal > 0) return null;
  // Perto da base (< 2km): saindo para o dia, manobrando ou abastecendo na
  // propria base. A grande fonte de falso positivo (veiculo que acabou de sair).
  if (ctx.distBaseM != null && ctx.distBaseM < 2000) return null;
  // Parado perto de posto/POI legitimo (Overpass): abastecimento ou parada de
  // apoio (pegar carga, lanche), nao deslocamento indevido.
  if (p.velocidade === 0 && ctx.temPOIProximo) return null;
  // Veiculo se aproximando da base (ate 3km, heading dentro de 60 graus): retornando, nao dispara.
  if (
    ctx.rumoMovimento != null && ctx.rumoBase != null && ctx.distBaseM != null &&
    ctx.distBaseM <= 3000 && difAnguloGraus(ctx.rumoMovimento, ctx.rumoBase) <= 60
  ) return null;
  if (p.velocidade > 0) {
    return {
      nivel: "critico",
      tipo: "saida_nao_autorizada",
      motivo: "Em movimento fora da base sem rota programada",
      score: 80,
    };
  }
  return {
    nivel: "critico",
    tipo: "saida_nao_autorizada",
    motivo: "Parado fora da base sem rota programada",
    score: 45,
  };
}

export function detectarExcessoVelocidade(p: PosicaoNormalizada): Alerta | null {
  // 120 km/h: rodovias federais do RJ permitem 110-120 km/h para veiculos pesados;
  // 100 km/h gerava falso atencao em qualquer estrada normal.
  if (p.velocidade > 120) {
    return {
      nivel: "critico",
      tipo: "excesso",
      motivo: `Excesso de velocidade: ${p.velocidade} km/h`,
      score: 40,
    };
  }
  return null;
}

// Retorna true se a data estiver em horario de operacao:
// dia util (segunda a sexta) E entre 6h e 20h no fuso America/Sao_Paulo.
export function emHorarioOperacao(d: Date): boolean {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const partes = fmt.formatToParts(d);
  const weekday = partes.find((p) => p.type === "weekday")?.value ?? "";
  const horaStr = partes.find((p) => p.type === "hour")?.value ?? "0";
  const hora = parseInt(horaStr, 10);

  // Dias uteis em pt-BR: seg, ter, qua, qui, sex
  const diaUtil = ["seg", "ter", "qua", "qui", "sex"].some((dia) =>
    weekday.toLowerCase().startsWith(dia)
  );

  return diaUtil && hora >= 6 && hora < 20;
}

export function detectarParadaCliente(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  noCliente?: boolean;
}): Alerta | null {
  if (ctx.noCliente && ctx.emOperacao && ctx.paradoMin >= 90) {
    return {
      nivel: "critico",
      tipo: "parada_cliente",
      motivo: `Parado no cliente ha ${formataDuracao(ctx.paradoMin)} — acionar motorista imediatamente`,
      score: 72,
    };
  }
  return null;
}

export function detectarParadaLonga(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
  noCliente?: boolean;
  temPOIProximo?: boolean;
  entregasFeitas?: number;
  entregasTotal?: number;
}): Alerta | null {
  // Parado no cliente: coberto por detectarParadaCliente, evita duplicata.
  if (ctx.noCliente) return null;
  // Parado em posto/POI legítimo: não é suspeito.
  if (ctx.temPOIProximo) return null;
  // Rota concluída: coberto por retorno_tardio, evita duplicata.
  if (ctx.entregasTotal && ctx.entregasTotal > 0 && ctx.entregasFeitas !== undefined && ctx.entregasFeitas >= ctx.entregasTotal) return null;
  if (ctx.paradoMin >= 90 && ctx.emOperacao && ctx.foraDaBase) {
    return {
      nivel: "critico",
      tipo: "parada_longa",
      motivo: `Parado ha ${formataDuracao(ctx.paradoMin)}, contatar equipe`,
      score: 50,
    };
  }
  return null;
}

// Parada anômala curta — detecta parada suspeita ANTES dos 90min da parada_longa.
// Um roubo típico acontece em 10-20min; 90min já é tarde demais para reagir.
//
// Thresholds:
//   cidade (estavEmMovimento=true, velocidade anterior >= 30 km/h): >= 12min
//   estrada (velocidade anterior < 30 km/h ou não disponível): >= 25min
//
// Anti-pisca: só dispara se o veículo já estava parado no ciclo anterior
// (jaParedoNoCicloAnterior=true), evitando alerta em paradas de semáforo.
export function detectarParadaAnomala(ctx: {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
  noCliente: boolean;
  estavEmMovimento: boolean;  // velocidade anterior >= 30 km/h
  esMadrugada: boolean;       // 00h-05h fuso Sao Paulo
  emZonaRisco: boolean;       // dentro de geofence tipo "risco"
  temPOIProximo: boolean;     // posto/restaurante/farmacia a <80m
  jaParedoNoCicloAnterior: boolean; // anti-pisca
  vizinhosParados?: number;   // outros veiculos da frota parados num raio curto
}): Alerta | null {
  if (!ctx.emOperacao || !ctx.foraDaBase || ctx.noCliente) return null;
  if (!ctx.jaParedoNoCicloAnterior) return null; // aguarda um ciclo antes de disparar
  if (ctx.temPOIProximo) return null; // parada em local legitimo
  // Congestionamento: 2+ outros veiculos da frota parados na mesma area =
  // transito/fila, nao roubo. Comparar veiculos entre si mata o falso positivo.
  if ((ctx.vizinhosParados ?? 0) >= 2) return null;

  // 20 min em cidade (vinha de >= 30km/h), 35 min em estrada — limites anteriores
  // (12/25 min) disparavam para praticamente qualquer parada em trânsito pesado do RJ.
  const limiteMin = ctx.estavEmMovimento ? 20 : 35;
  if (ctx.paradoMin < limiteMin || ctx.paradoMin >= 90) return null; // >= 90 ja e parada_longa

  let score = 55;
  if (ctx.esMadrugada) score += 15;
  if (ctx.emZonaRisco) score += 10;

  // Todo mundo vira critico agora (pedido do cliente 06/07: acabar com o
  // nivel "atencao") — mantido o sufixo de madrugada/zona de risco no motivo
  // pra nao perder o contexto de severidade dentro do proprio texto.
  const nivel: "critico" | "atencao" = "critico";

  const duracao = formataDuracao(ctx.paradoMin);
  const sufixo = (ctx.esMadrugada && ctx.emZonaRisco)
    ? " (MADRUGADA + AREA DE RISCO)"
    : ctx.esMadrugada
      ? " (madrugada)"
      : ctx.emZonaRisco
        ? " (area de risco)"
        : "";
  return {
    nivel,
    tipo: "parada_anomala",
    motivo: `Parada suspeita de ${duracao} fora de rota sem ponto de entrega${sufixo}`,
    score,
  };
}

// Teto (m): acima disso não é mais "desvio local", é DESLOCAMENTO interurbano
// (a frota atende o estado todo; ida/volta de praça distante fica sempre a
// dezenas de km de qualquer destino, isso é viagem normal, não desvio).
const DESVIO_GATILHO_TETO_M = 25000;
// Distância (m) usada só pra RESOLVER o alerta (voltou perto de algo = chegou).
const DESVIO_RESOLVE_M = 2500;
// Crescimento mínimo por ciclo pra contar como afastamento real (ruído de GPS).
const AFASTAMENTO_MARGEM_M = 50;

// A Unitrac NÃO fornece rota planejada nem ordem confiável de entregas.
// Desvio aqui é comportamento: o veículo se afastando de TODOS os destinos
// legítimos (cada entrega pendente + cada base) em vez de progredir rumo a
// pelo menos um deles.
//
// Por que TODOS e não só o mais próximo (corrigido ao vivo em produção —
// achado real, não teórico: 06/07/2026, 22 alertas em 20min): usar só o
// destino mais próximo dispara em entrega NORMAL sempre que o motorista tem
// 2+ pendentes e vai para a que não é a mais próxima (comuníssimo — a ordem
// de distância euclidiana raramente é a ordem real da rota). Exigir que a
// distância a TODOS cresça ao mesmo tempo é o critério matematicamente
// correto de "não está progredindo rumo a nada legítimo": basta se aproximar
// de QUALQUER pendente ou base pra cancelar a suspeita, então a entrega
// comum (indo para qualquer pendente, mesmo o mais distante) nunca dispara.
//
// Por que sem piso de distância mínima: um desvio de 500m já pode ser um
// assalto em andamento. Não dá pra esperar acumular quilômetros. A proteção
// contra falso positivo vem de outro lugar: persistência mínima (2 ciclos,
// ~2min, o mais rápido que dá pra filtrar ruído de GPS de 1 leitura) e do
// tapete histórico (ver Camada 2 abaixo, com piso de tamanho mínimo pra não
// repetir o falso-positivo de cold-start do dia 06/07 — tapete vazio/pequeno
// não pode ser tratado como "fora de via conhecida").
export type CtxDesvio = {
  // Distância atual e do ciclo anterior a CADA destino legítimo (mesma ordem
  // nos dois arrays): alvos pendentes + bases do cliente.
  distDestinosM: number[];
  distDestinosAnteriorM: number[];
  temPendentes: boolean;
  emOperacao: boolean;
  foraDaBase: boolean;
  entregasFeitas?: number;
  // Ciclos consecutivos afastando-se de TUDO (motor incrementa e persiste).
  streak: number;
  // menorDist(agora) - menorDist(no início da sequência). Só informativo
  // (mostrado no motivo do alerta); não é exigência pra disparar.
  afastamentoAcumuladoM: number;
  // Camada 2 (tapete): true = célula (3x3) já percorrida pela frota nos
  // últimos 30 dias; false = fora de qualquer caminho conhecido E o tapete
  // já tem cobertura mínima confiável (motor só passa false quando o
  // tamanho do tapete supera o piso — ver TAPETE_MIN_CELULAS no motor);
  // null = sem tapete confiável ainda na região (não modula, nunca crítico
  // só por isso).
  dentroTapete: boolean | null;
  // Camada 3 (score de risco da área ATUAL, 0-100, ver calcularRiscoArea):
  // "via conhecida ou não" (tapete) não é a mesma coisa que "área perigosa
  // agora". Desvio numa rua nova mas tranquila não deveria ter a MESMA
  // urgência que desvio numa rua conhecida mas dentro de uma favela/com
  // tiroteio recente perto/com histórico de roubo de carga alto no CISP.
  // Default 0 (sem dado de risco disponível) — nunca ACELERA sozinho sem
  // ativar junto com o gatilho normal de streak; só faz o "fora do tapete"
  // (ou equivalente) disparar mais rápido, nunca suprime nem atrasa alerta.
  riscoAreaAtual: number;
};

// Pesos do score de risco de área (0-100). Cada camada contribui
// independente — não é probabilidade, é um índice de prioridade pro
// desvio decidir se escala rápido (ver RISCO_AREA_LIMIAR).
const RISCO_FAVELA = 40;
const RISCO_TIROTEIO_PERTO = 40;
const RISCO_ROUBO_CARGA_ALTO = 20;
const RISCO_ROUBO_CARGA_MEDIO = 10;
const RISCO_CORREDOR_RODOVIA = 20;
const RISCO_MADRUGADA = 10;
// Acima disso, trata como "área de risco elevado" pro desvio escalar tão
// rápido quanto "fora do tapete" — um sinal isolado (só favela, ou só
// tiroteio perto) já basta; não precisa de combinação de vários.
export const RISCO_AREA_LIMIAR = 40;

// Score de risco da posição ATUAL do veículo (0-100), combinando sinais
// geográficos/temporais independentes do tapete de rotas. Função pura —
// o motor busca os dados (favela, tiroteio, roubo_carga por CISP, horário)
// e só passa os booleanos/números já resolvidos aqui.
export function calcularRiscoArea(ctx: {
  emFavela: boolean;
  tiroteioRecentePertoM: number | null; // null = nenhum tiroteio ativo relevante
  rouboCargaCispTotal: number | null; // null = sem CISP resolvido pra essa posição
  emCorredorRodoviaRisco: boolean;
  madrugada: boolean; // 0h-5h horário local
}): number {
  let score = 0;
  if (ctx.emFavela) score += RISCO_FAVELA;
  if (ctx.tiroteioRecentePertoM !== null && ctx.tiroteioRecentePertoM <= 1500) {
    score += RISCO_TIROTEIO_PERTO;
  }
  if (ctx.rouboCargaCispTotal !== null) {
    if (ctx.rouboCargaCispTotal >= 15) score += RISCO_ROUBO_CARGA_ALTO;
    else if (ctx.rouboCargaCispTotal > 0) score += RISCO_ROUBO_CARGA_MEDIO;
  }
  if (ctx.emCorredorRodoviaRisco) score += RISCO_CORREDOR_RODOVIA;
  if (ctx.madrugada) score += RISCO_MADRUGADA;
  return Math.min(100, score);
}

// O veículo se afastou de TODOS os destinos legítimos desde o ciclo
// anterior? Aproximar de QUALQUER um cancela — é assim que uma entrega
// normal (rumo a um pendente que não é o mais próximo) nunca dispara.
export function afastouDeTudo(
  distDestinosM: number[],
  distDestinosAnteriorM: number[]
): boolean {
  if (distDestinosM.length === 0) return false;
  if (distDestinosM.length !== distDestinosAnteriorM.length) return false;
  return distDestinosM.every(
    (d, i) => d > distDestinosAnteriorM[i] + AFASTAMENTO_MARGEM_M
  );
}

// Condição FROUXA de permanência do alerta (anti-pisca): mantém enquanto o
// veículo segue longe (>=2,5km) de TODOS os destinos, incluindo bases.
export function foraDeRota(
  p: PosicaoNormalizada,
  ctx: { menorDistDestinoM: number | null; emOperacao: boolean; foraDaBase: boolean }
): boolean {
  if (!ctx.emOperacao || !ctx.foraDaBase) return false;
  if (ctx.menorDistDestinoM === null) return false;
  return ctx.menorDistDestinoM >= DESVIO_RESOLVE_M;
}

// Detector de DESVIO (gatilho de criação). Rápido de propósito: streak>=2
// (~2min) já dispara, sem piso de distância — um desvio pequeno pode ser
// um assalto começando. A precisão vem de exigir afastamento de TODOS os
// destinos (não só o mais próximo), do tapete (via desconhecida, com
// cobertura mínima confirmada) e da persistência (mata ruído de GPS).
export function detectarDesvio(p: PosicaoNormalizada, ctx: CtxDesvio): Alerta | null {
  if (!ctx.emOperacao || !ctx.foraDaBase) return null;
  if (p.velocidade <= 0) return null;
  // Indo para a primeira entrega do dia: sem referência de comportamento ainda.
  if (ctx.temPendentes && (ctx.entregasFeitas ?? 1) === 0) return null;
  if (ctx.distDestinosM.length === 0) return null;

  const menorDistM = Math.min(...ctx.distDestinosM);
  if (menorDistM > DESVIO_GATILHO_TETO_M) return null;
  if (ctx.streak < 2) return null;
  // Checagem própria (não confia só no streak pré-computado pelo motor):
  // se o ciclo ATUAL mostra aproximação de qualquer destino, cancela na
  // hora — não espera o motor zerar o streak no próximo ciclo.
  if (!afastouDeTudo(ctx.distDestinosM, ctx.distDestinosAnteriorM)) return null;

  const kmAcum = (Math.max(0, ctx.afastamentoAcumuladoM) / 1000).toFixed(1).replace(".", ",");
  const nDest = ctx.distDestinosM.length;

  // Fora de qualquer via já percorrida pela frota (com cobertura mínima
  // confirmada pelo motor): sinal quase certo, crítico já no 2º ciclo.
  if (ctx.dentroTapete === false) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras, fora de via conhecida da frota (+${kmAcum}km)`,
      score: 80,
    };
  }

  // Via CONHECIDA mas área ATUAL de risco elevado (favela, tiroteio recente
  // perto, CISP com histórico alto de roubo de carga, corredor de rodovia
  // perigosa, ou madrugada — ver calcularRiscoArea): escala tão rápido
  // quanto "fora do tapete". "Rua que a frota já usa" não é garantia de
  // segurança se a região está quente agora — resposta rápida importa mais
  // que esperar mais ciclos só porque a via em si é conhecida.
  if (ctx.riscoAreaAtual >= RISCO_AREA_LIMIAR) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras, em área de risco elevado (+${kmAcum}km)`,
      score: 80,
    };
  }

  // Persistência longa (4+ ciclos, ~4min) escala mesmo em via conhecida —
  // pode ser assalto acontecendo numa rua/rodovia que a frota usa sempre.
  if (ctx.streak >= 4) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (+${kmAcum}km)`,
      score: 68,
    };
  }

  return {
    nivel: "critico",
    tipo: "desvio",
    motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras (+${kmAcum}km)`,
    score: 45,
  };
}

// Diferença angular absoluta entre dois rumos (0..180). Duplicada de unitrac
// para manter este módulo sem dependências de I/O.
function difAnguloGraus(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10}m`;
  return `${(m / 1000).toFixed(1).replace(".", ",")}km`;
}
function fmtIdade(min: number | null): string {
  if (min == null) return "agora";
  if (min < 1) return "agora";
  if (min < 60) return `há ${min}min`;
  return `há ${Math.floor(min / 60)}h`;
}

// Fogo Cruzado mantém eventos por ate 3h. Filtrar por idade evita tratar
// tiroteio encerrado ha 2h como risco ativo.
const TIROTEIO_CRITICO_MAX_MIN = 60;  // acima disso: maximo atencao, mesmo perto
const TIROTEIO_SUPRIME_MIN = 120;     // acima disso: evento provavelmente encerrado

// Detector de TIROTEIO PRÓXIMO (operação/violência acontecendo agora na região).
// Cruza a posição do veículo com os tiroteios ATIVOS (últimas ~3h, Fogo Cruzado).
// Perigo imediato à carga: se há tiro perto, a central tem que saber JÁ.
export function detectarTiroteioProximo(
  p: PosicaoNormalizada,
  ctx: { distTiroteioM: number | null; tiroteioIdadeMin: number | null }
): Alerta | null {
  if (ctx.distTiroteioM === null) return null;
  if (!p.fresco) return null;
  const idadeMin = ctx.tiroteioIdadeMin ?? 0;
  if (idadeMin >= TIROTEIO_SUPRIME_MIN) return null;
  const quando = fmtIdade(ctx.tiroteioIdadeMin);
  if (ctx.distTiroteioM <= 600) {
    if (idadeMin < TIROTEIO_CRITICO_MAX_MIN) {
      return {
        nivel: "critico",
        tipo: "tiroteio",
        motivo: `Tiroteio RECENTE a ${fmtDist(ctx.distTiroteioM)} (${quando}) — area de risco`,
        score: 88,
      };
    }
    return {
      nivel: "critico",
      tipo: "tiroteio",
      motivo: `Tiroteio a ${fmtDist(ctx.distTiroteioM)} (${quando}) — monitorar situacao`,
      score: 60,
    };
  }
  if (ctx.distTiroteioM <= 2000) {
    return {
      nivel: "critico",
      tipo: "tiroteio",
      motivo: `Tiroteio a ${fmtDist(ctx.distTiroteioM)} (${quando}) proximo a rota`,
      score: 50,
    };
  }
  return null;
}

// Retorna o veiculo como suspeito se concluiu todas as entregas mas nao retornou
// a nenhuma base em mais de 60 min apos a ultima entrega.
export function detectarRetornoTardio(ctx: {
  entregas_feitas: number;
  entregas_total: number;
  foraDaBase: boolean;
  paradoMin: number;
  emOperacao: boolean;
}): Alerta | null {
  if (!ctx.emOperacao) return null;
  if (ctx.entregas_total === 0) return null;
  if (ctx.entregas_feitas < ctx.entregas_total) return null;
  if (!ctx.foraDaBase) return null;
  if (ctx.paradoMin < 60) return null;
  return {
    nivel: "critico",
    tipo: "retorno_tardio",
    motivo: `Rota concluida ha ${formataDuracao(ctx.paradoMin)} sem retorno a base`,
    score: 58,
  };
}

// Veiculo parado com motor ligado durante a madrugada fora da base.
// Cobre o gap em que emHorarioOperacao=false desativa os detectores principais.
export function detectarParadaNoturnaIgnicaoAtiva(
  p: PosicaoNormalizada,
  ctx: { foraDaBase: boolean; noCliente?: boolean; horaSP: number }
): Alerta | null {
  if (!p.fresco) return null;
  if (!p.ignicao || p.velocidade !== 0) return null;
  if (!ctx.foraDaBase) return null;
  if (ctx.noCliente) return null;
  // Madrugada: 22h-05h (hora SP)
  const ehMadrugada = ctx.horaSP >= 22 || ctx.horaSP < 5;
  if (!ehMadrugada) return null;
  return {
    nivel: "critico",
    tipo: "ignicao_noturna",
    motivo: `Parado com ignicao ligada as ${ctx.horaSP}h fora da base`,
    score: 75,
  };
}

// Saida brusca de 0 para >=80 km/h em 1 ciclo: padrao de fuga pos-abordagem.
// Caminhao pesado nao acelera 0->80 km/h em 1 min em condicoes normais.
export function detectarAceleracaoBrusca(
  p: PosicaoNormalizada,
  ctx: { velocidadeAnterior: number | null; foraDaBase: boolean }
): Alerta | null {
  if (!p.fresco) return null;
  if (!ctx.foraDaBase) return null;
  if (ctx.velocidadeAnterior === null || ctx.velocidadeAnterior > 5) return null;
  if (p.velocidade < 80) return null;
  return {
    nivel: "critico",
    tipo: "aceleracao",
    motivo: `Aceleracao brusca: 0 para ${p.velocidade} km/h em 1 ciclo — verificar`,
    score: 70,
  };
}

// Avalia todos os detectores e retorna TODOS os alertas ativos, ordenados por severidade.
// Use quando precisar de multiplos alertas simultaneos por veiculo (ex: panico + desvio).
export function avaliarTodos(
  p: PosicaoNormalizada,
  ctx: Parameters<typeof avaliar>[1]
): Alerta[] {
  const candidatos: Alerta[] = [
    detectarPanico(p),
    detectarBau(p, { noCliente: ctx.noCliente }),
    detectarJammer(p),
    detectarSaidaNaoAutorizada(p, {
      foraDaBase: ctx.foraDaBase,
      temPendentes: ctx.temPendentes ?? false,
      entregasTotal: ctx.entregasTotal,
      rumoMovimento: ctx.rumoMovimento ?? null,
      rumoBase: ctx.rumoBase ?? null,
      distBaseM: ctx.distBaseM ?? null,
      temPOIProximo: ctx.temPOIProximo ?? false,
    }),
    detectarExcessoVelocidade(p),
    detectarParadaCliente({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      noCliente: ctx.noCliente,
    }),
    detectarParadaLonga({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      foraDaBase: ctx.foraDaBase,
      noCliente: ctx.noCliente,
      temPOIProximo: ctx.temPOIProximo,
      entregasFeitas: ctx.entregasFeitas,
      entregasTotal: ctx.entregasTotal,
    }),
    ctx.estavEmMovimento !== undefined
      ? detectarParadaAnomala({
          paradoMin: ctx.paradoMin,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          noCliente: ctx.noCliente ?? false,
          estavEmMovimento: ctx.estavEmMovimento,
          esMadrugada: ctx.esMadrugada ?? false,
          emZonaRisco: ctx.emZonaRisco ?? false,
          temPOIProximo: ctx.temPOIProximo ?? false,
          jaParedoNoCicloAnterior: ctx.jaParedoNoCicloAnterior ?? false,
          vizinhosParados: ctx.vizinhosParados ?? 0,
        })
      : null,
    detectarTiroteioProximo(p, {
      distTiroteioM: ctx.distTiroteioM ?? null,
      tiroteioIdadeMin: ctx.tiroteioIdadeMin ?? null,
    }),
    ctx.distDestinosM !== undefined
      ? detectarDesvio(p, {
          distDestinosM: ctx.distDestinosM ?? [],
          distDestinosAnteriorM: ctx.distDestinosAnteriorM ?? [],
          temPendentes: ctx.temPendentes ?? false,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          entregasFeitas: ctx.entregasFeitas,
          streak: ctx.desvioStreak ?? 0,
          afastamentoAcumuladoM: ctx.afastamentoAcumuladoM ?? 0,
          dentroTapete: ctx.dentroTapete ?? null,
          riscoAreaAtual: ctx.riscoAreaAtual ?? 0,
        })
      : null,
  ].filter((a): a is Alerta => a !== null);

  return candidatos.sort((a, b) => {
    if (a.nivel === b.nivel) return b.score - a.score;
    return a.nivel === "critico" ? -1 : 1;
  });
}

// Avalia todos os detectores e retorna o alerta de maior severidade.
// Prioridade: critico > atencao; desempate por score (maior vence).
export function avaliar(
  p: PosicaoNormalizada,
  ctx: {
    paradoMin: number;
    emOperacao: boolean;
    foraDaBase: boolean;
    noCliente?: boolean;
    distDestinosM?: number[];
    distDestinosAnteriorM?: number[];
    desvioStreak?: number;
    afastamentoAcumuladoM?: number;
    dentroTapete?: boolean | null;
    riscoAreaAtual?: number;
    temPendentes?: boolean;
    entregasTotal?: number;
    entregasFeitas?: number;
    rumoMovimento?: number | null;
    rumoBase?: number | null;
    distBaseM?: number | null;
    distTiroteioM?: number | null;
    tiroteioIdadeMin?: number | null;
    // Parada anomala (opcional — so roda se estavEmMovimento for fornecido)
    estavEmMovimento?: boolean;
    esMadrugada?: boolean;
    emZonaRisco?: boolean;
    temPOIProximo?: boolean;
    jaParedoNoCicloAnterior?: boolean;
    vizinhosParados?: number;
  }
): Alerta | null {
  const candidatos: Alerta[] = [
    detectarPanico(p),
    detectarBau(p, { noCliente: ctx.noCliente }),
    detectarJammer(p),
    detectarSaidaNaoAutorizada(p, {
      foraDaBase: ctx.foraDaBase,
      temPendentes: ctx.temPendentes ?? false,
      entregasTotal: ctx.entregasTotal,
      rumoMovimento: ctx.rumoMovimento ?? null,
      rumoBase: ctx.rumoBase ?? null,
      distBaseM: ctx.distBaseM ?? null,
      temPOIProximo: ctx.temPOIProximo ?? false,
    }),
    detectarExcessoVelocidade(p),
    detectarParadaCliente({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      noCliente: ctx.noCliente,
    }),
    detectarParadaLonga({
      paradoMin: ctx.paradoMin,
      emOperacao: ctx.emOperacao,
      foraDaBase: ctx.foraDaBase,
      noCliente: ctx.noCliente,
      temPOIProximo: ctx.temPOIProximo,
      entregasFeitas: ctx.entregasFeitas,
      entregasTotal: ctx.entregasTotal,
    }),
    ctx.estavEmMovimento !== undefined
      ? detectarParadaAnomala({
          paradoMin: ctx.paradoMin,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          noCliente: ctx.noCliente ?? false,
          estavEmMovimento: ctx.estavEmMovimento,
          esMadrugada: ctx.esMadrugada ?? false,
          emZonaRisco: ctx.emZonaRisco ?? false,
          temPOIProximo: ctx.temPOIProximo ?? false,
          jaParedoNoCicloAnterior: ctx.jaParedoNoCicloAnterior ?? false,
          vizinhosParados: ctx.vizinhosParados ?? 0,
        })
      : null,
    detectarTiroteioProximo(p, {
      distTiroteioM: ctx.distTiroteioM ?? null,
      tiroteioIdadeMin: ctx.tiroteioIdadeMin ?? null,
    }),
    ctx.distDestinosM !== undefined
      ? detectarDesvio(p, {
          distDestinosM: ctx.distDestinosM ?? [],
          distDestinosAnteriorM: ctx.distDestinosAnteriorM ?? [],
          temPendentes: ctx.temPendentes ?? false,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          entregasFeitas: ctx.entregasFeitas,
          streak: ctx.desvioStreak ?? 0,
          afastamentoAcumuladoM: ctx.afastamentoAcumuladoM ?? 0,
          dentroTapete: ctx.dentroTapete ?? null,
          riscoAreaAtual: ctx.riscoAreaAtual ?? 0,
        })
      : null,
  ].filter((a): a is Alerta => a !== null);

  if (candidatos.length === 0) return null;

  return candidatos.reduce((melhor, atual) => {
    if (melhor.nivel === "critico" && atual.nivel !== "critico") return melhor;
    if (atual.nivel === "critico" && melhor.nivel !== "critico") return atual;
    return atual.score > melhor.score ? atual : melhor;
  });
}
