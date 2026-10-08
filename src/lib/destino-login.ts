// Depois do login, volta pra tela que a pessoa pediu (05/10: dentro da
// Central Transmonseg o monitoramento abre direto numa tela, ex. /escala).
// Só caminho interno -- nunca outro site nem o próprio /login.
export function destinoAposLogin(volta: string | null | undefined): string {
  if (!volta || !volta.startsWith("/") || volta.startsWith("//") || volta.includes("\\")) return "/";
  // 08/10 (revisao do login unico): o navegador descarta TAB/CR/LF da URL --
  // "/\t/evil.com" virava "//evil.com". Nenhum caractere de controle ou espaco.
  if (/[\x00-\x20\x7f]/.test(volta)) return "/";
  if (volta === "/login" || volta.startsWith("/login?")) return "/";
  return volta;
}
