// F2-15 (MON-12, plano mestre 23/10): veiculo que sai da API da Unitrac.
//
// A sincronizacao (02_veiculos.mjs) so' inseria/renomeava. O carro que saiu da
// API continuava ativo com a posicao congelada: o motor nao grava mais nada
// dele, e o atraso_min da ultima leitura fica para sempre -- TTT-1E20 aparecia
// "verde", atraso 0, desde 13/10 (24/10: TTJ-0F00, TTP-0H36, TTI-6D27,
// TUC-1D15 e TTT-1E20 fora da masn/4096).
//
// Agora, a cada sincronizacao, para cada ativo do cliente que nao veio na API:
//  - marca veiculos.sumiu_da_api_em (migration 090; antes dela so' pula);
//    quem volta para a API tem a marca limpa;
//  - envelhece a posicao: atraso_min = idade real (desde o ultimo dado
//    gravado pelo motor), nivel cinza e o motivo -- so' se o motor nao grava
//    o carro ha 30 min (nunca briga com o motor). updated_at fica como esta'
//    (a idade continua contando do ultimo dado real).
// Nunca desativa nem apaga veiculo. Resposta da API vazia ou com menos da
// metade da frota ativa = suspeita (falha parcial): nao mexe em nada.

export const FRACAO_MINIMA_API = 0.5;
export const MIN_SEM_GRAVACAO_PARA_ENVELHECER = 30;

/** @returns {{ ausentes: {id:string,cv:string,placa:string}[], suspeita: string|null }} */
export function ausentesDaApi(ativosDb, cvsApi) {
  if (cvsApi.size === 0) return { ausentes: [], suspeita: "API devolveu 0 veiculos" };
  const ausentes = ativosDb.filter((v) => !cvsApi.has(String(v.cv)));
  const presentes = ativosDb.length - ausentes.length;
  if (ativosDb.length > 0 && presentes / ativosDb.length < FRACAO_MINIMA_API) {
    return { ausentes: [], suspeita: `API devolveu so' ${presentes} de ${ativosDb.length} veiculos ativos do banco (resposta parcial?)` };
  }
  return { ausentes, suspeita: null };
}

async function temColunaSumiu(client) {
  const { rows } = await client.query(
    `SELECT 1 AS ok FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'veiculos' AND column_name = 'sumiu_da_api_em'`);
  return rows.length > 0;
}

/**
 * @param {{ query: Function }} client pg.Client
 * @param {{ clienteId: string, cvsApi: Set<string> }} opcoes
 * @returns {Promise<{ ausentes: string[], envelhecidos: number, marcado: boolean, suspeita: string|null }>}
 */
export async function tratarAusentesDaApi(client, { clienteId, cvsApi }) {
  const comColuna = await temColunaSumiu(client);
  const { rows: ativos } = await client.query(
    "SELECT id, cv, placa FROM veiculos WHERE cliente_id = $1 AND ativo", [clienteId]);
  const { ausentes, suspeita } = ausentesDaApi(ativos, cvsApi);
  if (suspeita) return { ausentes: [], envelhecidos: 0, marcado: false, suspeita };

  const ids = ausentes.map((v) => v.id);
  if (comColuna) {
    if (ids.length > 0) {
      await client.query(
        "UPDATE veiculos SET sumiu_da_api_em = now() WHERE id = ANY($1::uuid[]) AND sumiu_da_api_em IS NULL", [ids]);
    }
    await client.query(
      "UPDATE veiculos SET sumiu_da_api_em = NULL WHERE cliente_id = $1 AND sumiu_da_api_em IS NOT NULL AND cv = ANY($2::text[])",
      [clienteId, [...cvsApi]]);
  }
  let envelhecidos = 0;
  if (ids.length > 0) {
    const { rows } = await client.query(
      `UPDATE posicoes_atuais p
          SET atraso_min = GREATEST(COALESCE(p.atraso_min, 0), floor(EXTRACT(EPOCH FROM (now() - p.updated_at)) / 60)::int),
              nivel = 'cinza',
              motivo = 'Fora da API da Unitrac: sem posicao nova ha '
                       || GREATEST(COALESCE(p.atraso_min, 0), floor(EXTRACT(EPOCH FROM (now() - p.updated_at)) / 60)::int) || 'min'
        WHERE p.veiculo_id = ANY($1::uuid[])
          AND p.updated_at < now() - interval '${MIN_SEM_GRAVACAO_PARA_ENVELHECER} minutes'
        RETURNING p.veiculo_id`, [ids]);
    envelhecidos = rows.length;
  }
  return { ausentes: ausentes.map((v) => v.placa), envelhecidos, marcado: comColuna, suspeita: null };
}
