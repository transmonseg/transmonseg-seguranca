// R-F3-12-01: sem pedido explícito, o login cai na Central Romaneio -- a
// Central Unitrac ('/', página de 76 MB) fica na engrenagem e só abre quando
// alguém pede '/'. Todas as contas de hoje são central, Nutry ou RQ (24/10:
// 9 central, 2 Nutry, 1 RQ), clientes que rodam o motor-romaneio.
export const DESTINO_PADRAO_APOS_LOGIN = "/central-romaneio";

// Depois do login, volta pra tela que a pessoa pediu (05/10: dentro da
// Central Transmonseg o monitoramento abre direto numa tela, ex. /escala).
// Só caminho interno -- nunca outro site nem o próprio /login.
export function destinoAposLogin(volta: string | null | undefined): string {
  if (!volta || !volta.startsWith("/") || volta.startsWith("//") || volta.includes("\\")) return DESTINO_PADRAO_APOS_LOGIN;
  // 08/10 (revisao do login unico): o navegador descarta TAB/CR/LF da URL --
  // "/\t/evil.com" virava "//evil.com". Nenhum caractere de controle ou espaco.
  if (/[\x00-\x20\x7f]/.test(volta)) return DESTINO_PADRAO_APOS_LOGIN;
  if (volta === "/login" || volta.startsWith("/login?")) return DESTINO_PADRAO_APOS_LOGIN;
  return volta;
}
