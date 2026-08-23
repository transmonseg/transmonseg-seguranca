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
// Achado da revisão final de 22/08 (buraco LATENTE -- nenhuma linha nesse
// estado hoje, mas o `??` que o causa está no código da Central desde
// sempre): src/app/api/motor/route.ts:2982 grava
// `datagps: parseDatagps(pos.datagps) ?? agora.toISOString()`. Quando o
// payload da Unitrac vem sem datagps (ou num formato que parseDatagps não
// casa), posicoes_atuais.datagps recebe o **UTC real** -- enquanto TODOS os
// outros valores dessa coluna são hora de Brasília rotulada como "Z", ou
// seja UTC_real - 3h (medido em produção 22/08: o datagps mais fresco da
// tabela inteira estava 3,01h "atrás" de now(), e essa distância é o piso
// estrutural, não atraso de GPS).
//
// Sem guarda, um único ciclo envenenado grava ultimo_datagps = UTC_real; no
// ciclo seguinte a Unitrac volta ao normal, datagps volta a ser
// UTC_real - 3h, o gate de idempotência vê `datagps <= ultimo_datagps` e
// PULA o veículo a cada 30s pelas ~3h seguintes -- sem streak, sem alerta,
// sem nada em erros[]. atraso_min não denuncia (vem do campo `atraso` da
// Unitrac, não é derivado de datagps). Perda de recall silenciosa, que é
// exatamente o que este produto não pode ter
// ([[feedback_desvio_priorizar_recall]]).
//
// Critério: um datagps plausível desta base está SEMPRE pelo menos ~3h
// atrás de now(). Aceitamos como marco só o que estiver a 2h ou mais no
// passado -- 1h inteira de folga sobre o piso medido de 3,01h, e ainda
// assim longe do sintoma (o valor envenenado fica a ~0h de now(), e um
// valor futuro fica negativo). O veículo continua sendo PROCESSADO
// normalmente com a leitura suspeita; só não deixamos ela virar marco.
//
// Modo de falha desta guarda, de propósito: se um dia parseDatagps for
// corrigido e datagps passar a ser UTC real pra todo mundo, TODA leitura
// vira "implausível", ultimo_datagps para de avançar e o gate de
// idempotência nunca mais pula ninguém -- o motor reprocessa o mesmo
// veículo a cada ciclo. Custo: trabalho repetido. Nunca: alerta perdido.
// Fail-open é o lado certo pra errar aqui.
export const MARGEM_DATAGPS_PLAUSIVEL_MS = 2 * 60 * 60 * 1000;

export function datagpsPlausivelComoMarco(datagps: string | Date | null, agora: Date): boolean {
  if (datagps === null) return false;
  const t = datagps instanceof Date ? datagps.getTime() : new Date(datagps).getTime();
  if (!Number.isFinite(t)) return false;
  return t <= agora.getTime() - MARGEM_DATAGPS_PLAUSIVEL_MS;
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
