// Limpeza periodica do motor (DELETEs de retencao). Achado 06/10: o gatilho
// era so' `getMinutes() <= 5` e o motor roda a cada 30 s -- ~12 limpezas por
// hora, cada uma varrendo posicoes_historico inteira (11 GB, sem indice por
// data). Agora: no maximo 1 vez por hora por processo (+ indice BRIN em
// criado_em). A janela de minutos 0-5 continua (tolera ciclo perdido).
export function deveRodarLimpezaPeriodica(agora: Date, ultimaLimpeza: Date | null): boolean {
  if (agora.getMinutes() > 5) return false;
  if (!ultimaLimpeza) return true;
  return agora.getTime() - ultimaLimpeza.getTime() >= 50 * 60_000;
}
