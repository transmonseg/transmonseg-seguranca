// RAS-05 (auditoria 03/11): guarda de ordem no upsert de posicoes_atuais.
// Leitura com datagps MENOR que o gravado não sobrescreve (mensagem velha que
// chegou depois de uma nova). Hoje o datagps é gravado com -3 h em todas as
// linhas (frente H), mas a comparação é entre valores com o mesmo erro.
// Três escapes, para nunca travar um carro:
//   - datagps nulo de qualquer lado;
//   - marco gravado implausível: datagps >= updated_at da própria linha (o
//     fallback "?? agora" grava a hora da gravação; leitura real é sempre
//     anterior à gravação);
//   - linha sem atualizar há mais de 30 min (relógio do aparelho errado).
export const SQL_GUARDA_ORDEM_DATAGPS = `(
             posicoes_atuais.datagps IS NULL
             OR EXCLUDED.datagps IS NULL
             OR posicoes_atuais.datagps >= posicoes_atuais.updated_at
             OR posicoes_atuais.updated_at < EXCLUDED.updated_at - interval '30 minutes'
             OR EXCLUDED.datagps >= posicoes_atuais.datagps
           )`;

type Linha = { datagps: Date | null; updated_at: Date };

/** Mesma regra em JS (teste e documentação). */
export function aceitaLeitura(gravada: Linha, nova: Linha): boolean {
  if (gravada.datagps == null || nova.datagps == null) return true;
  if (gravada.datagps.getTime() >= gravada.updated_at.getTime()) return true;
  if (gravada.updated_at.getTime() < nova.updated_at.getTime() - 30 * 60_000) return true;
  return nova.datagps.getTime() >= gravada.datagps.getTime();
}
