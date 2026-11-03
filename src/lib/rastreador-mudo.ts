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
import { TIPO_ROMANEIO_AUSENTE } from "@/lib/romaneio-ausente";

export const TIPO_RASTREADOR_MUDO = "rastreador_mudo_com_carga";
export const LIMIAR_RASTREADOR_MUDO_MIN = 24 * 60;
export const HORA_MIN_RASTREADOR_MUDO_SP = 10;
/**
 * R-F3-09-03: a Central regrava TODA linha de posicoes_atuais a cada ciclo,
 * inclusive a de rastreador mudo (em 24/10 as 118 linhas da RQ tinham
 * updated_at de 0,5 min). Cliente sem nenhuma linha de carro com carga
 * regravada nesta janela = busca/gravacao parada (Unitrac falhando, disco
 * cheio de 20/09), nao equipamento: nao cria e avisa em erros.
 */
export const LIMIAR_POSICOES_PARADAS_MIN = 60;

/**
 * Tipos de alertas_romaneio que so' a central (operador Transmonseg) ve.
 * Revisao F3-07 (R2): romaneio_ausente agregado ("N carros em rota sem
 * romaneio, ultimo envio ha' X h") e' falha de processo interno e fica preso
 * a um carro representativo qualquer -- a conta do cliente nao ve nem age, e
 * o card nao colore esse carro no mapa.
 */
export const TIPOS_ALERTA_INTERNOS: ReadonlySet<string> = new Set([TIPO_RASTREADOR_MUDO, TIPO_ROMANEIO_AUSENTE]);

/** Predicado SQL (alertas_romaneio) que deixa os tipos internos de fora. */
export function sqlTiposInternosFora(alias: string): string {
  return `${alias}.tipo NOT IN (${[...TIPOS_ALERTA_INTERNOS].map((t) => `'${t}'`).join(", ")})`;
}

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
  cliente_nome?: string | null;
};

