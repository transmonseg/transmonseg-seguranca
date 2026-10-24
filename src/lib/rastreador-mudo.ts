// F3-09 (ACH-09, MON-08 / DR-14): rastreador mudo com carga.
//
// Carro com NF no romaneio do dia e rastreador sem comunicar ha' dias nao
// gerava alerta nenhum: romaneio_ausente exige GPS fresco e o loop do
// motor-romaneio pula quem nao e' fresco. O KPI marca "SEM RASTREADOR - SEM
// COMUNICAR DESDE DD/MM" e conta como correto (regra do dono, que NAO muda),
// entao ninguem era acionado para consertar o equipamento. Casos de 20-23/10:
// LTZ-7I72 (mudo desde 03/10), RJM-5B51 (desde 20/08) e EEG-2F60 (nunca
// transmitiu).
//
// Alerta INTERNO, nivel atencao, 1 por veiculo por dia. A cobranca ao
// cliente fica com o dono (D-32): conta de cliente nao ve este tipo.
//
// Regra (replay 12-23/10 em posicoes_historico, ticks de 15 min):
//  - mudo = sem linha em posicoes_atuais (nunca transmitiu) OU atraso efetivo
//    (max(atraso_min, idade do updated_at), F1-15) >= 24 h. O maior atraso de
//    carro que so' dormiu, com romaneio ja' carregado, foi 1.039 min
//    (OXE-7D03, 23/10 06:21);
//  - so' cria a partir das 10h BRT: carro parado de sabado a segunda chega a
//    36 h de atraso de madrugada e liga ao sair (RQU-1B50, 20/10: 2.688 min
//    as 06:56). O replay deu o mesmo conjunto com e sem essa trava;
//  - so' veiculo ativo de cliente ativo (TTF-5I09 e TTI-9B98, inativos, tinham
//    romaneio em 20/10 -- placa fora da frota e' outro caso do F3-09).

import { atrasoEfetivoMin } from "@/lib/frescor-posicao";
import { dataSP } from "@/lib/motor-romaneio-estado";
import type { AcessoCliente } from "@/lib/acesso-cliente";

export const TIPO_RASTREADOR_MUDO = "rastreador_mudo_com_carga";
export const LIMIAR_RASTREADOR_MUDO_MIN = 24 * 60;
export const HORA_MIN_RASTREADOR_MUDO_SP = 10;

/** Tipos de alertas_romaneio que so' a central (operador Transmonseg) ve. */
export const TIPOS_ALERTA_INTERNOS: ReadonlySet<string> = new Set([TIPO_RASTREADOR_MUDO]);

export type CargaComPosicao = {
  veiculo_id: string;
  cliente_id: string;
  placa: string;
  nfs: number;
  tem_posicao: boolean;
  lat: number | null;
  lng: number | null;
  atraso_min: number | null;
  updated_at: string | Date | null;
};

// $1 = dia (SP). Uma linha por veiculo com NF no romaneio do dia, com a
// posicao atual quando existe (LEFT JOIN: EEG-2F60 nunca teve linha).
export const SQL_CARGA_DO_DIA_COM_POSICAO = `SELECT v.id AS veiculo_id, v.cliente_id, v.placa,
              rp.nfs, (pa.veiculo_id IS NOT NULL) AS tem_posicao,
              pa.lat, pa.lng, pa.atraso_min, pa.updated_at
         FROM (SELECT veiculo_id, count(*)::int AS nfs
                 FROM romaneio_pontos
                WHERE romaneio_data = $1::date
                  AND modo_teste = false
                  AND veiculo_id IS NOT NULL
                GROUP BY veiculo_id) rp
         JOIN veiculos v ON v.id = rp.veiculo_id AND v.ativo
         JOIN clientes c ON c.id = v.cliente_id AND c.ativo
         LEFT JOIN posicoes_atuais pa ON pa.veiculo_id = v.id`;

export function rastreadorMudo(c: CargaComPosicao, agora: Date): boolean {
  if (!c.tem_posicao) return true;
  const atraso = atrasoEfetivoMin(c.atraso_min, c.updated_at, agora);
  if (atraso == null) return false;
  return atraso >= LIMIAR_RASTREADOR_MUDO_MIN;
}

/** Ultimo GPS estimado = gravacao - atraso informado pela Unitrac (nunca datagps, 3 h deslocado). */
export function ultimaComunicacaoEstimada(
  atrasoMin: number | null,
  updatedAt: string | Date | null,
): Date | null {
  if (atrasoMin == null || updatedAt == null) return null;
  const t = (updatedAt instanceof Date ? updatedAt : new Date(updatedAt)).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - atrasoMin * 60_000);
}

function ddmmSP(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }).format(d);
}

export function motivoRastreadorMudo(c: CargaComPosicao): string {
  const nfs = `${c.nfs} NFs no romaneio de hoje`;
  if (!c.tem_posicao) {
    return `Rastreador nunca transmitiu, com ${nfs} -- conferir o equipamento (no KPI conta como correto, sem rastreador)`;
  }
  const ultima = ultimaComunicacaoEstimada(c.atraso_min, c.updated_at);
  const desde = ultima ? ` desde ${ddmmSP(ultima)}` : "";
  return `Rastreador sem comunicar${desde}, com ${nfs} -- conferir o equipamento (no KPI conta como correto, sem rastreador)`;
}

function horaSP(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(d),
  );
}

export type AlertaRastreadorExistente = {
  id: string;
  veiculo_id: string;
  status: string;
  desde: string;
  contexto?: Record<string, unknown> | null;
};

/**
 * Decide o ciclo: quem ganha alerta novo e quais alertas ativos fecham sozinhos.
 * - cria: carga do dia + rastreador mudo + a partir das 10h BRT + sem alerta
 *   deste tipo HOJE em qualquer status (1 por veiculo por dia; o operador
 *   que resolveu nao ve o card voltar no mesmo dia);
 * - fecha: alerta ativo de outro dia, ou de hoje cujo carro ja' nao esta' mudo
 *   com carga (rastreador voltou ou NF saiu do romaneio).
 */
export function planejarRastreadorMudo(p: {
  cargas: CargaComPosicao[];
  existentes: AlertaRastreadorExistente[];
  hoje: string;
  agora: Date;
}): { inserir: CargaComPosicao[]; resolver: string[] } {
  const mudos = p.cargas.filter(
    (c) => typeof c.veiculo_id === "string" && typeof c.nfs === "number" && c.nfs > 0 && rastreadorMudo(c, p.agora),
  );
  const mudosIds = new Set(mudos.map((c) => c.veiculo_id));

  const comAlertaHoje = new Set(
    p.existentes.filter((a) => dataSP(new Date(a.desde)) === p.hoje).map((a) => a.veiculo_id),
  );

  const podeCriar = horaSP(p.agora) >= HORA_MIN_RASTREADOR_MUDO_SP;
  const inserir = podeCriar ? mudos.filter((c) => !comAlertaHoje.has(c.veiculo_id)) : [];

  const resolver = p.existentes
    .filter((a) => a.status === "ativo")
    .filter((a) => dataSP(new Date(a.desde)) !== p.hoje || !mudosIds.has(a.veiculo_id))
    .map((a) => a.id);

  return { inserir, resolver: [...new Set(resolver)] };
}

/** Conta de cliente (acesso "um") nao ve alerta interno. */
export function semAlertasInternos<T extends { tipo: string }>(lista: T[], acesso: AcessoCliente): T[] {
  if (acesso.tipo === "todos") return lista;
  return lista.filter((a) => !TIPOS_ALERTA_INTERNOS.has(a.tipo));
}
