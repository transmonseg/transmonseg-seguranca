// Troca de carro do dia (F1-05, ING-01/MON-02/DR-19).
//
// O KPI manda placaDe SEM hifen ("RQO5E38", normalizarPlacaDigitada) e o
// upload grava COM hifen ("RQO-5E38", normalizarPlaca). Quando a placa do
// documento nao esta no cadastro, a rota antiga filtrava
// .in("placa", ["RQO5E38"]), nao casava nada e respondia ok:true pontos:0 --
// 4 trocas (15, 21, 22, 23/10) deixaram o pao do carro 16 sem veiculo e o
// motor vigiou o carro errado. O PostgREST nao aplica regexp no .in, entao a
// troca roda direto no Postgres, em transacao, casando pela placa compacta.
import { variantesOZero, resolverPlacaNoCadastro } from "./romaneio";

/** Placa so' com A-Z0-9 (mesma conta do regexp_replace usado no SQL). */
export function compactarPlaca(placa: string): string {
  return placa.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Grafias compactas que contam como "o carro de origem" no romaneio do dia:
 * a propria placa, o carro do cadastro que ela resolve (exata ou unica
 * variante O/0) e as variantes O/0 que NAO sao outro carro do cadastro (o
 * documento troca letra O e zero: RQ0-9H37 x RQO-9H37). Nunca inclui a placa
 * de destino. Variante que e' outro carro cadastrado fica de fora (nao chuta).
 */
export function placasOrigemCompactas(placaDe: string, cadastroCompacto: Set<string>, placaParaCompacta: string): string[] {
  const base = compactarPlaca(placaDe);
  const resolvida = resolverPlacaNoCadastro(base, cadastroCompacto);
  const out = new Set<string>([base]);
  if (resolvida) out.add(resolvida);
  for (const v of variantesOZero(base)) {
    if (!cadastroCompacto.has(v) || v === resolvida) out.add(v);
  }
  out.delete(placaParaCompacta);
  return [...out];
}

export type ClienteSql = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type ResultadoTroca = {
  /** Linhas que passaram para o carro de destino. */
  movidos: number;
  /** NFs que ja estavam no carro de destino: a linha duplicada da origem saiu. */
  jaNoDestino: number;
  /** Desvios ativos do carro antigo, daquele dia, fechados pela troca. */
  desviosFechados: number;
};

/**
 * Executa a troca numa transacao so'. Sem nenhuma linha de origem, faz
 * ROLLBACK e devolve zeros (a rota transforma isso em ok:false quando havia
 * NFs). Qualquer erro faz ROLLBACK e sobe -- nunca deixa troca pela metade.
 */
export async function executarTrocaVeiculo(
  cliente: ClienteSql,
  args: {
    data: string;
    origens: string[];
    nfs: string[] | null;
    para: { id: string; placa: string };
    /** Veiculos do cadastro que casam com a placa de origem (podem nao ter linha no dia). */
    veiculosOrigemCadastro?: string[];
  },
): Promise<ResultadoTroca> {
  const { data, origens, nfs, para } = args;
  await cliente.query("BEGIN");
  try {
    const { rows } = await cliente.query(
      `SELECT id, veiculo_id FROM romaneio_pontos
        WHERE romaneio_data = $1::date
          AND regexp_replace(upper(placa), '[^A-Z0-9]', '', 'g') = ANY($2::text[])
          AND ($3::text[] IS NULL OR nf = ANY($3::text[]))
        FOR UPDATE`,
      [data, origens, nfs],
    );
    const origem = rows as { id: string; veiculo_id: string | null }[];
    if (origem.length === 0) {
      await cliente.query("ROLLBACK");
      return { movidos: 0, jaNoDestino: 0, desviosFechados: 0 };
    }

    // Colisao (DR-19): a unique (romaneio_data, placa, nf, modo_teste, origem)
    // derrubava o UPDATE inteiro quando o destino ja tinha a NF. A NF ja esta
    // no carro certo, entao a linha da origem e' a duplicata que sai.
    const ids = origem.map((o) => o.id);
    const { rows: removidas } = await cliente.query(
      `DELETE FROM romaneio_pontos o
         USING romaneio_pontos d
        WHERE o.id = ANY($1::uuid[])
          AND d.id <> o.id
          AND d.romaneio_data = o.romaneio_data
          AND d.placa = $2
          AND d.nf = o.nf
          AND d.modo_teste = o.modo_teste
          AND d.origem IS NOT DISTINCT FROM o.origem
        RETURNING o.id`,
      [ids, para.placa],
    );
    const removidasIds = new Set((removidas as { id: string }[]).map((r) => r.id));
    const restantes = ids.filter((id) => !removidasIds.has(id));

    let movidos = 0;
    if (restantes.length > 0) {
      const { rows: atualizadas } = await cliente.query(
        `UPDATE romaneio_pontos SET veiculo_id = $2, placa = $3
          WHERE id = ANY($1::uuid[])
          RETURNING id`,
        [restantes, para.id, para.placa],
      );
      movidos = atualizadas.length;
    }

    // Desvio do carro antigo foi calculado contra as entregas erradas: fecha
    // o ATIVO daquele dia como acao da maquina (auto_resolvido -- nao conta
    // como rotulo humano nem liga cooldown, entao o motor reabre no proximo
    // ciclo se o carro antigo seguir desviando das entregas que sobraram).
    const veiculosAntigos = [...new Set([
      ...(args.veiculosOrigemCadastro ?? []),
      ...origem.map((o) => o.veiculo_id).filter((v): v is string => !!v),
    ])].filter((v) => v !== para.id);
    let desviosFechados = 0;
    if (veiculosAntigos.length > 0) {
      const { rows: fechados } = await cliente.query(
        `UPDATE alertas_romaneio
            SET status = 'resolvido', resolvido_em = now(),
                contexto = COALESCE(contexto, '{}'::jsonb)
                  || jsonb_build_object('auto_resolvido', true, 'troca_veiculo', jsonb_build_object('para', $3::text, 'data', $2::text))
          WHERE veiculo_id = ANY($1::uuid[])
            AND tipo = 'desvio'
            AND status = 'ativo'
            AND (desde AT TIME ZONE 'America/Sao_Paulo')::date = $2::date
          RETURNING id`,
        [veiculosAntigos, data, para.placa],
      );
      desviosFechados = fechados.length;
    }

    await cliente.query("COMMIT");
    return { movidos, jaNoDestino: removidasIds.size, desviosFechados };
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
