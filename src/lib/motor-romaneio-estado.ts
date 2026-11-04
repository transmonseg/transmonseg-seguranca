// Helpers PUROS de estado do motor paralelo do romaneio
// (src/app/api/motor-romaneio/route.ts). Nenhuma regra de desvio mora aqui
// -- essas continuam em @/lib/desvio, @/lib/corredor-confirmacao e
// @/lib/classe-viaria-confirmacao, compartilhadas com a Central. Isto aqui
// é higiene do ESTADO próprio do pipeline novo (romaneio_desvio_estado):
// quando um marco de idempotência é confiável, e quando o estado guardado
// virou de outro dia. Extraído pra cá (em vez de ficar inline na rota) só
// pra poder ser testado sem banco -- ver motor-romaneio-estado.test.ts.

// Data no fuso de São Paulo (YYYY-MM-DD). NUNCA usar current_date do
// Postgres pra isso: o servidor do Contabo roda em CEST (UTC+2) e o Brasil
// é UTC-3, então o "dia" do banco vira 5h antes do dia brasileiro -- entre
// 19h e 00h de São Paulo o banco já está no dia seguinte.
export function dataSP(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}

// ─── Marco de idempotência (ultimo_datagps) ────────────────────────────────
// Histórico (22/08): a Central gravava `parseDatagps(pos.datagps) ?? agora`
// com o parse colando "Z" na hora de Brasília, ou seja, todo datagps ficava
// 3 h atrás e o fallback gravava o UTC real. A guarda antiga exigia
// `datagps <= agora - 2h` pra recusar o valor envenenado; ela dependia do
// deslocamento de 3 h e congelaria o marco no dia em que o parse fosse
// corrigido (DSV-08, auditoria 03/11).
//
// Frente H (03/11): parseDatagps lê -03:00 e devolve null em vez de "agora"
// (@/lib/datagps). Critério novo, independente do fuso: o datagps não pode
// estar no futuro em relação à gravação da própria linha (updated_at de
// posicoes_atuais), com 5 min de folga pro relógio do aparelho. Leitura real
// é sempre anterior à gravação. O valor antigo (3 h atrás) também passa, então
// a transição não congela nada. Valor no futuro (relógio do aparelho errado)
// não vira marco: guardá-lo faria o gate `datagps <= ultimo_datagps` pular o
// veículo até o relógio alcançar, perda de recall silenciosa
// ([[feedback_desvio_priorizar_recall]]). O veículo continua sendo PROCESSADO
// normalmente com a leitura suspeita; só não deixamos ela virar marco.
// Referência inválida: não vira marco (fail-open).
export const MARGEM_DATAGPS_PLAUSIVEL_MS = 5 * 60 * 1000;

export function datagpsPlausivelComoMarco(datagps: string | Date | null, referencia: string | Date | null): boolean {
  if (datagps === null || referencia === null) return false;
  const t = datagps instanceof Date ? datagps.getTime() : new Date(datagps).getTime();
  const r = referencia instanceof Date ? referencia.getTime() : new Date(referencia).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(r)) return false;
  return t <= r + MARGEM_DATAGPS_PLAUSIVEL_MS;
}

// ─── Estado que atravessou o dia ───────────────────────────────────────────
// A Central grava desvio_estado pra TODO veículo fresco em TODO ciclo, 24/7
// -- então um ciclo bloqueado por qualquer gate já zera o streak dela
// naturalmente, e não existe lá um "reset diário" pra copiar (conferido:
// nenhum cron/rotina toca desvio_estado). O motor do romaneio, ao
// contrário, retorna cedo quando não há romaneio do dia (fim de semana,
// feriado, dia sem escala) -- ninguém escreve, ninguém zera. Um veículo que
// terminou a sexta com afastando_streak=1 volta na segunda com 1: a
// PRIMEIRA leitura divergente já dispara, com metade da evidência que o
// limiar exige.
//
// Por isso o streak (e só ele) é descartado quando a última atualização do
// estado é de outro dia de São Paulo. ultima_via_principal_em e
// saiu_parada_confirmada_em NÃO precisam do mesmo tratamento: quem as
// consome (avaliarQuedaClasseViaria / avaliarSaiuParadaConfirmadaRecentemente,
// @/lib/classe-viaria-confirmacao) já compara contra `agora` com janela de
// 10min / 5min, então um valor de dias atrás simplesmente responde false --
// zerá-las aqui não mudaria resultado nenhum e só apagaria histórico.
export function estadoEhDeOutroDiaSP(atualizadoEm: Date | string | null, hoje: string): boolean {
  if (atualizadoEm === null) return false;
  const d = atualizadoEm instanceof Date ? atualizadoEm : new Date(atualizadoEm);
  if (!Number.isFinite(d.getTime())) return false;
  return dataSP(d) !== hoje;
}
