// Confirmacao de classe viaria (queda de via principal/intermediaria pra
// rua estreita) como sinal de CORROBORACAO do desvio -- nunca supressao.
// Ver docs/superpowers/specs/2026-08-15-classe-viaria-corroboracao-design.md.
// So aplica bonus/sufixo a um alerta que JA existe -- nunca decide se um
// alerta dispara. Taxonomia e regra de queda portadas do sistema antigo
// (src/lib/classificacao-viaria.ts, removido no commit 6643bee/
// f695308..492f140, 12/08) -- o gate de "prova de entrega" (D1/D3 do
// antigo placar de desvio) foi deliberadamente descartado, decisao
// documentada no spec: a corroboracao ja roda atras do gate de chegada do
// afastando_geral, que cobre o caso mais comum que aquele gate evitava.

export type ClasseViaria = "principal" | "intermediaria" | "estreita";

const PRIORIDADE_CLASSE: Record<ClasseViaria, number> = {
  principal: 3,
  intermediaria: 2,
  estreita: 1,
};

// Celula pode ser cruzada por vias de classes diferentes -- vence a de
// maior prioridade (mesma logica do sistema antigo, portada sem mudanca).
export function melhorClasse(a: ClasseViaria | null, b: ClasseViaria | null): ClasseViaria | null {
  if (a === null) return b;
  if (b === null) return a;
  return PRIORIDADE_CLASSE[a] >= PRIORIDADE_CLASSE[b] ? a : b;
}

const JANELA_QUEDA_CLASSE_MIN = 10;

// classeAtual/ultimaViaPrincipalEm ja vem calculados por quem chama (route.ts) --
// esta funcao so aplica a janela de tempo, pura, sem I/O.
export function avaliarQuedaClasseViaria(
  classeAtual: ClasseViaria | null,
  ultimaViaPrincipalEm: Date | null,
  agora: Date
): { quedaDetectada: boolean } {
  if (classeAtual !== "estreita" || ultimaViaPrincipalEm === null) {
    return { quedaDetectada: false };
  }
  const decorridoMin = (agora.getTime() - ultimaViaPrincipalEm.getTime()) / 60_000;
  return { quedaDetectada: decorridoMin <= JANELA_QUEDA_CLASSE_MIN };
}

// Achado real 28/07 (sistema antigo, Task 6 -- revisao manual de FP de rua
// estreita): 36% dos falsos positivos eram o veiculo saindo de uma parada
// de entrega LEGITIMA (dwell confirmado) e pegando uma rua estreita logo
// em seguida. Janela mais curta que a de via principal (5min vs 10min) --
// a manobra tipica (sair do raio, virar numa rua estreita) e rapida.
const JANELA_SAIDA_PARADA_MIN = 5;

export function avaliarSaiuParadaConfirmadaRecentemente(
  saiuParadaConfirmadaEm: Date | null,
  agora: Date
): boolean {
  if (saiuParadaConfirmadaEm === null) return false;
  const decorridoMin = (agora.getTime() - saiuParadaConfirmadaEm.getTime()) / 60_000;
  return decorridoMin <= JANELA_SAIDA_PARADA_MIN;
}

// Mesmo padrao de aplicarCorroboracaoCorredor (corredor-confirmacao.ts,
// 14/08) -- extraida como funcao pura testavel isoladamente pra garantir
// (spec, secao Testes): nunca muta o alerta quando nao corrobora, sempre
// preserva os demais campos, nunca passa de 100.
export function aplicarCorroboracaoClasseViaria<T extends { score: number; motivo: string }>(
  alerta: T,
  quedaDetectada: boolean,
  saiuParadaConfirmadaRecentemente: boolean,
  bonus: number
): T {
  if (!quedaDetectada || saiuParadaConfirmadaRecentemente) return alerta;
  return {
    ...alerta,
    score: Math.min(100, alerta.score + bonus),
    motivo: `${alerta.motivo} (corroborado por: saiu de via principal para rua estreita)`,
  };
}