// $1 = dia (SP). Uma linha por veiculo com NF no romaneio do dia, com a
// posicao atual quando existe (LEFT JOIN: EEG-2F60 nunca teve linha).
export const SQL_CARGA_DO_DIA_COM_POSICAO = `SELECT v.id AS veiculo_id, v.cliente_id, c.nome AS cliente_nome, v.placa,
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

function idadeMin(updatedAt: string | Date | null, agora: Date): number {
  if (updatedAt == null) return Infinity;
  const t = (updatedAt instanceof Date ? updatedAt : new Date(updatedAt)).getTime();
  return Number.isFinite(t) ? (agora.getTime() - t) / 60_000 : Infinity;
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
}): { inserir: CargaComPosicao[]; resolver: string[]; linhasInvalidas: string[]; clientesParados: string[] } {
  // R-F3-09-04: nfs vem do pg; count sem ::int (bigint) chega como string.
  // Converte em vez de descartar, e linha ilegivel vira aviso (nunca calada).
  const validas: CargaComPosicao[] = [];
  const linhasInvalidas: string[] = [];
  const invalidasIds = new Set<string>();
  for (const c of p.cargas) {
    const nfs = Number(c.nfs);
    if (typeof c.veiculo_id === "string" && c.veiculo_id && Number.isFinite(nfs) && nfs > 0) {
      validas.push({ ...c, nfs });
    } else {
      linhasInvalidas.push(String(c.placa ?? c.veiculo_id ?? "?"));
      if (typeof c.veiculo_id === "string") invalidasIds.add(c.veiculo_id);
    }
  }
  const mudos = validas.filter((c) => rastreadorMudo(c, p.agora));
  const mudosIds = new Set(mudos.map((c) => c.veiculo_id));

  const comAlertaHoje = new Set(
    p.existentes.filter((a) => dataSP(new Date(a.desde)) === p.hoje).map((a) => a.veiculo_id),
  );

  // R-F3-09-03: cliente cujas linhas de carro com carga nao foram regravadas
  // na ultima hora = posicoes paradas (falha do sistema), nao rastreador mudo.
  const clientesVivos = new Set(
    validas
      .filter((c) => c.tem_posicao && idadeMin(c.updated_at, p.agora) < LIMIAR_POSICOES_PARADAS_MIN)
      .map((c) => c.cliente_id),
  );

  const podeCriar = horaSP(p.agora) >= HORA_MIN_RASTREADOR_MUDO_SP;
  const candidatos = podeCriar ? mudos.filter((c) => !comAlertaHoje.has(c.veiculo_id)) : [];
  const inserir = candidatos.filter((c) => clientesVivos.has(c.cliente_id));
  const clientesParados = [...new Set(candidatos.filter((c) => !clientesVivos.has(c.cliente_id)).map((c) => c.cliente_id))];

  const resolver = p.existentes
    .filter((a) => a.status === "ativo")
    .filter((a) => {
      if (dataSP(new Date(a.desde)) !== p.hoje) return true;
      // Linha ilegivel: sem dado, nao afirma que o rastreador voltou.
      if (invalidasIds.has(a.veiculo_id)) return false;
      return !mudosIds.has(a.veiculo_id);
    })
    .map((a) => a.id);

  return { inserir, resolver: [...new Set(resolver)], linhasInvalidas, clientesParados };
}

/** Conta de cliente (acesso "um") nao ve alerta interno. */
export function semAlertasInternos<T extends { tipo: string }>(lista: T[], acesso: AcessoCliente): T[] {
  if (acesso.tipo === "todos") return lista;
  return lista.filter((a) => !TIPOS_ALERTA_INTERNOS.has(a.tipo));
}

// ─── DSV-05 (auditoria 03/11): "sem sinal em rota" de 60 min a 24 h ─────────
// Com atraso >= 60 min o desvio nao e' avaliado e o streak zera; o jammer sai
// em sombra e o rastreador mudo so' comeca em 24 h. Em 30/10, 12 de 179 carros
// com romaneio ficaram 1 h a 24 h sem sinal entre 06 e 18 h sem card nenhum
// (falha silenciosa: o motor sem dado e sem dizer que esta sem dado).
// Card de atencao, 1 por carro por episodio, so' com carga do dia e carro fora
// da base. Fecha quando o sinal volta, com "voltou a X km de onde sumiu".
// NAO vai pro WhatsApp: e' so' a tela da Central Romaneio.
export const TIPO_SEM_SINAL_EM_ROTA = "sem_sinal_em_rota";
export const LIMIAR_SEM_SINAL_MIN = 60;
// Cliente sem nenhuma linha de carro com carga regravada nesta janela =
// gravacao parada (falha do sistema), nao carro sem sinal.
const LIMIAR_CLIENTE_VIVO_MIN = 10;

export function planejarSemSinal(p: { atrasoMin: number | null; temCargaHoje: boolean; naBase: boolean }): "abrir" | "nada" {
  if (!p.temCargaHoje || p.naBase || p.atrasoMin == null || !Number.isFinite(p.atrasoMin)) return "nada";
  return p.atrasoMin >= LIMIAR_SEM_SINAL_MIN && p.atrasoMin < LIMIAR_RASTREADOR_MUDO_MIN ? "abrir" : "nada";
}

export type CargaSemSinal = CargaComPosicao & { na_base: boolean | null };

// $1 = dia (SP). Igual a SQL_CARGA_DO_DIA_COM_POSICAO + se a ultima posicao
// esta dentro do poligono de alguma base do cliente.
export const SQL_CARGA_DO_DIA_SEM_SINAL = `SELECT v.id AS veiculo_id, v.cliente_id, c.nome AS cliente_nome, v.placa,
              rp.nfs, (pa.veiculo_id IS NOT NULL) AS tem_posicao,
              pa.lat, pa.lng, pa.atraso_min, pa.updated_at,
              EXISTS (SELECT 1 FROM bases b
                       WHERE b.cliente_id = v.cliente_id AND pa.lat IS NOT NULL AND pa.lng IS NOT NULL
                         AND ST_Contains(b.geom::geometry, ST_SetSRID(ST_MakePoint(pa.lng, pa.lat), 4326))) AS na_base
         FROM (SELECT veiculo_id, count(*)::int AS nfs
                 FROM romaneio_pontos
                WHERE romaneio_data = $1::date
                  AND modo_teste = false
                  AND veiculo_id IS NOT NULL
                GROUP BY veiculo_id) rp
         JOIN veiculos v ON v.id = rp.veiculo_id AND v.ativo
         JOIN clientes c ON c.id = v.cliente_id AND c.ativo
         JOIN posicoes_atuais pa ON pa.veiculo_id = v.id`;

export type AlertaSemSinalExistente = {
  id: string;
  veiculo_id: string;
  status: string;
  desde: string;
  lat: number | null;
  lng: number | null;
  contexto?: Record<string, unknown> | null;
};

function distKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (g: number) => (g * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function textoVoltouSinal(km: number): string {
  return `voltou a ${km.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km de onde sumiu`;
}

export function motivoSemSinal(c: CargaSemSinal): string {
  const ultima = ultimaComunicacaoEstimada(c.atraso_min, c.updated_at);
  const hora = ultima
    ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(ultima)
    : null;
  return `Sem sinal há ${c.atraso_min} min com ${c.nfs} NFs no romaneio de hoje, fora da base${hora ? ` (último sinal às ${hora})` : ""}`;
}

/**
 * Usa o atraso informado pela Unitrac (atraso_min), nao o atraso efetivo: se a
 * Central parar de gravar, o atraso efetivo de TODA a frota cresce junto e
 * viraria um card por carro. Esse caso e' do watchdog.
 */
export function planejarCardsSemSinal(p: {
  cargas: CargaSemSinal[];
  existentes: AlertaSemSinalExistente[];
  hoje: string;
  agora: Date;
}): { inserir: CargaSemSinal[]; resolver: { id: string; contexto: Record<string, unknown> }[] } {
  const validas = p.cargas.filter((c) => typeof c.veiculo_id === "string" && Number(c.nfs) > 0 && c.tem_posicao);
  const clientesVivos = new Set(
    validas.filter((c) => idadeMin(c.updated_at, p.agora) < LIMIAR_CLIENTE_VIVO_MIN).map((c) => c.cliente_id),
  );
  const abertos = p.existentes.filter((a) => a.status === "ativo" || a.status === "reconhecido");
  const abertoPorVeiculo = new Map(abertos.filter((a) => dataSP(new Date(a.desde)) === p.hoje).map((a) => [a.veiculo_id, a]));
  const inserir: CargaSemSinal[] = [];
  const resolver: { id: string; contexto: Record<string, unknown> }[] = [];

  for (const a of abertos) {
    if (dataSP(new Date(a.desde)) !== p.hoje) resolver.push({ id: a.id, contexto: { ...(a.contexto ?? {}), auto_resolvido: true, auto_expirado: true } });
  }
  for (const c of validas) {
    const aberto = abertoPorVeiculo.get(c.veiculo_id);
    const atraso = c.atraso_min == null ? null : Number(c.atraso_min);
    if (aberto) {
      if (atraso != null && atraso < LIMIAR_SEM_SINAL_MIN && idadeMin(c.updated_at, p.agora) < LIMIAR_SEM_SINAL_MIN) {
        const km = aberto.lat != null && aberto.lng != null && c.lat != null && c.lng != null
          ? distKm(aberto.lat, aberto.lng, c.lat, c.lng)
          : null;
        resolver.push({
          id: aberto.id,
          contexto: {
            ...(aberto.contexto ?? {}),
            auto_resolvido: true,
            voltou_em: p.agora.toISOString(),
            voltou_lat: c.lat,
            voltou_lng: c.lng,
            voltou_km: km == null ? null : Math.round(km * 10) / 10,
            voltou: km == null ? "sinal voltou" : textoVoltouSinal(km),
          },
        });
      }
      continue;
    }
    if (!clientesVivos.has(c.cliente_id)) continue;
    if (planejarSemSinal({ atrasoMin: atraso, temCargaHoje: true, naBase: c.na_base === true }) === "abrir") inserir.push(c);
  }
  return { inserir, resolver };
}
