// De onde veio um lote de romaneio_pontos: o romaneio principal do dia ou a
// escala do Pao. Ate 23/08 os dois eram indistinguiveis no banco (mesmo
// endpoint, mesmas colunas) -- ver migration 059. Esta e' a unica lista de
// valores validos; API e telas importam daqui pra nunca divergirem do CHECK
// da migration.
export const ORIGENS_ROMANEIO = ["romaneio", "escala_pao"] as const;

export type OrigemRomaneio = (typeof ORIGENS_ROMANEIO)[number];

// Sem origem informada, assume romaneio principal -- e' o comportamento de
// antes da coluna existir (todo upload era "o romaneio") e mantem qualquer
// chamada antiga da API funcionando igual.
export const ORIGEM_PADRAO: OrigemRomaneio = "romaneio";

// A origem chega num campo de FormData/JSON, ou seja, vem do cliente.
// Nunca gravar a string crua: qualquer coisa fora da allowlist volta pro
// padrao em vez de ir pro banco.
export function normalizarOrigem(valor: unknown): OrigemRomaneio {
  return ORIGENS_ROMANEIO.includes(valor as OrigemRomaneio)
    ? (valor as OrigemRomaneio)
    : ORIGEM_PADRAO;
}

// Rotulo de tela. Fica junto da lista de valores de proposito: se um dia
// entrar uma origem nova, o compilador cobra o rotulo dela aqui.
export const ROTULO_ORIGEM: Record<OrigemRomaneio, string> = {
  romaneio: "Romaneio",
  escala_pao: "Escala do Pão",
};
