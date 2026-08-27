// Calculo de delay pra entrada escalonada (stagger) de listas animadas
// via framer-motion — usado pelos cards de alerta em MonitorV2.tsx.
// Extraido do JSX pra ser testavel isoladamente.

/**
 * Delay de entrada (em segundos, pra usar direto em `transition.delay`
 * do framer-motion) pro item de indice `index` numa lista renderizada.
 *
 * Cresce linearmente por `passoSegundos` por posicao, com teto em
 * `tetoSegundos` pra listas grandes nao demorarem tempo demais pra
 * terminar de entrar.
 */
export function delayEntradaEscalonada(
  index: number,
  passoSegundos = 0.025,
  tetoSegundos = 0.3
): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index * passoSegundos, tetoSegundos);
}
