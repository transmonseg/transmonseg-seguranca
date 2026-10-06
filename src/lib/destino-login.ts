// Depois do login, volta pra tela que a pessoa pediu (05/10: dentro da
// Central Transmonseg o monitoramento abre direto numa tela, ex. /escala).
// Só caminho interno -- nunca outro site nem o próprio /login.
export function destinoAposLogin(volta: string | null | undefined): string {
  if (!volta || !volta.startsWith("/") || volta.startsWith("//") || volta.includes("\\")) return "/";
  if (volta === "/login" || volta.startsWith("/login?")) return "/";
  return volta;
}
