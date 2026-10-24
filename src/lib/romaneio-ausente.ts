// F3-07 (MON-04, ACH-04): romaneio_ausente agregado.
//
// Antes: 1 card por carro (GPS fresco e fora do poligono da base), so' Nutry.
// Deu 212, 138 e 127 cards em 20, 21 e 22/10 (23 e 46 no fim de semana com a
// frota parada); os da madrugada eram carro de pernoite fora da base. A RQ
// rodou com 21 carros no domingo 19/10 sem romaneio e sem nenhum aviso.
//
// Agora: 1 card por cliente por dia, "N carros em rota sem romaneio, ultimo
// envio ha' X h", para Nutry e RQ (CLIENTES_COM_ROMANEIO_AUSENTE). Carro "em
// rota" = GPS fresco pelo atraso efetivo (F1-15) + ignicao ligada (ou andando
// a 10 km/h ou mais, sensor de ignicao com defeito nao esconde carro rodando)
// + a mais de 5 km de TODA base do cliente.
//
// Recall (o desvio prioriza nunca perder carro rodando sem romaneio): a
// contagem do card e' a UNIAO do dia -- todo carro que entrou em algum ciclo
// fica contado, mesmo depois que o romaneio dele chega. O card fecha sozinho
// quando nenhum carro esta' em rota sem romaneio e REABRE (o mesmo card) se
// outro sair; card fechado pelo operador nao reabre, mas carro novo abre o 2o
// card do dia. Replay 20-22/10: scripts/replay-romaneio-ausente-agregado.sql.

import { sqlAtrasoEfetivo } from "@/lib/frescor-posicao";
import { dataSP } from "@/lib/motor-romaneio-estado";

export const TIPO_ROMANEIO_AUSENTE = "romaneio_ausente";
export const DIST_MIN_BASE_ROMANEIO_AUSENTE_M = 5_000;
/** Velocidade que conta como "andando" mesmo com a ignicao desligada no rastreador. */
export const VEL_EM_MOVIMENTO_KMH = 10;
const MAX_PLACAS_NO_MOTIVO = 60;
/**
 * Carencia para fechar sozinho: so' fecha depois de 30 min sem nenhum carro
 * em rota sem romaneio. Sem ela o card piscava (replay de 20/10 com ticks de
 * 1 min: a Nutry fecharia e reabriria 26 vezes -- carro entrando e saindo do
 * raio de 5 km da base).
 */
export const CARENCIA_FECHAR_MIN = 30;
/** O card so' e' regravado quando a uniao cresce ou a cada 10 min (visto_em, contagem "agora", "ha' X h"). */
export const RENOVAR_CARD_MIN = 10;

export type VeiculoEmRota = {
  veiculo_id: string;
  cliente_id: string;
  placa: string;
  lat: number | null;
  lng: number | null;
};

export type VeiculoEmRotaComRomaneio = VeiculoEmRota & { cod_user_unitrac: string; tem_romaneio: boolean };

// $1 = cod_user_unitrac[], $2 = limiar de frescor (min), $3 = dia (SP),
// $4 = distancia minima de toda base do cliente (m). Uma linha por carro em
// rota agora, com ou sem romaneio do dia (tem_romaneio). Usada pelo motor
// (so' os sem romaneio) e pela ponte do KPI (frota rodando, aviso das 06:30).
export const SQL_FROTA_EM_ROTA = `SELECT v.id AS veiculo_id, v.cliente_id, c.cod_user_unitrac, v.placa, pa.lat, pa.lng,
              EXISTS (
                SELECT 1 FROM romaneio_pontos rp
                 WHERE rp.veiculo_id = v.id
                   AND rp.romaneio_data = $3::date
                   AND rp.modo_teste = false
              ) AS tem_romaneio
         FROM veiculos v
         JOIN clientes c ON c.id = v.cliente_id AND c.ativo
         JOIN posicoes_atuais pa ON pa.veiculo_id = v.id
        WHERE c.cod_user_unitrac = ANY($1::text[])
          AND ${sqlAtrasoEfetivo("pa")} < $2
          AND (pa.ignicao IS TRUE OR COALESCE(pa.velocidade, 0) >= ${VEL_EM_MOVIMENTO_KMH})
          AND NOT EXISTS (
            SELECT 1 FROM bases b
             WHERE b.cliente_id = v.cliente_id AND ST_DWithin(b.geom, pa.geom, $4)
          )`;

// $1 = cod_user_unitrac[], $2 = dia (SP). Ultimo romaneio recebido por
// cliente (qualquer dia da ultima semana ate' hoje), para o "ultimo envio ha' X h".
export const SQL_ULTIMO_ENVIO_ROMANEIO = `SELECT v.cliente_id, max(rp.criado_em) AS ultimo_envio
         FROM romaneio_pontos rp
         JOIN veiculos v ON v.id = rp.veiculo_id
         JOIN clientes c ON c.id = v.cliente_id
        WHERE c.cod_user_unitrac = ANY($1::text[])
          AND rp.modo_teste = false
          AND rp.romaneio_data BETWEEN $2::date - 7 AND $2::date
        GROUP BY v.cliente_id`;

