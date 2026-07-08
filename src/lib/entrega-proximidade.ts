// Confirmacao manual de entrega por proximidade: compensa o bug do Unitrac
// que as vezes nao marca entrega feita mesmo o veiculo tendo parado no
// endereco certo (perimetro deles, tipicamente ~50m, falha por GPS
// impreciso/estacionamento longe da porta/condominio grande). Nunca marca
// sozinho, so aponta um CANDIDATO pro operador confirmar (ver design em
// docs/plans/2026-07-08-entrega-proximidade-e-desvio-tapete-design.md).
import { haversineM, type PontoEntrega } from "./unitrac";

export const RAIO_CONFIRMACAO_M = 500;
export const PARADO_MIN_CONFIRMACAO = 5;

// pendentes: SO os alvos ainda pendentes (situacao=0) do veiculo -- filtrar
// antes de chamar esta funcao. Retorna o pendente mais proximo dentro do
// raio, ou null se nenhum qualifica (raio ou tempo parado insuficiente).
export function candidatoEntregaProximidade(
  pos: { lat: number; lng: number },
  paradoMin: number,
  pendentes: PontoEntrega[]
): PontoEntrega | null {
  if (paradoMin < PARADO_MIN_CONFIRMACAO) return null;
  let melhor: { ponto: PontoEntrega; dist: number } | null = null;
  for (const p of pendentes) {
    const dist = haversineM(pos.lat, pos.lng, p.lat, p.lng);
    if (dist > RAIO_CONFIRMACAO_M) continue;
    if (!melhor || dist < melhor.dist) melhor = { ponto: p, dist };
  }
  return melhor?.ponto ?? null;
}
