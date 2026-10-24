// src/lib/romaneio-rioquality.ts
//
// Romaneio da Rio Quality vindo do KPI (POST /api/romaneio/rioquality).
// Funcoes PURAS: leitura das linhas, endereco no formato do parser e o plano
// de reconciliacao do dia (o que inserir, atualizar e apagar).
//
// Plano mestre 23/10:
// - F2-02 (GEO-21): o KPI juntava "RUA, CIDADE - RJ" e o parser lia a cidade
//   como numero ("RUA DOUTOR SOUZA NUNES, VALENCA - RJ" -> num "VALENCA",
//   cidade null; "AVENIDA SERGIPE, RESENDE - RJ" caiu em Sergipe). Agora o
//   endereco sai "RUA, NUMERO - BAIRRO, CIDADE - UF", o mesmo texto que o KPI
//   geocodifica (montarEnderecoBrutoCompleto).
// - F2-04 (KRQ-03, MON-01, MON-10): o upload manual substitui a versao da
//   Fusion do dia. A NF e' a chave (nunca a placa): NF reatribuida pela Fusion
//   a outro carro troca a placa da linha (e so' entao zera a presenca), em vez
//   de ficar em 2 placas. O pedido ERP liga a NF real da planilha ao pedido da
//   Fusion (D-21b). So' pontos gravados por esta ponte (marca no enviado_por)
//   sao tocados, nunca pela origem nem pela frota (F2-REV-09).
import { normalizarPlaca } from "./romaneio";

/** cod_user_unitrac da Rio Quality (clientes). */
export const COD_UNITRAC_RQ = "598";
/** enviado_por das linhas gravadas por esta ponte antes de 24/10. */
export const ENVIADO_POR_RQ_ANTIGO = "cron-fusion (pelo Ao vivo do KPI)";
/** Sufixo do enviado_por das linhas da RQ (a Nutry usa "<email> (pelo Ao vivo do KPI)"). */
export const SUFIXO_ENVIADO_POR_RQ = "(Rio Quality pelo Ao vivo do KPI)";

export function enviadoPorRQ(quem: string | null | undefined): string {
  const q = (quem ?? "").trim().slice(0, 80) || "KPI Rio Quality";
  return `${q} ${SUFIXO_ENVIADO_POR_RQ}`;
}

export function ehEnviadoPorRQ(enviadoPor: string | null | undefined): boolean {
  if (!enviadoPor) return false;
  return enviadoPor === ENVIADO_POR_RQ_ANTIGO || enviadoPor.endsWith(SUFIXO_ENVIADO_POR_RQ);
}

export const compactarPlaca = (p: string | null | undefined) => (p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
}

/** "RUA, NUMERO - BAIRRO, CIDADE - UF" (numero e bairro podem ficar vazios),
 *  o formato que extrairNumero/Bairro/CidadeDoEndereco leem. Igual ao
 *  montarEnderecoBrutoCompleto do KPI quando nao ha numero. CEP (8 digitos)
 *  vai no fim, onde extrairCepDoEndereco procura. */
export function montarEnderecoRQ(c: { rua: string; numero?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null; cep?: string | null }): string {
  const t = (s: string | null | undefined) => (s ?? "").trim();
  const numero = t(c.numero);
  const cidadeUf = t(c.uf) ? `${t(c.cidade)} - ${t(c.uf)}` : t(c.cidade);
  const cep = t(c.cep).replace(/\D/g, "");
  return `${t(c.rua)}, ${numero ? `${numero} ` : ""}- ${t(c.bairro)}, ${cidadeUf}${cep.length === 8 ? ` - ${cep}` : ""}`;
}

export type LinhaRQ = {
  placa: string
  nf: string
  pedidoErp: string | null
  clienteCodigo: string | null
  clienteNome: string
  enderecoBruto: string
  /** Coordenada que o KPI ja' resolveu (fonte unica com o Ao vivo). */
  lat: number | null
  lng: number | null
};

const coordValida = (lat: unknown, lng: unknown): boolean =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= -34 && lat <= 6 && lng >= -75 && lng <= -28;

/** Linhas validas do corpo. Aceita o formato antigo (enderecoBruto pronto) e
 *  o estruturado (rua/numero/bairro/cidade/uf/cep), que tem preferencia. Sem
 *  placa ou NF a linha nao vira ponto (nf e' NOT NULL). NF repetida ganha
 *  sufixo "-2", "-3"... na ordem (mesma regra do KPI, montarLinhasRomaneioCompleto). */
