// Ajusta o rastro (trajeto JA percorrido) pra colar na malha viaria real via
// OSRM (servico publico, gratuito, sem chave). Diferente do antigo "corredor"
// de rota (removido — inventava destino futuro), aqui so corrigimos um
// trajeto GPS que ja aconteceu: sem isso, a linha entre dois pontos de GPS
// reais e desenhada RETA no mapa, cortando direto por cima de quarteirao ou
// casas quando o salto entre eles e grande (amostragem esparsa da Unitrac).
//
// Por que /route (2 pontos por chamada) e nao /match (o servico "certo" pra
// trace GPS): o servidor publico do OSRM tem um teto de tamanho de trace
// pra /match muito baixo (testado: falha com so 12 pontos, "TooBig") —
// inviavel pra um rastro com centenas de pontos. /route entre 2 pontos nao
// tem esse teto e da o caminho real na rua entre eles, que e o que importa
// pros saltos grandes; saltos pequenos ja ficam bons como reta mesmo.
import { haversineM } from "./unitrac";

// Acima disso (m), a reta entre dois pontos consecutivos corta quarteirao
// visivelmente — vale a pena buscar o caminho real. Abaixo, reta ja fica bem.
const GAP_MINIMO_M = 400;
// Teto de chamadas por rastro. 40 era baixo demais e deixava a maior parte
// do rastro sem corrigir (achado real 08/07: veiculo com 24h de rastro tinha
// 122 saltos grandes — só os 40 primeiros por ordem cronológica eram
// corrigidos, os outros ~80 ficavam retos, exatamente os "tiros" cortando
// morro reportados). Medido ao vivo: 122 chamadas reais (concorrência 6)
// levam ~5,6s, bem dentro do tempo que a tela já mostra "carregando..." —
// o teto nunca foi sobre latência, era baixo demais por precaução excessiva.
const MAX_CHAMADAS = 200;
// Quantas chamadas em voo ao mesmo tempo — rapido, mas educado com o
// servidor publico (nao e dimensionado pra rajada alta).
const CONCORRENCIA = 6;
// Acima disso (razao rota_real/reta), REJEITA o ajuste e mantem a reta.
// Achado ao vivo (06/07/2026): quando a via exige contorno grande (mao
// unica, rio, rodovia sem saida ali), o OSRM retorna uma rota gigante
// (caso real: reta de 555m virou rota de 7.430m, 13x) — desenhar isso
// parece um "tiro" pior que a reta original. O carro quase certamente nao
// fez esse contorno todo num unico salto de amostragem; foi so um gap de
// GPS. Reta (mesmo cortando reto) e menos errado que um loop de km.
//
// 2.5x rejeitava contorno LEGITIMO com frequencia: a frota opera em regiao
// serrana (Nova Friburgo/RJ), onde uma estrada real contornando morro/vale
// facilmente passa de 2.5x a distancia em reta pro mesmo salto de GPS —
// o ajuste bom (rua real) era descartado exatamente nos trechos mais
// tortuosos, sobrando a reta cortando por cima do morro (visto ao vivo
// 08/07). 5x ainda pega o caso originalmente motivador (13x).
const RAZAO_MAX_ACEITAVEL = 5;

type Ponto = { lat: number; lng: number };

type OsrmRouteResponse = {
  code: string;
  routes?: { geometry?: { coordinates?: [number, number][] }; distance?: number }[];
};

// Busca o caminho real (nas ruas) entre dois pontos. Em qualquer falha
// (rede, timeout, sem rota) OU quando a rota real e desproporcionalmente
// mais longa que a reta (ver RAZAO_MAX_ACEITAVEL), retorna null — o
// chamador mantém a reta original naquele trecho.
async function buscarCaminhoReal(a: Ponto, b: Ponto): Promise<Ponto[] | null> {
  try {
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as OsrmRouteResponse;
    const rota = data.routes?.[0];
    const coords = rota?.geometry?.coordinates;
    if (data.code !== "Ok" || !coords || coords.length === 0 || rota?.distance == null) return null;
    const distanciaReta = haversineM(a.lat, a.lng, b.lat, b.lng);
    if (distanciaReta > 0 && rota.distance / distanciaReta > RAZAO_MAX_ACEITAVEL) return null;
    return coords.map(([lng, lat]) => ({ lat, lng }));
  } catch {
    return null;
  }
}

// Identifica os indices i (0-based) onde o salto pontos[i] -> pontos[i+1] é
// grande o bastante pra valer a pena corrigir. Função pura, testável sem rede.
export function indicesDeSaltosGrandes(pontos: Ponto[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < pontos.length - 1; i++) {
    const d = haversineM(pontos[i].lat, pontos[i].lng, pontos[i + 1].lat, pontos[i + 1].lng);
    if (d > GAP_MINIMO_M) indices.push(i);
  }
  return indices;
}

// Ajusta o rastro: para cada salto grande entre pontos consecutivos, busca o
// caminho real na rua e o insere no lugar da reta. Processa em lotes com
// concorrência limitada; teto de chamadas evita travar em trajetos muito
// esparsos. Qualquer falha individual mantém a reta original naquele trecho
// — o rastro nunca fica pior do que estava.
export async function ajustarRastroParaRuas(pontos: Ponto[]): Promise<Ponto[]> {
  if (pontos.length < 2) return pontos;

  const indices = indicesDeSaltosGrandes(pontos).slice(0, MAX_CHAMADAS);
  if (indices.length === 0) return pontos;

  const caminhos = new Map<number, Ponto[]>();
  for (let i = 0; i < indices.length; i += CONCORRENCIA) {
    const lote = indices.slice(i, i + CONCORRENCIA);
    const resultados = await Promise.all(
      lote.map((idx) => buscarCaminhoReal(pontos[idx], pontos[idx + 1]))
    );
    lote.forEach((idx, j) => {
      const caminho = resultados[j];
      if (caminho) caminhos.set(idx, caminho);
    });
  }

  if (caminhos.size === 0) return pontos;

  const resultado: Ponto[] = [];
  for (let i = 0; i < pontos.length; i++) {
    resultado.push(pontos[i]);
    const caminho = caminhos.get(i);
    if (caminho) resultado.push(...caminho);
  }
  return resultado;
}
