// Placar acumulativo de desvio (0-100) por veiculo -- substitui os tres
// detectores binarios isolados (afastando_de_tudo, rumo_diverge,
// classe_viaria) por um score que soma evidencia (S1-S5) e desconta
// comportamento de entrega normal (D1-D3), com decaimento por ciclo.
// Ver docs/superpowers/specs/2026-08-01-placar-desvio-design.md.
// Nunca importe nada de 'next' aqui -- lib pura Node/TypeScript.

import { haversineM } from "./unitrac";

export const PLACAR_PESOS = {
  s1AfastandoDeTudo: 8,
  s2RumoDivergente: 6,
  s3ForaDoCorredor: 8,
  s4CelulaDesconhecida: 3,
  s5DiaEstagnado: 2,
  // S6 (achado auditoria 04/08): S1/S2/S4/S5 so somam sob o mesmo guard dos
  // streaks de desvio (podeAvancarStreaksDesvio, exige velocidade>0) -- um
  // veiculo que desvia e PARA fica invisivel pro placar, so resta o
  // decaimento. Mesmo buraco ja corrigido pro sistema antigo em 27/07
  // (detectarParadaForaTapete, caso TTK-4D14), nunca replicado pro placar.
  // Peso igual ao S1 (equivalente parado do "afastando de tudo" em
  // movimento) -- ver S6_DIST_MIN_M abaixo pro "longe" e wiring em
  // route.ts (candidatoS6ParadoLongeDeTudo) pro "parado", independente de
  // podeSomarSinaisPlacar.
  s6ParadoLongeDeTudo: 8,
  d1ParadaPertoDeEntrega: -15,
  d2PadraoEntrega: -6,
  d3DestinoAlinhadoAproximando: -10,
  d4DentroDoCorredor: -6,
} as const;

export const PLACAR_DECAIMENTO = 0.9;
export const PLACAR_AMARELO = 40;
export const PLACAR_AMARELO_DESLIGA = 25;
export const PLACAR_VERMELHO = 70;

// Piso do decaimento (achado pos-revisao-final 01/08): decaimento
// multiplicativo (*0.9/ciclo) nunca chega a 0 sozinho -- e uma assintota.
// Sem isso, o gate do log em route.ts (`placarNovo > 0`) fica aberto pra
// sempre pra qualquer veiculo que ja teve QUALQUER sinal um dia, inflando
// placar_desvio_log indefinidamente. Abaixo de 0.5 zera de vez (snap).
export const PLACAR_PISO_ZERAR = 0.5;

// NOTA HISTORICA (removida 01/08, pos-revisao-independente): a 1a versao
// da troca de regra do classe_viaria usava um limiar numerico fixo aqui
// (CLASSE_VIARIA_PLACAR_MINIMO=15, aplicado DEPOIS da arbitragem em
// route.ts). Reprovada com 3 findings Critical -- o mais grave: o limiar
// era estruturalmente inalcancavel num ciclo de classe_viaria (S1/S3
// nunca disparam nesse branch por construcao, S2 raramente em rua
// estreita/baixa velocidade), entao na pratica era um "desligar
// classe_viaria" disfarcado. O redesenho (ver
// CLASSE_VIARIA_EXIGE_AUSENCIA_DE_ENTREGA_ATIVO em route.ts e
// classeViariaSuprimidaPorEntrega em detectores.ts) suprime por PROVA
// POSITIVA de entrega (D1/D2/D3 do placar) em vez de limiar de placar, e
// entra como INPUT da deteccao (nao supressao pos-hoc) -- corrige tambem
// os outros dois findings (mascaramento de branches seguintes e
// descarte sem re-arbitragem).