export function lerLinhasRQ(brutas: unknown[]): LinhaRQ[] {
  const usadas = new Map<string, number>();
  const out: LinhaRQ[] = [];
  for (const b of brutas) {
    const l = (b ?? {}) as Record<string, unknown>;
    const placa = normalizarPlaca(str(l.placa) ?? "");
    const nfBruta = str(l.nf);
    if (!placa || !nfBruta) continue;
    const k = (usadas.get(nfBruta) ?? 0) + 1;
    usadas.set(nfBruta, k);
    const rua = str(l.rua);
    const enderecoBruto = rua
      ? montarEnderecoRQ({ rua, numero: str(l.numero), bairro: str(l.bairro), cidade: str(l.cidade), uf: str(l.uf), cep: str(l.cep) })
      : str(l.enderecoBruto) ?? "";
    const temCoord = coordValida(l.lat, l.lng);
    out.push({
      placa,
      nf: k === 1 ? nfBruta : `${nfBruta}-${k}`,
      pedidoErp: str(l.pedidoErp),
      clienteCodigo: str(l.clienteCodigo),
      clienteNome: str(l.clienteNome) ?? "",
      enderecoBruto,
      lat: temCoord ? (l.lat as number) : null,
      lng: temCoord ? (l.lng as number) : null,
    });
  }
  return out;
}

export type PontoRQ = {
  id: string
  placa: string
  nf: string
  pedido_erp?: string | null
  veiculo_id: string | null
  cliente_codigo: string | null
  cliente_nome: string
  endereco_bruto: string
  lat: number | null
  lng: number | null
  geocode_status: string
  presenca_confirmada_em: string | null
  enviado_por: string | null
  criado_em: string
};

/** Linha de romaneio_pontos que pertence a RQ: gravada por esta ponte (marca
 *  do enviado_por, a mesma do indice parcial da 089). Nunca decide pela origem
 *  (a Nutry tambem e' "romaneio").
 *  Revisao Fase 2 (F2-REV-09): o carro da frota da RQ deixou de bastar -- um
 *  ponto da Nutry com a placa caindo num veiculo da RQ era apagado pelo
 *  "substituir" a cada tick da Fusion. Conferido em producao (24/10, so'
 *  SELECT): 0 linhas da frota da RQ sem a marca da ponte (21.383 com a marca). */
export function ehPontoRQ(p: { veiculo_id: string | null; enviado_por: string | null }): boolean {
  return ehEnviadoPorRQ(p.enviado_por);
}

export type PlanoRQ = {
  inserir: Record<string, unknown>[]
  /** Objetos para upsert por id (cada um com as colunas que mudam + as NOT NULL). */
  atualizar: Record<string, unknown>[]
  apagar: string[]
};

const mesmaCoord = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 1e-7;

/** Escolhe a linha que fica entre as candidatas da mesma NF: o mesmo carro,
 *  depois a presenca confirmada, depois a ja' geocodificada, depois a mais nova. */
function escolherQueFica(cands: PontoRQ[], placa: string): PontoRQ {
  const p = compactarPlaca(placa);
  return [...cands].sort((a, b) =>
    Number(compactarPlaca(b.placa) === p) - Number(compactarPlaca(a.placa) === p)
    || Number(b.presenca_confirmada_em != null) - Number(a.presenca_confirmada_em != null)
    || Number(b.geocode_status === "ok") - Number(a.geocode_status === "ok")
    || (b.criado_em ?? "").localeCompare(a.criado_em ?? ""))[0];
}

/** Plano de reconciliacao do dia da RQ.
 *  - Cada linha recebida casa com as linhas existentes da mesma NF, ou do
 *    mesmo pedido ERP (a Fusion grava o pedido como NF; a planilha manual
 *    traz a NF real e o pedido). Fica uma; as outras (NF em 2 placas) saem.
 *  - Carro diferente: troca placa/veiculo e zera a presenca. Mesmo carro: a
 *    presenca fica.
 *  - Coordenada do KPI: grava e marca geocode ok. Sem ela, endereco mudou =>
 *    volta para a fila de geocode (o ponto velho era do endereco velho).
 *  - substituir: o que a RQ tinha no dia e nao veio sai. Sem substituir, so'
 *    as duplicatas da mesma NF saem.
 *  - Revisao Fase 2 (F2-REV-01): a NF exata casa primeiro, para TODAS as
 *    linhas; o pedido so' entra para a linha que nao achou a propria NF, e so'
 *    com o que sobrou. Pedido repetido entre as linhas recebidas (Fusion P e
 *    P-2; planilha com o pedido partido em N1 e N2) leva uma NF existente por
 *    linha. Antes a 1a linha juntava todas as do pedido: a presenca ia para a
 *    NF errada e as outras eram apagadas e reinseridas a cada envio. */
