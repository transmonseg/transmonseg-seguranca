// Motor de detecção de alertas — funções PURAS (sem I/O).
// Cada detector avalia uma PosicaoNormalizada e retorna Alerta | null.
// Nunca importe nada de 'next' aqui — lib pura TypeScript.

import type { PosicaoNormalizada } from "./unitrac";
import { zScoreBaseline, type Baseline } from "./baseline-veiculo";

export type Alerta = {
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string;
  score: number;
  // Sinaliza que este alerta de desvio precisa passar pela verificacao de
  // corredor real (route.ts) antes de confirmar -- substitui o acoplamento
  // por string magica (motivo.startsWith("Afastando-se")) que existia ate
  // 10/07: qualquer ajuste de texto desligava a protecao inteira em
  // silencio. So os branches do FLUXO PRINCIPAL de detectarDesvio setam
  // isso; o branch remanescente da Camada 3 ("Aproximando...") nao seta --
  // tem semantica de deteccao diferente e nunca teve verificacao de corredor.
  precisaVerificacaoCorredor?: boolean;
  // Achado real 11/07: quando true, o alerta so pode sobreviver se o
  // corredor CONFIRMAR "fora" explicitamente -- "indisponivel"/orcamento
  // estourado NAO fazem fail-open aqui (ao contrario do padrao normal de
  // precisaVerificacaoCorredor). Usado especificamente pro caso "sem
  // historico de comportamento ainda" (0 entregas feitas): sem essa
  // exigencia extra, o gate antigo bloqueava a deteccao por completo; com
  // ela, a estrada real supre a falta de historico sem abrir mao de
  // cautela quando a API estiver fora.
  exigeConfirmacaoCorredor?: boolean;
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

  // Achado da pesquisa (07/07): ~85% dos roubos de carga documentados no
  // Mexico envolveram jammer, e casos reais mostram que foi o sinal cair
  // justamente durante uma PARADA (nao um jammer com o veiculo em movimento,
  // que pode ser so sombra de sinal num tunel/vao entre predios) que expos
  // o roubo. p.velocidade aqui e a ULTIMA leitura conhecida antes do sinal
  // cair (a linha nao atualiza durante o gap) — reflete o estado real no
  // momento em que o sinal sumiu, nao um "zero" por falta de dado.
  const paradoQuandoSinalCaiu = p.velocidade === 0;

  if (p.atraso < JAMMER_CRITICO_MIN) {
    return {
      nivel: "critico",
      tipo: "jammer",
      motivo: paradoQuandoSinalCaiu
        ? `Sinal ausente ha ${p.atraso}min — veiculo estava PARADO quando o sinal caiu (monitorar de perto)`
        : `Sinal ausente ha ${p.atraso}min com ignicao ligada (monitorar)`,
      score: paradoQuandoSinalCaiu ? 65 : 55,
    };
  }
  return {
    nivel: "critico",
    tipo: "jammer",
    motivo: paradoQuandoSinalCaiu
      ? `Sinal perdido ha ${p.atraso}min — veiculo estava PARADO quando o sinal caiu (padrao de bloqueio durante parada, ver protocolo)`
      : `Sinal perdido ha ${p.atraso}min com ignicao ligada (possivel bloqueador GPS)`,
    score: paradoQuandoSinalCaiu ? 90 : 80,
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

  // Baixado de 20/35 pra 12/20 em 12/07 (revisao linha por linha a pedido do
  // usuario, buscando desvio real passando batido por excesso de cautela --
  // "um roubo tipico acontece em 10-20min" ja documentado acima, e 20/35
  // estava na borda ou depois disso). ATENCAO: os valores 12/25 ja foram
  // tentados ANTES e revertidos pra 20/35 porque disparavam pra
  // praticamente qualquer parada em transito pesado do RJ -- o novo par
  // (12/20) fica no limite do que ja foi tentado pra cidade e mais
  // conservador que repetir o par exato que falhou pra estrada. Se
  // reproduzir ruido de transito pesado, e uma reversao facil (1 linha) e
  // o monitoramento periodico ja em andamento vai pegar isso.
  const limiteMin = ctx.estavEmMovimento ? 12 : 20;
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
// Subido de 25km pra 80km em 11/07, depois pra 300km em 12/07 (revisao
// linha por linha a pedido do usuario): 80km ainda era um teto ABSOLUTO que
// escondia desvio de verdade acima disso. 300km cobre confortavelmente
// qualquer entrega dentro do RJ e estados vizinhos (SP, MG, ES), mantendo
// so um piso de sanidade contra leitura de GPS corrompida (coordenada
// absurda).
const DESVIO_GATILHO_TETO_M = 300000;
// Distância (m) usada só pra RESOLVER o alerta (voltou perto de algo = chegou).
const DESVIO_RESOLVE_M = 2500;
// Crescimento mínimo por ciclo pra contar como afastamento real (ruído de GPS).
const AFASTAMENTO_MARGEM_M = 50;
// Ciclos consecutivos (aproximando de algum destino, mas fora do tapete
// conhecido) antes de disparar a Camada 3. 2 ciclos (~2min), mesmo padrão de
// persistência mínima da Camada 1 — filtra ruído de 1 leitura de GPS.
// Substituiu o cálculo por linha reta base->destino (TRAJETO_PERPENDICULAR_
// LIMIAR_M + perfil de rota): achado real (TUK-0H45, 08/07/2026) mostrou que
// essa métrica degenera pra "distância crua até a entrega" quando a base
// fica dezenas de km distante e o veículo chega por um ângulo fora da reta
// base->destino, disparando em aproximação 100% normal.
export const FORA_TAPETE_STREAK_MIN = 2;
// Quando o PROPRIO veiculo (nao a frota) ja tem historico de ter passado
// pela area -- ver corredor_celulas_veiculo, design de 21/07 -- exige mais
// leituras consecutivas antes de escalar: reduz falso positivo de atalho
// pessoal legitimo sem suprimir o alerta por completo (nunca fecha
// sozinho, so amortece -- decisao explicita do usuario em 21/07).
export const FORA_TAPETE_STREAK_MIN_FAMILIAR = 5;
// DESATIVADA em 09/07/2026 (achado ao vivo, mesmo dia do deploy): virou
// quase metade de todo o ruído de desvio (74 Camada 1 vs 75 Camada 3 em 6h),
// disparando e resolvendo a cada 2min nas MESMAS placas (TTM-7C14, TTM-2G01,
// TUS-1A47) que rodam rotas rurais/serra (Nova Friburgo/Teresópolis/
// Saquarema) — o tapete dessas regiões ainda não tem cobertura suficiente,
// então qualquer variação legítima de caminho (trânsito, GPS, entrega nova)
// virava "via nunca percorrida". motor continua computando e persistindo
// foraTapeteStreak normalmente (dado útil pra redesenhar o limiar com calma,
// ex.: exigir cobertura mínima por REGIÃO, não só por cliente).
// Religada em 12/07/2026 apos revisao linha por linha a pedido do usuario.
// Causa raiz do incidente de 09/07 que motivou a desativacao (o alerta
// FECHAVA sozinho e reabria a cada ~2min, indistinguivel de bug) ja foi
// corrigida em 11/07 (desvio nunca mais fecha sozinho, commit 1a23048).
// Residual esperado: mais alertas em rotas rurais/serra com tapete esparso
// -- falso positivo que FAZ SENTIDO (fica aberto aguardando o operador, nao
// pisca), aceitavel pela diretiva do usuario. Cobertura minima POR REGIAO
// (nao so por cliente inteiro, ja proposta em docs/analise-deteccao.md
// 09/07) fica FORA de escopo deste ciclo -- resolveria a esparsidade rural
// de forma mais fina, mas e um projeto proprio.
const CAMADA3_TAPETE_ATIVA = true;

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
  // Quando a API /alvos falhou/deu timeout neste ciclo, destinos vira so
  // bases pra TODOS os veiculos do cliente -- indistinguivel de "rota
  // realmente sem pendencias". alvosApiOk=false bloqueia o disparo (mesmo
  // tratamento que saida_nao_autorizada ja tem via alvosApiOk em route.ts).
  // undefined = comportamento de hoje (API ok).
  alvosApiOk?: boolean;
  // Sabado 6h-20h COM rota carregada hoje na Unitrac (achado real 10/07:
  // frota se move de verdade aos sabados e o gate de calendario seg-sex
  // deixava o desvio cego). Se tem rota de HOJE, e dia de trabalho DESSE
  // veiculo, independente do calendario. undefined/false = so calendario.
  sabadoDiurnoComRota?: boolean;
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
  // Familiaridade PESSOAL do veiculo (nao da frota) com a area atual -- ver
  // corredor_celulas_veiculo. true = esse veiculo especifico ja passou por
  // essa celula antes (30 dias), com cobertura minima confirmada
  // (FAMILIARIDADE_MIN_CELULAS no motor). null = sem historico suficiente
  // ainda (veiculo novo/pouco dado) -- nao amortece nada nesse caso. Nunca
  // suprime o alerta, so exige mais leituras (FORA_TAPETE_STREAK_MIN_FAMILIAR)
  // antes de escalar -- decisao explicita do usuario em 21/07.
  familiarVeiculo: boolean | null;
  // Camada 3 (score de risco da área ATUAL, 0-100, ver calcularRiscoArea):
  // "via conhecida ou não" (tapete) não é a mesma coisa que "área perigosa
  // agora". Desvio numa rua nova mas tranquila não deveria ter a MESMA
  // urgência que desvio numa rua conhecida mas dentro de uma favela/com
  // tiroteio recente perto/com histórico de roubo de carga alto no CISP.
  // Default 0 (sem dado de risco disponível) — nunca ACELERA sozinho sem
  // ativar junto com o gatilho normal de streak; só faz o "fora do tapete"
  // (ou equivalente) disparar mais rápido, nunca suprime nem atrasa alerta.
  riscoAreaAtual: number;
  // Ponto cego identificado (comparação com iBOAT, pesquisa 07/07): o
  // gatilho principal cancela a suspeita assim que o veículo se aproxima de
  // QUALQUER destino — um trajeto raro que ainda assim vai "na direção"
  // certa nunca dispara. Ciclos consecutivos (aproximando de algum destino,
  // MAS fora do tapete conhecido, com cobertura mínima confirmada) — motor
  // só incrementa quando afastouDeTudo=false E dentroTapete=false (ver
  // TAPETE_MIN_CELULAS no motor). Substituiu o cálculo por linha reta
  // (ver FORA_TAPETE_STREAK_MIN acima) — pega desvio grande mesmo quando
  // tecnicamente aproximando, sem o defeito de degenerar em distância crua.
  foraTapeteStreak: number;
};

// Pesos do score de risco de área (0-100). Cada camada contribui
// independente — não é probabilidade, é um índice de prioridade pro
// desvio decidir se escala rápido (ver RISCO_AREA_LIMIAR).
const RISCO_FAVELA = 40;
const RISCO_TIROTEIO_PERTO = 40;
const RISCO_ROUBO_CARGA_ALTO = 20;
const RISCO_ROUBO_CARGA_MEDIO = 10;
const RISCO_CORREDOR_RODOVIA = 20;
// Area de risco cadastrada pelo PROPRIO cliente (ex.: "Caixotaria do Ceasa",
// area conhecida de receptacao/roubo perto do Benassi, ja mapeada por eles
// no Unitrac -- ver geofences.tipo='area_risco_cliente', escopada por
// cliente_id, 16/07/2026). Peso proximo do favela: e conhecimento
// operacional direto do cliente sobre um risco real, nao um proxy
// estatistico como CISP/corredor.
const RISCO_AREA_CLIENTE = 30;
// Fator horario multiplicativo (ver calcularPerfilHorario em fogocruzado.ts):
// fora dessa faixa, um horario com poucos dados historicos poderia zerar ou
// disparar o score espacial por ruido estatistico — consenso da literatura
// STKDE/aoristic e sempre MULTIPLICAR a base espacial, nunca somar bonus fixo.
export const FATOR_HORARIO_MIN = 0.7;
export const FATOR_HORARIO_MAX = 1.6;
// Acima disso, trata como "área de risco elevado" pro desvio escalar tão
// rápido quanto "fora do tapete" — um sinal isolado (só favela, ou só
// tiroteio perto) já basta; não precisa de combinação de vários.
// Baixado de 40 pra 25 em 11/07 (diretiva explicita: falso positivo
// aceitavel, prioridade total e nunca perder desvio real) -- um sinal
// moderado isolado (ex. so roubo de carga alto + fator horario) ja deve
// bastar, sem precisar de combinacao forte tipo favela+tiroteio.
export const RISCO_AREA_LIMIAR = 25;

// Score de risco da posição ATUAL do veículo (0-100), combinando sinais
// geográficos/temporais independentes do tapete de rotas. Função pura —
// o motor busca os dados (favela, tiroteio, roubo_carga por CISP, horário)
// e só passa os booleanos/números já resolvidos aqui.
export function calcularRiscoArea(ctx: {
  emFavela: boolean;
  tiroteioRecentePertoM: number | null; // null = nenhum tiroteio ativo relevante
  rouboCargaCispTotal: number | null; // null = sem CISP resolvido pra essa posição
  emCorredorRodoviaRisco: boolean;
  emAreaRiscoCliente: boolean; // area de risco cadastrada pelo proprio cliente
  // Fator multiplicativo por hora do dia (ver calcularPerfilHorario), tipico
  // 0.7-1.6. Default esperado 1 (neutro) quando nao ha perfil horario
  // disponivel ainda (ex.: Fogo Cruzado fora do ar) — nunca inventa risco.
  fatorHorario: number;
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
  if (ctx.emAreaRiscoCliente) score += RISCO_AREA_CLIENTE;
  return Math.min(100, score * ctx.fatorHorario);
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

// Avanço dos streaks do desvio com HISTERESE (achado real 09/07, vídeo da
// operação: desvio pra Xerém só pontuou lá em cima). Em estrada de serra a
// distância em linha reta a um destino oscila a cada curva — zerar o streak
// na primeira leitura de aproximação apagava a suspeita acumulada e o
// alerta saía km depois do desvio começar. Agora: 1 leitura de aproximação
// isolada CONGELA o streak (não zera, não incrementa); só 2 consecutivas
// zeram — mesma régua de persistência usada pra disparar e pra resolver.
// Tolerancia de "jitter" normal de GPS parado -- abaixo disso, o veiculo
// nao se moveu de verdade (nao e sinal de aproximacao nem de afastamento).
const POSICAO_CONGELADA_M = 10;

// Decide se o ciclo atual tem informacao NOVA o suficiente pra avancar os
// streaks de desvio, ou se e um nao-evento que deve congelar tudo (mesmo
// tratamento ja dado a saltoImplausivel). Achado real 10/07: se a posicao
// trava entre ciclos (sinal ruim/bloqueado) mas a velocidade reportada
// continua >0, afastouDeTudo() calcula "sem afastamento" (distancia nao
// mudou) e a historese le isso como aproximacao -- em 2 ciclos zera o
// streak E fecha um alerta ja ativo, exatamente o que um sequestro com
// bloqueio de sinal faria parecer. distanciaAoAnteriorM=null (sem ciclo
// anterior) tambem nao avanca -- nada a comparar ainda.
export function devAvancarStreaksDesvio(ctx: {
  fresco: boolean;
  saltoImplausivel: boolean;
  distanciaAoAnteriorM: number | null;
  velocidade: number;
}): boolean {
  if (!ctx.fresco || ctx.saltoImplausivel) return false;
  if (ctx.distanciaAoAnteriorM === null) return false;
  if (ctx.distanciaAoAnteriorM < POSICAO_CONGELADA_M) return false;
  return ctx.velocidade > 0;
}

export function avancarStreaksDesvio(
  afastando: boolean,
  atual: { desvioStreak: number; aproximandoStreak: number }
): { desvioStreak: number; aproximandoStreak: number; zerou: boolean } {
  if (afastando) {
    return { desvioStreak: atual.desvioStreak + 1, aproximandoStreak: 0, zerou: false };
  }
  const aproximandoStreak = atual.aproximandoStreak + 1;
  if (aproximandoStreak >= 2) {
    return { desvioStreak: 0, aproximandoStreak, zerou: true };
  }
  return { desvioStreak: atual.desvioStreak, aproximandoStreak, zerou: false };
}

// Ciclos consecutivos de aproximação (sem afastar de TUDO) que já bastam pra
// encerrar o alerta — mesmo limiar mínimo usado pra disparar (Camada 1),
// pelo mesmo motivo: 1 leitura pode ser ruído/blip (inclusive um sequestro
// fingindo aproximar pra "limpar" o alerta); 2 leituras é comportamento
// sustentado de verdade.
const APROXIMANDO_RESOLVE_STREAK = 2;

// Condição de permanência do alerta (anti-pisca). Duas formas de encerrar:
// (a) ficou fisicamente perto (<2,5km) de algum destino -- critério antigo,
// (b) aproximação SUSTENTADA de algum destino (>=2 leituras seguidas sem
// afastar de tudo) -- acrescentado 09/07/2026, achado real (TUL-1C38, ver
// docs/analise-deteccao.md secao 7.2): veículo aproximando monotonicamente
// da base por 10 leituras (8,26km -> 2,12km) ficava com o alerta "ativo" o
// trajeto INTEIRO, porque só (a) existia e a base ainda estava longe. Sem
// (b), disparar e resolver usavam réguas diferentes pro mesmo conceito de
// "aproximando cancela a suspeita".
export function foraDeRota(
  p: PosicaoNormalizada,
  ctx: {
    menorDistDestinoM: number | null;
    foraDaBase: boolean;
    aproximandoStreak: number;
  }
): boolean {
  if (!ctx.foraDaBase) return false;
  if (ctx.aproximandoStreak >= APROXIMANDO_RESOLVE_STREAK) return false;
  if (ctx.menorDistDestinoM === null) return false;
  return ctx.menorDistDestinoM >= DESVIO_RESOLVE_M;
}

// Detector de DESVIO (gatilho de criação). Rápido de propósito: streak>=2
// (~2min) já dispara, sem piso de distância — um desvio pequeno pode ser
// um assalto começando. A precisão vem de exigir afastamento de TODOS os
// destinos (não só o mais próximo), do tapete (via desconhecida, com
// cobertura mínima confirmada) e da persistência (mata ruído de GPS).
export function detectarDesvio(p: PosicaoNormalizada, ctx: CtxDesvio): Alerta | null {
  if (ctx.alvosApiOk === false) return null;
  // Achado real 11/07 (diretiva explicita: falso positivo aceitavel,
  // prioridade total e nunca perder desvio real): calendario removido de
  // vez quando ha PENDENTES -- se a Unitrac carregou rota, e hora de
  // trabalho DESSE veiculo, ponto final, nao importa dia/hora (cobre
  // domingo e madrugada, alem do sabado ja coberto por
  // sabadoDiurnoComRota). O fallback por calendario so sobra pro caso sem
  // NENHUMA rota carregada (evita disparar pra veiculo em manutencao de
  // madrugada sem nada pra fazer).
  const operando = ctx.temPendentes || ctx.emOperacao || ctx.sabadoDiurnoComRota === true;
  if (!operando || !ctx.foraDaBase) return null;
  if (p.velocidade <= 0) return null;
  // Indo para a primeira entrega do dia: sem referência de comportamento
  // ainda. Achado real 11/07: bloquear TOTAL aqui apagava a deteccao o dia
  // INTEIRO pra veiculos de rota curta (1-3 entregas passam a maior parte
  // do dia com 0 feitas) -- 4 de 5 casos reais confirmados pela cerca
  // virtual como fora de rota real nunca viravam alerta so por isso. Agora
  // dispara igual, mas marca exigeConfirmacaoCorredor: a estrada real
  // (corredor) supre a falta de historico de comportamento sem abrir mao
  // de cautela -- route.ts so deixa sobreviver se o corredor CONFIRMAR
  // "fora" (nao fail-open pra este caso especifico).
  const semHistorico = ctx.temPendentes && (ctx.entregasFeitas ?? 1) === 0;
  if (ctx.distDestinosM.length === 0) return null;

  const menorDistM = Math.min(...ctx.distDestinosM);
  if (menorDistM > DESVIO_GATILHO_TETO_M) return null;

  const afastandoDeTudo = afastouDeTudo(ctx.distDestinosM, ctx.distDestinosAnteriorM);

  // Ponto cego do gatilho principal: aproximar de QUALQUER destino cancela a
  // suspeita, mesmo que o caminho até lá nunca tenha sido percorrido pela
  // frota antes (ex.: sequestro que ainda assim segue "na direção" de uma
  // entrega). ctx.foraTapeteStreak conta ciclos consecutivos assim — o
  // motor só incrementa quando afastandoDeTudo=false E dentroTapete=false
  // (cobertura mínima confirmada, ver TAPETE_MIN_CELULAS no motor).
  const limiarForaTapete = ctx.familiarVeiculo === true
    ? FORA_TAPETE_STREAK_MIN_FAMILIAR
    : FORA_TAPETE_STREAK_MIN;
  if (CAMADA3_TAPETE_ATIVA && !afastandoDeTudo && ctx.foraTapeteStreak >= limiarForaTapete) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Aproximando de um destino, mas por caminho que a frota nunca percorreu antes (fora de via conhecida há ${ctx.foraTapeteStreak} leituras)`,
      score: 65,
    };
  }

  // Persistência mínima baixada de 2 pra 1 ciclo em 11/07 (diretiva explicita
  // do usuario: "pode ter um desvio de 100 metros e ja SER um desvio" --
  // imediato, sem esperar confirmação de um 2º ciclo. Falso positivo
  // aceitável, prioridade total e nunca perder desvio real).
  if (ctx.streak < 1) return null;
  // Checagem própria (não confia só no streak pré-computado pelo motor):
  // se o ciclo ATUAL mostra aproximação de qualquer destino, cancela na
  // hora — não espera o motor zerar o streak no próximo ciclo.
  if (!afastandoDeTudo) return null;

  const kmAcum = (Math.max(0, ctx.afastamentoAcumuladoM) / 1000).toFixed(1).replace(".", ",");
  const nDest = ctx.distDestinosM.length;

  // Fora de qualquer via já percorrida pela frota (com cobertura mínima
  // confirmada pelo motor): sinal quase certo, crítico já no 2º ciclo.
  // Mesmo dado de tapete que causou o incidente de 09/07 (Camada 3) -- esta
  // escalada vivia SEM a flag, e continuava produzindo o mesmo sintoma
  // ("fora de via conhecida da frota") mesmo com CAMADA3_TAPETE_ATIVA=false.
  // Confirmado com dado real: disparou as 21h43 de 09/07, depois da
  // desativacao. Agora atras da MESMA flag que protege a linha ~527.
  if (CAMADA3_TAPETE_ATIVA && ctx.dentroTapete === false) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado, fora de via conhecida da frota`,
      score: 80,
      precisaVerificacaoCorredor: true,
      exigeConfirmacaoCorredor: semHistorico || undefined,
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
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado, em área de risco elevado`,
      score: 80,
      precisaVerificacaoCorredor: true,
      exigeConfirmacaoCorredor: semHistorico || undefined,
    };
  }

  // Persistência longa (4+ ciclos, ~4min) escala mesmo em via conhecida —
  // pode ser assalto acontecendo numa rua/rodovia que a frota usa sempre.
  if (ctx.streak >= 4) {
    return {
      nivel: "critico",
      tipo: "desvio",
      motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado`,
      score: 68,
      precisaVerificacaoCorredor: true,
      exigeConfirmacaoCorredor: semHistorico || undefined,
    };
  }

  return {
    nivel: "critico",
    tipo: "desvio",
    motivo: `Afastando-se de todos os ${nDest} destinos há ${ctx.streak} leituras seguidas (~${ctx.streak}min), +${kmAcum}km acumulado`,
    score: 45,
    precisaVerificacaoCorredor: true,
      exigeConfirmacaoCorredor: semHistorico || undefined,
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

// Achado do audio do cliente Nutry Max (11/07/2026): "desvio de rota e
// quando ele esta na porta do cliente e nao para, segue por outra via, sem
// confirmar". Parametros de stay-point detection pra logistica urbana
// (raio do proprio alvo, ja fornecido pela Unitrac em pt.raio; tempo minimo
// de permanencia com velocidade baixa, nao so posicao). Sinal OPERACIONAL
// (nivel atencao): confirmado que ninguem na industria trata isso sozinho
// como alerta de seguranca, so combinado com outro sinal (route.ts decide
// a escalada, ver comentario no fluxo de deteccao).
export type CtxBypassEntrega = {
  saiuDoRaioAgora: boolean;
  mesmoAlvoCodigo: boolean;
  dwellSegundosAcumulados: number;
  entregaConfirmada: boolean;
};

export const BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS = 120;

export function detectarBypassEntrega(ctx: CtxBypassEntrega): Alerta | null {
  if (!ctx.saiuDoRaioAgora || !ctx.mesmoAlvoCodigo) return null;
  if (ctx.entregaConfirmada) return null;
  if (ctx.dwellSegundosAcumulados >= BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS) return null;
  return {
    nivel: "atencao",
    tipo: "bypass_entrega",
    motivo: `Passou pelo raio de um ponto de entrega sem confirmar (parado so ${ctx.dwellSegundosAcumulados}s, esperado ${BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS}s+)`,
    score: 40,
  };
}

export type CtxAnomaliaBaseline = {
  velocidadeMediaViagemKmh: number;
  baselineProprio: Baseline;
  baselineFrota: Baseline;
  minAmostrasProprio: number;
};

const BASELINE_MIN_AMOSTRAS_FROTA = 20;
const BASELINE_Z_LIMIAR = 3;

export function detectarAnomaliaBaseline(ctx: CtxAnomaliaBaseline): Alerta | null {
  const usaProprio = ctx.baselineProprio.n >= ctx.minAmostrasProprio;
  const baseline = usaProprio ? ctx.baselineProprio : ctx.baselineFrota;
  const minAmostras = usaProprio ? ctx.minAmostrasProprio : BASELINE_MIN_AMOSTRAS_FROTA;
  const z = zScoreBaseline(ctx.velocidadeMediaViagemKmh, baseline, minAmostras);
  if (z === null || !Number.isFinite(z) || Math.abs(z) < BASELINE_Z_LIMIAR) return null;
  const origem = usaProprio ? "deste veiculo" : "da frota (veiculo ainda sem historico proprio)";
  return {
    nivel: "atencao",
    tipo: "baseline_veiculo",
    motivo: `Velocidade media da viagem (${ctx.velocidadeMediaViagemKmh.toFixed(0)}km/h) foge ${Math.abs(z).toFixed(1)} desvios do padrao ${origem}`,
    score: 35,
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
      ? aplicarBonusClasseViaria(detectarDesvio(p, {
          distDestinosM: ctx.distDestinosM ?? [],
          distDestinosAnteriorM: ctx.distDestinosAnteriorM ?? [],
          temPendentes: ctx.temPendentes ?? false,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          entregasFeitas: ctx.entregasFeitas,
          alvosApiOk: ctx.alvosApiOk,
          sabadoDiurnoComRota: ctx.sabadoDiurnoComRota,
          streak: ctx.desvioStreak ?? 0,
          afastamentoAcumuladoM: ctx.afastamentoAcumuladoM ?? 0,
          dentroTapete: ctx.dentroTapete ?? null,
          familiarVeiculo: ctx.familiarVeiculo ?? null,
          riscoAreaAtual: ctx.riscoAreaAtual ?? 0,
          foraTapeteStreak: ctx.foraTapeteStreak ?? 0,
        }), ctx.quedaClasseViaria ?? false)
      : null,
  ].filter((a): a is Alerta => a !== null);

  return candidatos.sort((a, b) => {
    if (a.nivel === b.nivel) return b.score - a.score;
    return a.nivel === "critico" ? -1 : 1;
  });
}

// Conjunto de sinais de seguranca relevantes pra corroboracao -- confirmado
// pela pesquisa de 11/07 como o padrao de maior confianca da industria
// ("jammer + desvio + area de risco juntos"). Extras mais operacionais
// (retorno_tardio, parada_noturna_ignicao, aceleracao_brusca) ficam de fora
// de proposito: continuam disputando a arbitragem normalmente, so nao
// geram bonus de corroboracao, pra nao diluir o sinal.
const TIPOS_CORROBORANTES = new Set(["jammer", "desvio", "bypass_entrega", "baseline_veiculo"]);
const BONUS_CORROBORACAO_POR_SINAL = 15;

// Reforco de score da classificacao viaria (via principal -> rua estreita)
// -- ver docs/superpowers/specs/2026-07-21-classe-viaria-desvio-design.md.
// Aplicado ao RESULTADO de detectarDesvio, NUNCA lido dentro da funcao --
// garante por construcao que o sinal nunca cria alerta por conta propria
// (se detectarDesvio nao retornar nada, nao ha o que reforcar). Mesma
// magnitude de BONUS_CORROBORACAO_POR_SINAL, capado em 100.
const BONUS_CLASSE_VIARIA = 15;

export function aplicarBonusClasseViaria(
  alerta: Alerta | null,
  quedaClasseViaria: boolean
): Alerta | null {
  if (!alerta || !quedaClasseViaria) return alerta;
  return {
    ...alerta,
    score: Math.min(100, alerta.score + BONUS_CLASSE_VIARIA),
    motivo: alerta.motivo ? `${alerta.motivo} — saiu de via principal recentemente` : alerta.motivo,
  };
}

// Arbitragem compartilhada: escolhe o candidato de maior severidade
// (critico > atencao, depois maior score) e, se 2+ TIPOS DISTINTOS do
// conjunto relevante estiverem presentes ao mesmo tempo, soma um bonus por
// tipo extra (capado em 100) e lista quem corroborou no motivo. Usada
// internamente por avaliar() E pelo motor (route.ts) pra combinar o
// resultado de avaliar() com os detectores extras (cerca, bypass, baseline).
export function arbitrarCandidatos(candidatos: Alerta[]): Alerta | null {
  if (candidatos.length === 0) return null;

  const vencedor = candidatos.reduce((melhor, atual) => {
    if (melhor.nivel === "critico" && atual.nivel !== "critico") return melhor;
    if (atual.nivel === "critico" && melhor.nivel !== "critico") return atual;
    return atual.score > melhor.score ? atual : melhor;
  });

  const tiposPresentes = new Set(
    candidatos.filter((a) => TIPOS_CORROBORANTES.has(a.tipo)).map((a) => a.tipo)
  );

  if (tiposPresentes.size < 2) return vencedor;

  const outrosTipos = [...tiposPresentes].filter((t) => t !== vencedor.tipo);
  const bonus = outrosTipos.length * BONUS_CORROBORACAO_POR_SINAL;
  return {
    ...vencedor,
    score: Math.min(100, vencedor.score + bonus),
    motivo: `${vencedor.motivo} (corroborado por: ${outrosTipos.join(", ")})`,
  };
}

const TRANSITO_INFERIDO_MIN_VIZINHOS = 2;
const TRANSITO_INFERIDO_REDUCAO = 20;
const TRANSITO_INFERIDO_SCORE_MINIMO = 30;

// Transito inferido pela PROPRIA frota (floating car data, decisao do
// usuario 12/07 apos pesquisa mostrar que nao ha fonte de transito real
// gratuita e self-serve viavel): se 2+ outros veiculos da frota estao
// LENTOS (nao parados, ver vizinhosParados que ja existe pra isso) perto
// da posicao, em contexto de rodovia, isso corrobora "corte de transito
// legitimo" em vez de desvio suspeito -- reduz a prioridade, nunca some o
// alerta (piso minimo).
export function reduzirPorTransitoInferido(
  alerta: Alerta,
  ctx: { emRodovia: boolean; vizinhosLentos: number }
): Alerta {
  if (alerta.tipo !== "desvio") return alerta;
  if (!ctx.emRodovia || ctx.vizinhosLentos < TRANSITO_INFERIDO_MIN_VIZINHOS) return alerta;
  return {
    ...alerta,
    score: Math.max(TRANSITO_INFERIDO_SCORE_MINIMO, alerta.score - TRANSITO_INFERIDO_REDUCAO),
  };
}

export type CtxAvaliacao = {
  paradoMin: number;
  emOperacao: boolean;
  foraDaBase: boolean;
  noCliente?: boolean;
  distDestinosM?: number[];
  distDestinosAnteriorM?: number[];
  desvioStreak?: number;
  afastamentoAcumuladoM?: number;
  dentroTapete?: boolean | null;
  familiarVeiculo?: boolean | null;
  quedaClasseViaria?: boolean;
  riscoAreaAtual?: number;
  foraTapeteStreak?: number;
  temPendentes?: boolean;
  entregasTotal?: number;
  entregasFeitas?: number;
  alvosApiOk?: boolean;
  sabadoDiurnoComRota?: boolean;
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
};

// Monta a lista CRUA de candidatos dos detectores "core" (sem arbitrar).
// Exportada pra route.ts poder combinar esses candidatos com os "extras"
// (cerca virtual, bypass, baseline) numa UNICA arbitragem. Bug real 12/07
// corrigido: chamar arbitrarCandidatos duas vezes em cadeia (uma aqui
// dentro, outra em route.ts com os extras) somava o bonus de corroboracao
// 2x quando o mesmo tipo (ex: "desvio", vindo de detectarDesvio aqui E de
// alertaCerca em route.ts, fontes diferentes do mesmo tipo) aparecia nas
// duas chamadas -- arbitrar so uma vez sobre a uniao de todos os candidatos
// crus evita a duplicacao.
export function montarCandidatosCore(p: PosicaoNormalizada, ctx: CtxAvaliacao): Alerta[] {
  return [
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
      ? aplicarBonusClasseViaria(detectarDesvio(p, {
          distDestinosM: ctx.distDestinosM ?? [],
          distDestinosAnteriorM: ctx.distDestinosAnteriorM ?? [],
          temPendentes: ctx.temPendentes ?? false,
          emOperacao: ctx.emOperacao,
          foraDaBase: ctx.foraDaBase,
          entregasFeitas: ctx.entregasFeitas,
          alvosApiOk: ctx.alvosApiOk,
          sabadoDiurnoComRota: ctx.sabadoDiurnoComRota,
          streak: ctx.desvioStreak ?? 0,
          afastamentoAcumuladoM: ctx.afastamentoAcumuladoM ?? 0,
          dentroTapete: ctx.dentroTapete ?? null,
          familiarVeiculo: ctx.familiarVeiculo ?? null,
          riscoAreaAtual: ctx.riscoAreaAtual ?? 0,
          foraTapeteStreak: ctx.foraTapeteStreak ?? 0,
        }), ctx.quedaClasseViaria ?? false)
      : null,
  ].filter((a): a is Alerta => a !== null);
}

// Avalia todos os detectores core e retorna o alerta de maior severidade.
// Prioridade: critico > atencao; desempate por score (maior vence).
export function avaliar(p: PosicaoNormalizada, ctx: CtxAvaliacao): Alerta | null {
  return arbitrarCandidatos(montarCandidatosCore(p, ctx));
}