export const D1_RAIO_EXTRA_M = 300;
export const D1_PARADA_MIN_SEG = 120;
export const D2_VEL_MEDIA_MAX_KMH = 25;
export const D2_PARADA_MIN_SEG = 60;
export const D2_MIN_PARADAS = 2;
export const D3_DIST_MAX_M = 1500;
export const D3_RUMO_MAX_GRAUS = 100;
export const S5_ESTAGNADO_MIN = 45;

// S6: piso de tempo parado (mesmo valor de PARADA_FORA_TAPETE_MIN em
// detectores.ts -- gatilho rapido, mesma justificativa: parada curta ja
// fora de tudo e corroboracao espacial forte o bastante pra confirmar
// rapido) e piso de distancia minima de QUALQUER destino/base pra contar
// como "longe de tudo" (ordem de grandeza de D1_RAIO_EXTRA_M(300) + raio
// tipico de entrega, ~500m cobre "nao esta nem perto de nada conhecido").
export const S6_PARADO_MIN_SEG = 180;
export const S6_DIST_MIN_M = 500;

// S2 (soma): rumo diverge de TODOS os destinos acima deste limiar. Mesmo
// valor numerico do limiar de rumo_diverge em unitrac.ts
// (DIVERGENCIA_RUMO_LIMIAR_GRAUS) e de D3_RUMO_MAX_GRAUS acima, mas SAO
// constantes semanticamente distintas (uma soma pro placar quando ACIMA,
// a outra desconta quando ABAIXO) -- nao unificar so por coincidencia de
// valor. Existe pra route.ts nao carregar o literal `100` sem nome.
export const S2_RUMO_LIMIAR_GRAUS = 100;

// "Parado" pra fins de run de parada (D1/D2): <=5km/h, nao so ===0.
// Achado de producao 01/08: amostragem do motor e a cada ~30s (nao
// continua), entao uma unica amostra de GPS-drag (1-5km/h) no meio de uma
// parada real cortava o run em dois pedacos curtos demais pra baterem o
// minimo de duracao (D1_PARADA_MIN_SEG/D2_PARADA_MIN_SEG) individualmente.
export const PARADA_VELOCIDADE_MAX_KMH = 5;

export type SinaisPlacar = {
  s1AfastandoDeTudo: boolean;
  s2RumoDivergente: boolean;
  // null = corredor indisponivel neste ciclo (nem soma S3 nem desconta D4).
  // true = fora do corredor (soma S3). false = dentro do corredor (desconta D4).
  s3ForaDoCorredor: boolean | null;
  s4CelulaDesconhecida: boolean;
  s5DiaEstagnado: boolean;
  s6ParadoLongeDeTudo: boolean;
  d1ParadaPertoDeEntrega: boolean;
  d2PadraoEntrega: boolean;
  d3DestinoAlinhadoAproximando: boolean;
};

// Soma os pontos do ciclo (S1-S5, D1-D3 + D4 derivado de s3ForaDoCorredor
// === false) e devolve o detalhamento pra log/auditoria.
function componentesDoCiclo(sinais: SinaisPlacar): { soma: number; componentes: Record<string, number> } {
  const componentes: Record<string, number> = {};
  let soma = 0;

  const soma1 = (chave: keyof typeof PLACAR_PESOS, disparou: boolean) => {
    if (!disparou) return;
    componentes[chave] = PLACAR_PESOS[chave];
    soma += PLACAR_PESOS[chave];
  };

  soma1("s1AfastandoDeTudo", sinais.s1AfastandoDeTudo);
  soma1("s2RumoDivergente", sinais.s2RumoDivergente);
  if (sinais.s3ForaDoCorredor === true) soma1("s3ForaDoCorredor", true);
  else if (sinais.s3ForaDoCorredor === false) soma1("d4DentroDoCorredor", true);
  soma1("s4CelulaDesconhecida", sinais.s4CelulaDesconhecida);
  soma1("s5DiaEstagnado", sinais.s5DiaEstagnado);
  soma1("s6ParadoLongeDeTudo", sinais.s6ParadoLongeDeTudo);
  soma1("d1ParadaPertoDeEntrega", sinais.d1ParadaPertoDeEntrega);
  soma1("d2PadraoEntrega", sinais.d2PadraoEntrega);
  soma1("d3DestinoAlinhadoAproximando", sinais.d3DestinoAlinhadoAproximando);

  return { soma, componentes };
}