export function planejarDiaRQ(p: {
  data: string
  existentes: PontoRQ[]
  linhas: LinhaRQ[]
  substituir: boolean
  veiculoPorPlaca: Map<string, string>
  enviadoPor: string
  comPedidoErp: boolean
}): PlanoRQ {
  const porNf = new Map<string, PontoRQ[]>();
  const porPedido = new Map<string, PontoRQ[]>();
  const add = (m: Map<string, PontoRQ[]>, k: string | null | undefined, e: PontoRQ) => {
    if (!k) return;
    const l = m.get(k) ?? [];
    l.push(e);
    m.set(k, l);
  };
  for (const e of p.existentes) {
    add(porNf, e.nf, e);
    if (p.comPedidoErp) add(porPedido, e.pedido_erp, e);
  }
  const usados = new Set<string>();
  const plano: PlanoRQ = { inserir: [], atualizar: [], apagar: [] };

  // 1) NF exata, para todas as linhas (NF em 2 placas: todas da NF entram).
  const candsDa: PontoRQ[][] = p.linhas.map((l) => {
    const c = (porNf.get(l.nf) ?? []).filter((e) => !usados.has(e.id));
    for (const e of c) usados.add(e.id);
    return c;
  });
  // 2) Pedido, so' para quem nao achou a NF e so' com o que sobrou do passo 1.
  const semNfPorPedido = new Map<string, number[]>();
  p.linhas.forEach((l, i) => {
    if (candsDa[i].length === 0 && l.pedidoErp) {
      const v = semNfPorPedido.get(l.pedidoErp) ?? [];
      v.push(i);
      semNfPorPedido.set(l.pedidoErp, v);
    }
  });
  for (const [pedido, idx] of semNfPorPedido) {
    // Agrupadas pela NF existente (a mesma NF em 2 placas e' uma NF so').
    const grupos = new Map<string, PontoRQ[]>();
    for (const e of [...(porNf.get(pedido) ?? []), ...(porPedido.get(pedido) ?? [])]) {
      if (usados.has(e.id)) continue;
      const g = grupos.get(e.nf) ?? [];
      if (!g.some((x) => x.id === e.id)) g.push(e);
      grupos.set(e.nf, g);
    }
    if (idx.length === 1) {
      // Pedido unico entre as linhas sem NF: junta tudo (fica 1, regra de antes).
      const c = [...grupos.values()].flat();
      for (const e of c) usados.add(e.id);
      candsDa[idx[0]] = c;
      continue;
    }
    for (const i of idx) {
      if (grupos.size === 0) break;
      const melhor = escolherQueFica([...grupos.values()].flat(), p.linhas[i].placa);
      const c = grupos.get(melhor.nf)!;
      grupos.delete(melhor.nf);
      for (const e of c) usados.add(e.id);
      candsDa[i] = c;
    }
  }

  for (const [i, l] of p.linhas.entries()) {
    const cands = new Map<string, PontoRQ>(candsDa[i].map((e) => [e.id, e]));
    const veiculoId = p.veiculoPorPlaca.get(l.placa) ?? null;
    if (cands.size === 0) {
      plano.inserir.push({
        veiculo_id: veiculoId,
        placa: l.placa,
        romaneio_data: p.data,
        nf: l.nf,
        cliente_codigo: l.clienteCodigo,
        cliente_nome: l.clienteNome,
        endereco_bruto: l.enderecoBruto,
        carga_destino_codigo: null,
        carga_destino_nome: null,
        lat: l.lat,
        lng: l.lng,
        geocode_status: l.lat != null ? "ok" : "pendente",
        modo_teste: false,
        enviado_por: p.enviadoPor,
        origem: "romaneio",
        ...(p.comPedidoErp ? { pedido_erp: l.pedidoErp } : {}),
      });
      continue;
    }
    const fica = escolherQueFica([...cands.values()], l.placa);
    for (const c of cands.values()) {
      if (c.id !== fica.id) plano.apagar.push(c.id);
    }
    const trocouCarro = compactarPlaca(fica.placa) !== compactarPlaca(l.placa);
    const enderecoMudou = fica.endereco_bruto !== l.enderecoBruto;
    const coordNova = l.lat != null && l.lng != null && (!mesmaCoord(fica.lat, l.lat) || !mesmaCoord(fica.lng, l.lng) || fica.geocode_status !== "ok");
    const mudou = trocouCarro || enderecoMudou || coordNova
      || fica.nf !== l.nf
      || (fica.veiculo_id ?? null) !== veiculoId
      || (fica.cliente_codigo ?? null) !== l.clienteCodigo
      || fica.cliente_nome !== l.clienteNome
      || (p.comPedidoErp && (fica.pedido_erp ?? null) !== l.pedidoErp);
    if (!mudou) continue;
    plano.atualizar.push({
      id: fica.id,
      veiculo_id: veiculoId,
      placa: l.placa,
      romaneio_data: p.data,
      nf: l.nf,
      cliente_codigo: l.clienteCodigo,
      cliente_nome: l.clienteNome,
      endereco_bruto: l.enderecoBruto,
      enviado_por: p.enviadoPor,
      ...(p.comPedidoErp ? { pedido_erp: l.pedidoErp } : {}),
      ...(trocouCarro ? { presenca_confirmada_em: null } : {}),
      ...(coordNova
        ? { lat: l.lat, lng: l.lng, geocode_status: "ok" }
        : enderecoMudou && l.lat == null
          ? { lat: null, lng: null, geocode_status: "pendente", geocode_tentativas: 0, geocode_reivindicado_em: null, geocode_ultima_tentativa_em: null }
          : {}),
    });
  }
  if (p.substituir) {
    for (const e of p.existentes) if (!usados.has(e.id)) plano.apagar.push(e.id);
  }
  return plano;
}

