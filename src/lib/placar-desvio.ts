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
  d1ParadaPertoDeEntrega: -15,
  d2PadraoEntrega: -6,
  d3DestinoAlinhadoAproximando: -10,
  d4DentroDoCorredor: -6,
} as const;

export const PLACAR_DECAIMENTO = 0.9;
export const PLACAR_AMARELO = 40;
export const PLACAR_AMARELO_DESLIGA = 25;
export const PLACAR_VERMELHO = 70;

export const D1_RAIO_EXTRA_M = 300;
export const D1_PARADA_MIN_SEG = 120;
export const D2_VEL_MEDIA_MAX_KMH = 25;
export const D2_PARADA_MIN_SEG = 60;
export const D2_MIN_PARADAS = 2;
export const D3_DIST_MAX_M = 1500;
export const D3_RUMO_MAX_GRAUS = 100;
export const S5_ESTAGNADO_MIN = 45;

export type SinaisPlacar = {
  s1AfastandoDeTudo: boolean;
  s2RumoDivergente: boolean;
  // null = corredor indisponivel neste ciclo (nem soma S3 nem desconta D4).
  // true = fora do corredor (soma S3). false = dentro do corredor (desconta D4).
  s3ForaDoCorredor: boolean | null;
  s4CelulaDesconhecida: boolean;
  s5DiaEstagnado: boolean;
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
  soma1("d1ParadaPertoDeEntrega", sinais.d1ParadaPertoDeEntrega);
  soma1("d2PadraoEntrega", sinais.d2PadraoEntrega);
  soma1("d3DestinoAlinhadoAproximando", sinais.d3DestinoAlinhadoAproximando);

  return { soma, componentes };
}

// Formula: placar = clamp(0, 100, placar_anterior*0.9 + soma_dos_sinais).
// suspensoPorChegada (chegou no destino) zera na hora, sem olhar os sinais
// do ciclo -- achado real: veiculo que chegou nao deve carregar suspeita
// residual pro proximo trecho da rota.
export function atualizarPlacar(
  placarAnterior: number,
  sinais: SinaisPlacar,
  suspensoPorChegada: boolean
): { placar: number; componentes: Record<string, number | boolean> } {
  if (suspensoPorChegada) {
    return { placar: 0, componentes: { zeradoPorChegada: true } };
  }

  const { soma, componentes } = componentesDoCiclo(sinais);
  const bruto = placarAnterior * PLACAR_DECAIMENTO + soma;
  const placar = Math.max(0, Math.min(100, bruto));

  return { placar, componentes };
}

// Janela = posicoes dos ultimos 10min (ordem cronologica), mesma shape do
// que o motor ja tem em memoria.
export type PontoJanela = { lat: number; lng: number; velocidade: number; criadoEm: string };
export type DestinoPlacar = { lat: number; lng: number; raio: number; codigo: string };

// Agrupa a janela em runs consecutivos de velocidade 0 (parado), na ordem
// em que aparecem no array -- base pra D1 (parada perto de entrega) e D2
// (padrao de entrega com paradas).
function runsVelocidadeZero(janela: PontoJanela[]): PontoJanela[][] {
  const runs: PontoJanela[][] = [];
  let atual: PontoJanela[] = [];
  for (const p of janela) {
    if (p.velocidade === 0) {
      atual.push(p);
    } else if (atual.length > 0) {
      runs.push(atual);
      atual = [];
    }
  }
  if (atual.length > 0) runs.push(atual);
  return runs;
}

// Duracao do run em segundos (diferenca entre o primeiro e o ultimo ponto).
// Run de 1 ponto so nao tem duracao observavel -- conta como 0.
function duracaoSeg(run: PontoJanela[]): number {
  if (run.length < 2) return 0;
  const primeiro = new Date(run[0].criadoEm).getTime();
  const ultimo = new Date(run[run.length - 1].criadoEm).getTime();
  return (ultimo - primeiro) / 1000;
}

// D1: parou >=2min (D1_PARADA_MIN_SEG) a <= raio+300m (D1_RAIO_EXTRA_M) de
// alguma entrega, nos ultimos 10min (janela ja vem cortada pelo chamador).
export function paradaRecentePertoDeEntrega(janela: PontoJanela[], destinos: DestinoPlacar[]): boolean {
  for (const run of runsVelocidadeZero(janela)) {
    if (duracaoSeg(run) < D1_PARADA_MIN_SEG) continue;
    const posParada = run[run.length - 1]; // posicao mais recente da parada
    for (const destino of destinos) {
      const dist = haversineM(posParada.lat, posParada.lng, destino.lat, destino.lng);
      if (dist <= destino.raio + D1_RAIO_EXTRA_M) return true;
    }
  }
  return false;
}

// D2: padrao de entrega -- media de velocidade <=25km/h E >=2 paradas
// (velocidade 0 por >=60s cada) nos ultimos 10min.
export function padraoEntrega(janela: PontoJanela[]): boolean {
  if (janela.length === 0) return false;

  const media = janela.reduce((acc, p) => acc + p.velocidade, 0) / janela.length;
  if (media > D2_VEL_MEDIA_MAX_KMH) return false;

  const paradas = runsVelocidadeZero(janela).filter((run) => duracaoSeg(run) >= D2_PARADA_MIN_SEG).length;
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