export type ContextoRomaneioAusente = {
  agregado: true;
  dia: string;
  placas: string[];
  veiculo_ids: string[];
  em_rota_agora: number;
  ultimo_envio: string | null;
  /** Ultima vez (renovada a cada RENOVAR_CARD_MIN) que havia carro em rota sem romaneio. */
  visto_em: string;
  auto_resolvido?: boolean;
  substituido_por_agregado?: boolean;
  [k: string]: unknown;
};

export type AlertaRomaneioAusente = {
  id: string;
  cliente_id: string;
  veiculo_id: string;
  status: string;
  desde: string;
  motivo: string;
  contexto: Record<string, unknown> | null;
  origem_acao: string | null;
};

export type NovoAlertaRomaneioAusente = {
  cliente_id: string;
  veiculo_id: string;
  nivel: "atencao";
  tipo: typeof TIPO_ROMANEIO_AUSENTE;
  motivo: string;
  score: number;
  status: "ativo";
  lat: number | null;
  lng: number | null;
  contexto: ContextoRomaneioAusente;
  desde: string;
};

export type PatchRomaneioAusente = {
  motivo: string;
  contexto: ContextoRomaneioAusente;
  veiculo_id: string;
  lat: number | null;
  lng: number | null;
  status?: "ativo";
  resolvido_em?: null;
};

export type PlanoRomaneioAusente = {
  inserir: NovoAlertaRomaneioAusente[];
  atualizar: { id: string; patch: PatchRomaneioAusente }[];
  resolver: { id: string; contexto: Record<string, unknown> }[];
};

export function textoUltimoEnvio(ultimoEnvio: string | null, agora: Date): string {
  if (!ultimoEnvio) return "nenhum envio nos últimos 7 dias";
  const min = Math.max(0, Math.floor((agora.getTime() - new Date(ultimoEnvio).getTime()) / 60_000));
  if (min < 60) return `último envio há ${min} min`;
  return `último envio há ${Math.floor(min / 60)} h`;
}

export function motivoRomaneioAusente(p: { placas: string[]; emRotaAgora: number; ultimoEnvio: string | null; agora: Date }): string {
  const placas = [...p.placas].sort();
  const n = placas.length;
  const agora = p.emRotaAgora < n ? ` (${p.emRotaAgora} agora)` : "";
  const lista = placas.slice(0, MAX_PLACAS_NO_MOTIVO).join(", ") + (n > MAX_PLACAS_NO_MOTIVO ? ` e mais ${n - MAX_PLACAS_NO_MOTIVO}` : "");
  return `${n} ${n === 1 ? "carro" : "carros"} em rota sem romaneio${agora}, ${textoUltimoEnvio(p.ultimoEnvio, p.agora)}. Placas: ${lista}`;
}

const ABERTOS = new Set(["ativo", "reconhecido"]);
const ehAgregado = (a: AlertaRomaneioAusente) => a.contexto?.agregado === true;
const listaDe = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const fechadoSozinho = (a: AlertaRomaneioAusente) =>
  a.status === "resolvido" && a.contexto?.auto_resolvido === true && !a.origem_acao;

/**
 * Decide o ciclo do romaneio_ausente. `emRota` = so' os carros em rota SEM
 * romaneio do dia (SQL_FROTA_EM_ROTA com tem_romaneio = false).
 * `existentes` = os abertos de qualquer dia + os de hoje em qualquer status.
 */
