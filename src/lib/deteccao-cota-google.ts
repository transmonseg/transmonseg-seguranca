// Ver spec docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md,
// Decisao 2. Google nao tem evento oficial pra "cota estourou" (gm_authFailure
// so' dispara pra falha de autenticacao) -- deteccao real via texto de erro
// conhecido, achado ao vivo no incidente de 08/09 (ver console do navegador
// em producao naquele dia): "Maps Demo Key limit reached...".

// Termos que, sozinhos, ja' sao inequivocamente do Google Maps -- nenhum
// outro subsistema do app emite essas strings.
const PADRAO_ERRO_COTA_ESPECIFICO =
  /demo key limit reached|billingnotenabledmaperror|apinotactivatedmaperror/i;

// "quota" sozinho e' generico demais: `QuotaExceededError` nativo do
// navegador (localStorage cheio, modo privado do Safari, disco cheio) e
// mensagens de outros subsistemas (ex. src/lib/roubocarga.ts) contem esse
// termo e nao tem NADA a ver com o mapa. Como instalarDetectorCotaGoogle
// substitui o console.error do app INTEIRO enquanto o mapa da Central esta
// montado (ou seja, praticamente sempre), um match generico jogaria TODOS
// os operadores pro modo fallback por >=20min por um erro nao-relacionado.
// Por isso o termo generico so' conta quando ha' um co-sinal do Google no
// MESMO texto.
const PADRAO_ERRO_COTA_GENERICO = /quota/i;
const PADRAO_COSINAL_GOOGLE = /google|maps? ?javascript|gm_/i;

export function matchErroCotaGoogle(texto: string): boolean {
  if (!texto) return false;
  if (PADRAO_ERRO_COTA_ESPECIFICO.test(texto)) return true;
  return PADRAO_ERRO_COTA_GENERICO.test(texto) && PADRAO_COSINAL_GOOGLE.test(texto);
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
