// Frescor real da posicao (F1-15, AC-01).
//
// posicoes_atuais.atraso_min e' o atraso que a Unitrac informou na ULTIMA
// leitura gravada. Se o motor para de gravar o veiculo (cliente desativado --
// Benassi desde 06/10, 223 posicoes com atraso 1-16 --, ou carro que saiu da
// API -- TTJ-0F00, TTP-0H36, TTI-6D27, TTT-1E20), o numero congela baixo e o
// carro parece fresco para sempre: 1 alerta de favela a cada 30 s por carro
// (28.400 em 24 h). O frescor passa a ser max(atraso_min, idade do
// updated_at), relogio do Postgres na gravacao. Nunca datagps (3 h deslocado).
//
// Efeito no desvio: nenhum carro com leitura nova muda (updated_at de quem a
// API devolve tem segundos); so' carro congelado deixa de ser "fresco", e
// esse ja' era barrado pela idempotencia por datagps.

/** max(atraso_min, minutos desde updated_at). atraso_min nulo => nulo. */
export function atrasoEfetivoMin(
  atrasoMin: number | null | undefined,
  updatedAt: string | Date | null | undefined,
  agora: Date,
): number | null {
  if (atrasoMin == null) return null;
  if (updatedAt == null) return atrasoMin;
  const t = (updatedAt instanceof Date ? updatedAt : new Date(updatedAt)).getTime();
  if (!Number.isFinite(t)) return atrasoMin;
  const idadeMin = (agora.getTime() - t) / 60_000;
  return Math.max(atrasoMin, idadeMin);
}

/** Mesma conta em SQL, para a posicao com alias `a` (posicoes_atuais). */
export function sqlAtrasoEfetivo(a: string): string {
  return `(CASE WHEN ${a}.atraso_min IS NULL THEN NULL ELSE GREATEST(${a}.atraso_min::float8, EXTRACT(EPOCH FROM (now() - ${a}.updated_at)) / 60.0) END)`;
}

// Detector de favela da Central (motor/route.ts, passo 7). So' cliente ativo:
// o dedupe de alerta ativo so' olha clientesComSucesso, entao um cliente que
// o motor nao processa (Benassi) ganhava um INSERT novo a cada ciclo.
export const SQL_VEICULOS_EM_FAVELA = `SELECT
             p.veiculo_id,
             v.cliente_id,
             p.lat,
             p.lng,
             COALESCE(p.velocidade, 0) AS velocidade,
             COALESCE(p.panico, false) AS panico,
             g.nome AS nome_favela,
             ST_AsGeoJSON(g.geom::geometry)::json AS geofence_geojson
           FROM posicoes_atuais p
           JOIN veiculos v ON v.id = p.veiculo_id
           JOIN clientes c ON c.id = v.cliente_id AND c.ativo
           JOIN geofences g
             ON g.tipo = 'favela'
             AND ST_Intersects(g.geom, p.geom)
           WHERE ${sqlAtrasoEfetivo("p")} <= 60`;

/**
 * Revisao F1-15 (R3): so' entram no detector de favela os carros de cliente
 * que o motor processou NESTE ciclo. O dedupe (alertas ativos) e' lido so'
 * de clientesComSucesso; cliente ativo cuja busca na Unitrac falhou ficava
 * fora dele e ganhava um alerta 'favela' novo a cada ciclo. Mesma regra do
 * dedupe vale para o insert.
 */
export function veiculosFavelaDoCiclo<T extends { cliente_id: string }>(
  linhas: T[],
  clientesComSucesso: ReadonlySet<string>,
): T[] {
  return linhas.filter((l) => clientesComSucesso.has(l.cliente_id));
}

// romaneio_ausente (motor-romaneio/route.ts, sinalizarRomaneioAusente).
// $1 = cod_user_unitrac[], $2 = limiar de frescor (min), $3 = dia (SP).
export const SQL_VEICULOS_SEM_ROMANEIO = `SELECT v.id AS veiculo_id, v.cliente_id, pa.lat, pa.lng
         FROM veiculos v
         JOIN clientes c ON c.id = v.cliente_id AND c.ativo
         JOIN posicoes_atuais pa ON pa.veiculo_id = v.id
         LEFT JOIN romaneio_pontos rp ON rp.veiculo_id = v.id AND rp.romaneio_data = $3::date
        WHERE c.cod_user_unitrac = ANY($1::text[])
          AND ${sqlAtrasoEfetivo("pa")} < $2
          AND rp.id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM bases b
             WHERE b.cliente_id = v.cliente_id AND ST_Contains(b.geom::geometry, pa.geom::geometry)
          )`;
