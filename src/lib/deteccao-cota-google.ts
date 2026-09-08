// Ver spec docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md,
// Decisao 2. Google nao tem evento oficial pra "cota estourou" (gm_authFailure
// so' dispara pra falha de autenticacao) -- deteccao real via texto de erro
// conhecido, achado ao vivo no incidente de 08/09 (ver console do navegador
// em producao naquele dia): "Maps Demo Key limit reached...".

const PADRAO_ERRO_COTA = /demo key limit reached|billingnotenabledmaperror|apinotactivatedmaperror|quota/i;

export function matchErroCotaGoogle(texto: string): boolean {
  if (!texto) return false;
  return PADRAO_ERRO_COTA.test(texto);
}

export function instalarDetectorCotaGoogle(container: HTMLElement, onDetectado: () => void): () => void {
  let disparado = false;
  const disparar = () => {
    if (disparado) return;
    disparado = true;
    onDetectado();
  };

  const consoleErrorOriginal = console.error;
  console.error = (...args: unknown[]) => {
    const texto = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    if (matchErroCotaGoogle(texto)) disparar();
    consoleErrorOriginal(...args);
  };

  const observer = new MutationObserver(() => {
    if (matchErroCotaGoogle(container.textContent ?? "")) disparar();
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });

  return () => {
    console.error = consoleErrorOriginal;
    observer.disconnect();
  };
}
