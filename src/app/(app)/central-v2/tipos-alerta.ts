// Listas de TIPO de alerta que governam o comportamento da Central v2.
//
// Por que num módulo próprio (revisão final de branch, 27/08, achado M1):
// MonitorV2.tsx é um componente gigante de default export, sem suíte de
// componente/RTL no repo -- a suíte (MonitorV2.test.ts) sempre reimplementou
// as constantes por cópia, e cópia não quebra quando o original muda. Aqui as
// duas pontas leem a MESMA fonte: mudou a lista, o teste vê.

// Filtro da aba "DESVIOS" (task A1, 27/08). Aba fixa, existe pra qualquer
// cliente -- antes dependia de o cliente estar mapeado num Record
// (LABEL_FOCO_POR_CLIENTE/TIPOS_NOTIFICAM_POR_CLIENTE) e cliente novo perdia a
// aba em silêncio. Pedido explícito do cliente no grupo (26/08): desvio +
// parada anômala juntos numa aba que sempre existe. parada_fora_tapete e
// parada_sem_marcacao NÃO entram (continuam visíveis só em "TUDO").
export const TIPOS_ABA_DESVIOS = ["desvio", "parada_anomala"];

// Tipos que NUNCA entram em "Resolver todos"/mass-resolve -- exigem clique
// individual (Correto/Falso) no card.
//
// Dois motivos, ambos vindos de dado real:
//
// 1. Qualidade de calibração (achado 20/08, varredura de origem_acao): 29 dos
//    35 "corretos" de desvio marcados num dia real vieram de clique em
//    "Resolver todos" (lote), só 6 de revisão individual de verdade -- sinal
//    fraco pra calibrar o tipo que é o motivo do produto existir.
//
// 2. Cooldown de re-disparo (revisão final de branch, 27/08, achado I2 -- foi
//    o que trouxe parada_anomala/parada_longa pra esta lista). O cooldown por
//    episódio de parada nos dois motores só reconhece
//    origem_acao ∈ {resolver_individual, falso_individual}
//    (ORIGENS_TRATAMENTO_INDIVIDUAL, motor-romaneio/route.ts e motor/route.ts).
//    "Resolver todos"/"Limpar todos" gravam resolver_massa/limpar_massa, que o
//    cooldown não reconhece -- resolver em massa não impedia o alerta de voltar
//    no ciclo seguinte (30s), reabrindo exatamente o padrão de flood que o
//    cooldown existe pra evitar (caso real TUG-9D18: 17 alertas em 2h).
//
// "Limpar avisos" continua valendo pra todos eles -- não afirma revisão caso a
// caso, não alimenta calibração, e o card sai da tela do mesmo jeito.
export const TIPOS_REVISAO_INDIVIDUAL = new Set([
  "desvio",
  "parada_fora_tapete",
  "parada_anomala",
  "parada_longa",
]);