export function planejarRomaneioAusente(p: {
  emRota: VeiculoEmRota[];
  existentes: AlertaRomaneioAusente[];
  ultimoEnvio: Record<string, string | null | undefined>;
  hoje: string;
  agora: Date;
}): PlanoRomaneioAusente {
  const plano: PlanoRomaneioAusente = { inserir: [], atualizar: [], resolver: [] };
  const agoraIso = p.agora.toISOString();
  const doDia = (a: AlertaRomaneioAusente) => dataSP(new Date(a.desde)) === p.hoje;

  // Carros em rota agora, por cliente (um por veiculo).
  const porCliente = new Map<string, Map<string, VeiculoEmRota>>();
  for (const v of p.emRota) {
    const m = porCliente.get(v.cliente_id) ?? new Map<string, VeiculoEmRota>();
    if (!m.has(v.veiculo_id)) m.set(v.veiculo_id, v);
    porCliente.set(v.cliente_id, m);
  }

  // Abertos que nao sao o card de hoje: card antigo por carro (antes do
  // F3-07) ou card agregado de outro dia. Fecham sozinhos.
  for (const a of p.existentes) {
    if (!ABERTOS.has(a.status)) continue;
    if (ehAgregado(a) && doDia(a)) continue;
    const contexto = { ...(a.contexto ?? {}), auto_resolvido: true, ...(ehAgregado(a) ? {} : { substituido_por_agregado: true }) };
    plano.resolver.push({ id: a.id, contexto });
  }

  const cardsHoje = p.existentes.filter((a) => ehAgregado(a) && doDia(a));
  const clientes = new Set<string>([...porCliente.keys(), ...cardsHoje.map((a) => a.cliente_id)]);

  for (const clienteId of clientes) {
    const agoraCliente = [...(porCliente.get(clienteId)?.values() ?? [])].sort((a, b) => a.placa.localeCompare(b.placa));
    const cards = cardsHoje.filter((a) => a.cliente_id === clienteId).sort((a, b) => b.desde.localeCompare(a.desde));
    const principal = cards[0];
    const ultimoEnvio = p.ultimoEnvio[clienteId] ?? null;

    if (agoraCliente.length === 0) {
      if (principal && ABERTOS.has(principal.status) && minutosDesde(principal.contexto?.visto_em, p.agora) >= CARENCIA_FECHAR_MIN) {
        plano.resolver.push({ id: principal.id, contexto: { ...(principal.contexto ?? {}), auto_resolvido: true, em_rota_agora: 0 } });
      }
      continue;
    }

    const montar = (anterior: AlertaRomaneioAusente | undefined) => {
      const placas = [...new Set([...listaDe(anterior?.contexto?.placas), ...agoraCliente.map((v) => v.placa)])].sort();
      const ids = [...new Set([...listaDe(anterior?.contexto?.veiculo_ids), ...agoraCliente.map((v) => v.veiculo_id)])].sort();
      const rep = agoraCliente.find((v) => v.veiculo_id === anterior?.veiculo_id) ?? agoraCliente[0];
      const contexto: ContextoRomaneioAusente = {
        ...(anterior?.contexto ?? {}),
        agregado: true,
        dia: p.hoje,
        placas,
        veiculo_ids: ids,
        em_rota_agora: agoraCliente.length,
        ultimo_envio: ultimoEnvio,
        visto_em: agoraIso,
      };
      delete contexto.auto_resolvido;
      const motivo = motivoRomaneioAusente({ placas: contexto.placas, emRotaAgora: agoraCliente.length, ultimoEnvio, agora: p.agora });
      return { contexto, motivo, rep };
    };

    if (!principal) {
      const { contexto, motivo, rep } = montar(undefined);
      plano.inserir.push(novo(clienteId, rep, motivo, contexto, agoraIso));
      continue;
    }

    if (ABERTOS.has(principal.status) || fechadoSozinho(principal)) {
      const reabrir = !ABERTOS.has(principal.status);
      const { contexto, motivo, rep } = montar(principal);
      // Contagem "agora" e o "ha' X h" mudam quase todo ciclo: so' regrava
      // quando a uniao cresce, o carro do pino saiu, chegou romaneio novo ou
      // a cada RENOVAR_CARD_MIN.
      const mudou = reabrir
        || rep.veiculo_id !== principal.veiculo_id
        || contexto.veiculo_ids.join() !== listaDe(principal.contexto?.veiculo_ids).join()
        || contexto.ultimo_envio !== (principal.contexto?.ultimo_envio ?? null)
        || minutosDesde(principal.contexto?.visto_em, p.agora) >= RENOVAR_CARD_MIN;
      if (!mudou) continue;
      const patch: PatchRomaneioAusente = { motivo, contexto, veiculo_id: rep.veiculo_id, lat: rep.lat, lng: rep.lng };
      if (reabrir) { patch.status = "ativo"; patch.resolvido_em = null; }
      plano.atualizar.push({ id: principal.id, patch });
      continue;
    }

    // Operador tratou o card de hoje: so' carro que nao estava em nenhum card
    // do dia abre outro (nunca esconde carro novo rodando sem romaneio).
    const jaContados = new Set(cards.flatMap((a) => [...listaDe(a.contexto?.veiculo_ids), ...listaDe(a.contexto?.placas)]));
    if (agoraCliente.some((v) => !jaContados.has(v.veiculo_id) && !jaContados.has(v.placa))) {
      const { contexto, motivo, rep } = montar(undefined);
      plano.inserir.push(novo(clienteId, rep, motivo, contexto, agoraIso));
    }
  }

  return plano;
}

function minutosDesde(iso: unknown, agora: Date): number {
  if (typeof iso !== "string") return Infinity;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? (agora.getTime() - t) / 60_000 : Infinity;
}

function novo(clienteId: string, rep: VeiculoEmRota, motivo: string, contexto: ContextoRomaneioAusente, desde: string): NovoAlertaRomaneioAusente {
  return {
    cliente_id: clienteId,
    veiculo_id: rep.veiculo_id,
    nivel: "atencao",
    tipo: TIPO_ROMANEIO_AUSENTE,
    motivo,
    score: 20,
    status: "ativo",
    lat: rep.lat,
    lng: rep.lng,
    contexto,
    desde,
  };
}