// Formula: placar = clamp(0, 100, placar_anterior*0.9 + soma_dos_sinais).
// suspensoPorChegada (chegou no destino) zera na hora, sem olhar os sinais
// do ciclo -- achado real: veiculo que chegou nao deve carregar suspeita
// residual pro proximo trecho da rota.
// `componentes` aceita number|boolean|string: os pontos S1-S5/D1-D4 e
// `zeradoPorChegada` sao number/boolean (calculados aqui), mas route.ts
// tambem MUTA este objeto depois de retornado pra anotar auditoria de
// supressao (classeViariaSuprimida: true, classeViariaSuprimidaPor:
// "d3" etc, ver gate do classe_viaria em route.ts) -- string acomoda
// esse campo extra sem forcar um segundo objeto/parametro.
export function atualizarPlacar(
  placarAnterior: number,
  sinais: SinaisPlacar,
  suspensoPorChegada: boolean
): { placar: number; componentes: Record<string, number | boolean | string> } {
  if (suspensoPorChegada) {
    return { placar: 0, componentes: { zeradoPorChegada: true } };
  }

  const { soma, componentes } = componentesDoCiclo(sinais);
  const bruto = placarAnterior * PLACAR_DECAIMENTO + soma;
  const clampado = Math.max(0, Math.min(100, bruto));
  // Piso: decaimento puro (sem sinal no ciclo) e assintotico, nunca bate 0
  // sozinho -- abaixo de PLACAR_PISO_ZERAR zera de vez (ver comentario da
  // constante). Só entra em jogo quando os sinais do ciclo não já cravaram
  // o clamp em 0 ou empurraram acima do piso.
  const placar = clampado < PLACAR_PISO_ZERAR ? 0 : clampado;

  return { placar, componentes };
}

// Janela = posicoes dos ultimos 20min (ordem cronologica, alargada de
// 10min na auditoria 04/08 -- ver buscarJanelaHistoricoCliente em
// route.ts), mesma shape do que o motor ja tem em memoria.
export type PontoJanela = { lat: number; lng: number; velocidade: number; criadoEm: string };
export type DestinoPlacar = { lat: number; lng: number; raio: number; codigo: string };

type RunParada = { pontos: PontoJanela[]; duracaoSeg: number };

// Agrupa a janela em runs consecutivos de "parado" (velocidade <=
// PARADA_VELOCIDADE_MAX_KMH, nao so ===0), na ordem em que aparecem no
// array -- base compartilhada pra D1 (parada perto de entrega) e D2
// (padrao de entrega com paradas).
//
// Duracao (achado de producao 01/08): NAO e mais zero-a-zero (primeiro
// ponto parado ate o ultimo ponto parado do mesmo run). O motor amostra a
// cada ~30s, entao zero-a-zero subestimava sistematicamente uma parada
// real -- uma parada de 2min podia medir so 60-90s entre a primeira e a
// ultima amostra zerada. Duracao correta = do timestamp da PRIMEIRA
// amostra parada ATE o timestamp da PRIMEIRA amostra em movimento depois
// do run (o proximo ponto do array, que por construcao do agrupamento e
// sempre movimento) -- ou o fim da janela, se o run for o ultimo (sem
// amostra de movimento seguinte pra balizar; nesse caso o "fim da janela"
// e o proprio ultimo ponto do run, ja que nada vem depois dele no array).
function runsParada(janela: PontoJanela[]): RunParada[] {
  const runs: RunParada[] = [];
  let atual: PontoJanela[] = [];
  for (let i = 0; i < janela.length; i++) {
    const p = janela[i];
    if (p.velocidade <= PARADA_VELOCIDADE_MAX_KMH) {
      atual.push(p);
    } else if (atual.length > 0) {
      const inicio = new Date(atual[0].criadoEm).getTime();
      const fim = new Date(p.criadoEm).getTime(); // primeira amostra em movimento depois do run
      runs.push({ pontos: atual, duracaoSeg: (fim - inicio) / 1000 });
      atual = [];
    }
  }
  if (atual.length > 0) {
    // Run e o ultimo da janela -- sem amostra de movimento seguinte pra
    // balizar o fim, usa o proprio ultimo ponto do array (que e o ultimo
    // ponto do run, ja que nada mais vem depois dele).
    const inicio = new Date(atual[0].criadoEm).getTime();
    const fim = new Date(janela[janela.length - 1].criadoEm).getTime();
    runs.push({ pontos: atual, duracaoSeg: (fim - inicio) / 1000 });
  }
  return runs;
}

