// Qual aba/item da navegacao esta ativo, dado o pathname atual.
//
// A armadilha que motivou virar funcao propria (e testavel): "/" e' prefixo
// de TODA rota. Um `pathname.startsWith(href)` ingenuo acende a aba Central
// junto com a Central Romaneio, com as duas destacadas ao mesmo tempo. Rota
// raiz e' igualdade exata; as outras aceitam sub-rota.
export function rotaAtiva(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
