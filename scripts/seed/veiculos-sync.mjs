// Logica da sincronizacao de veiculos Unitrac -> tabela `veiculos` (02_veiculos.mjs).
// 09/10 (RQO9H37): a Unitrac renomeou o cv ativo 24343 para RQO-9H37 mas um cadastro
// INATIVO (cv 24138) ainda segurava esse nome (UNIQUE(placa)); o UPDATE falhava com
// "duplicate key ... veiculos_placa_key", o script abortava e o monitoramento ficou
// com a placa velha ate' o KPI achar o caminhao "parado" (45 NFs fora da taxa). Agora:
// conflito com cadastro INATIVO de outro cv -> renomeia o inativo e segue; conflito
// com cadastro ATIVO -> erro claro (nunca mexe em veiculo em uso).

const INSERIR = `
  INSERT INTO veiculos (cliente_id, cv, placa, grupo, perfil, ativo)
  VALUES ($1, $2, $3, $4, 'auto', true)
  ON CONFLICT (cliente_id, cv) DO UPDATE SET placa = EXCLUDED.placa
  WHERE veiculos.placa IS DISTINCT FROM EXCLUDED.placa
  RETURNING id, (xmax = 0) AS foi_insercao`;

/** @returns {Promise<"inserido"|"atualizado"|"igual"|"atualizado_renomeando_inativo">} */
export async function sincronizarVeiculo(client, { clienteId, cv, placa, grupo }) {
  const tentar = async () => {
    const r = await client.query(INSERIR, [clienteId, cv, placa, grupo]);
    if (r.rows.length === 0) return "igual";
    return r.rows[0].foi_insercao ? "inserido" : "atualizado";
  };
  try {
    return await tentar();
  } catch (e) {
    if (!(e && e.code === "23505" && /veiculos_placa_key/.test(`${e.constraint ?? ""} ${e.message ?? ""}`))) throw e;
    const { rows } = await client.query("SELECT id, cv, ativo FROM veiculos WHERE placa = $1", [placa]);
    const dono = rows.find((r) => String(r.cv) !== String(cv));
    if (!dono) throw e;
    if (dono.ativo) throw new Error(`placa ${placa} ja' esta' com o cv ${dono.cv} (ativo) -- conferir cadastro (cv ${cv} quer o mesmo nome)`);
    await client.query("UPDATE veiculos SET placa = $1 WHERE id = $2", [`${placa}-INATIVO-CV${dono.cv}`, dono.id]);
    const r = await tentar();
    return r === "igual" ? "igual" : "atualizado_renomeando_inativo";
  }
}