// D1: parou >=2min (D1_PARADA_MIN_SEG) a <= raio+300m (D1_RAIO_EXTRA_M) de
// alguma entrega, nos ultimos 20min (janela ja vem cortada pelo chamador).
export function paradaRecentePertoDeEntrega(janela: PontoJanela[], destinos: DestinoPlacar[]): boolean {
  for (const run of runsParada(janela)) {
    if (run.duracaoSeg < D1_PARADA_MIN_SEG) continue;
    const posParada = run.pontos[run.pontos.length - 1]; // posicao mais recente da parada
    for (const destino of destinos) {
      const dist = haversineM(posParada.lat, posParada.lng, destino.lat, destino.lng);
      if (dist <= destino.raio + D1_RAIO_EXTRA_M) return true;
    }
  }
  return false;
}

// D2: padrao de entrega -- media de velocidade <=25km/h E >=2 paradas
// (velocidade <=5km/h por >=60s cada, ver PARADA_VELOCIDADE_MAX_KMH) nos
// ultimos 20min.
export function padraoEntrega(janela: PontoJanela[]): boolean {
  if (janela.length === 0) return false;

  const media = janela.reduce((acc, p) => acc + p.velocidade, 0) / janela.length;
  if (media > D2_VEL_MEDIA_MAX_KMH) return false;

  const paradas = runsParada(janela).filter((run) => run.duracaoSeg >= D2_PARADA_MIN_SEG).length;
  return paradas >= D2_MIN_PARADAS;
}

// D3: rumo coerente (<100 graus) COM entrega perto (<1500m) E distancia
// caindo vs o ciclo anterior. Achado real 01/08 (RQV-6C22): rumo coerente
// SOZINHO nao basta -- um desvio verdadeiro pode apontar por coincidencia
// pra uma entrega distante (divergencia de so 1,1 grau). So desconta com
// os tres juntos: direcao + perto + aproximando.
// distAnteriorPorCodigo: mapa codigo->dist_m persistido do ciclo anterior
// (estado jsonb) -- sem entrada pro codigo, e o primeiro ciclo vendo esse
// destino e nao ha "aproximando" pra comparar, entao nao desconta.
export function destinoAlinhadoAproximando(
  posAtual: { lat: number; lng: number },
  rumoDivergenciaPorDestino: { codigo: string; divergenciaGraus: number; distM: number }[],
  distAnteriorPorCodigo: Record<string, number>
): boolean {
  void posAtual; // reservado pra uso futuro -- as distancias ja vem calculadas no array acima

  for (const d of rumoDivergenciaPorDestino) {
    if (d.divergenciaGraus >= D3_RUMO_MAX_GRAUS) continue;
    if (d.distM >= D3_DIST_MAX_M) continue;
    const anterior = distAnteriorPorCodigo[d.codigo];
    if (anterior === undefined) continue;
    if (d.distM < anterior) return true;
  }
  return false;
}
