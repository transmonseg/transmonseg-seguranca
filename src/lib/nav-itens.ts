// Itens da navegação principal (NavPrincipal). Separados do componente para
// serem testáveis.
//
// Pedido do usuario 23/08: "melhor so' colocar duas opcoes la em cima: Central e
// Central Romaneio"; as outras telas viraram itens da engrenagem.
// F3-12 (AC-08, 24/10): o produto é a Central Romaneio (regra do dono "foco só
// Central Romaneio"). A Central Unitrac ("/", a página de 76 MB) sai das abas e
// vai para a engrenagem; nenhuma tela some.

export const ABAS = [
  { href: "/central-romaneio", rotulo: "Central Romaneio" },
] as const;

export const ITENS_MENU = [
  { href: "/", rotulo: "Central Unitrac" },
  { href: "/romaneio", rotulo: "Configurar Romaneio" },
  { href: "/escala", rotulo: "Escala" },
  { href: "/veiculos", rotulo: "Veículos" },
  { href: "/analise", rotulo: "Análise" },
] as const;
