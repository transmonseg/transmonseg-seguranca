// Regras visuais do card de alerta da lateral (26/09, redesign estilo Apple).
//
// Antes todo card mostrava Focar/Correto/Falso o tempo todo: com 20+ alertas
// a lateral virava uma parede de botoes. Agora o clique no card inteiro foca
// (substitui o Focar) e Correto/Falso so aparecem no card ATIVO (operador que
// navega sem mouse ainda ve as acoes), em HOVER ou com foco dentro do card.
// Hover/foco sao CSS puro (.card-alerta em globals.css): em estado React cada
// mouseenter re-renderizava o MonitorV2 inteiro, mapas inclusive. Esta funcao
// decide so o que PRENDE as acoes visiveis (atributo data-acoes="on"): card
// ativo, ou menu de motivo do Falso aberto -- sem isso, ao tirar o mouse do
// card pra escolher o motivo no popover, o botao Falso sumia e o menu
// desmontava junto.

export function acoesVisiveis(p: { ativo: boolean; menuFalsoAberto: boolean }): boolean {
  return p.ativo || p.menuFalsoAberto;
}

// Cor de status por nivel: faixa lateral, bolinha e tipo do card.
export function corStatus(nivel: string, T: { red: string; yellow: string; muted: string }): string {
  if (nivel === "critico") return T.red;
  if (nivel === "atencao") return T.yellow;
  return T.muted;
}