/** Revisao Fase 2 (F2-04-a): o "substituir" apagava do dia toda linha da RQ
 *  que nao veio, sem trava. Envio vazio (planilha com as placas em branco) ou
 *  encolhido (resposta anomala da Fusion sem rows num romaneio) levava o dia
 *  inteiro, com a presenca, e a rota respondia ok. Mesma ideia do
 *  FRACAO_MINIMA_API de veiculos-ausentes.mjs: menos da metade das NFs que o
 *  dia ja' tem nao apaga nada (o envio ainda acrescenta e corrige). Conta NFs
 *  distintas: "NF em 2 placas" (antes da 089) nao infla o dia. Dia pequeno
 *  (< 20 NFs) so' recusa o envio vazio. null = pode substituir. */
export const FRACAO_MINIMA_SUBSTITUIR_RQ = 0.5;
export const MIN_NFS_PARA_FRACAO_RQ = 20;
export function motivoParaNaoSubstituirRQ(existentes: PontoRQ[], linhas: LinhaRQ[]): string | null {
  const nfsDoDia = new Set(existentes.map((e) => e.nf)).size;
  if (nfsDoDia === 0) return null;
  if (linhas.length === 0) {
    return `envio sem linhas: as ${nfsDoDia} NFs da RQ do dia nao foram apagadas`;
  }
  const nfsEnviadas = new Set(linhas.map((l) => l.nf)).size;
  if (nfsDoDia >= MIN_NFS_PARA_FRACAO_RQ && nfsEnviadas < nfsDoDia * FRACAO_MINIMA_SUBSTITUIR_RQ) {
    return `envio com ${nfsEnviadas} NFs, menos da metade das ${nfsDoDia} NFs da RQ ja' no dia: nada foi apagado (so' acrescentado/corrigido)`;
  }
  return null;
}

/** Agrupa objetos pelo conjunto de colunas (o upsert do PostgREST manda as
 *  mesmas colunas para todas as linhas do lote). */
export function agruparPorColunas(objs: Record<string, unknown>[]): Record<string, unknown>[][] {
  const grupos = new Map<string, Record<string, unknown>[]>();
  for (const o of objs) {
    const k = Object.keys(o).sort().join(",");
    const g = grupos.get(k) ?? [];
    g.push(o);
    grupos.set(k, g);
  }
  return [...grupos.values()];
}
