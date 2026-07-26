import { Agent, fetch as undiciFetch } from "undici";
import {
  CONTABO_CA_PEM,
  CONTABO_HOST,
  PINNED_FINGERPRINT_SHA256,
  calcularFingerprintSha256,
  verificarFingerprintPinado,
} from "./contabo-ca";

// Re-exportadas pra manter compatibilidade com quem ja importa essas 3
// funcoes/constantes puras daqui (ex.: fetch-contabo.test.ts) -- a
// implementacao real agora vive em `./contabo-ca` (fonte unica compartilhada
// com o pinning do `pg.Pool`/`pg.Client`, ver `sslContabo()` la).
export { PINNED_FINGERPRINT_SHA256, calcularFingerprintSha256, verificarFingerprintPinado };

// Certificado auto-assinado gerado no Contabo (Task 16,
// docs/plans/2026-07-25-migracao-contabo.md / task-16-report.md).
// PEM publico -- e literalmente enviado em claro em todo handshake TLS por
// qualquer cliente que conectar, entao nao ha problema nenhum em versionar.
// Usado como `ca` (autoridade confiavel) do undici: com `rejectUnauthorized`
// no default (true), o TLS so fecha handshake se o servidor apresentar
// EXATAMENTE este certificado (self-signed = e a propria raiz) -- isso E' o
// pinning de verdade, verificado pela cadeia real do TLS, nao um efeito
// colateral de desligar a validacao. Fonte unica em `./contabo-ca` -- tambem
// usada pelo pinning via `pg.Pool`/`pg.Client` (`sslContabo()`), nao
// duplicar esta string.
const PINNED_CERT_PEM = CONTABO_CA_PEM;

// IMPORTANTE (achado da Task 18): `checkServerIdentity` SO e' chamado pelo
// Node/undici quando `rejectUnauthorized` esta no default (true) -- com
// `rejectUnauthorized: false` (abordagem original da Task 17) o callback
// nunca roda, entao QUALQUER certificado era aceito silenciosamente e o
// "pinning" nao pinava nada. Confirmado empiricamente (handshake real contra
// o Contabo, dispatcher isolado por processo) antes desta correcao. Por
// isso o pinning real agora e' feito via `ca` (chain-of-trust padrao do
// TLS, `rejectUnauthorized` no default), com `checkServerIdentity` como
// camada extra que so faz sentido -- e so roda de verdade -- nesse modo.
//
// Extraida como factory (nao so o singleton `fetchContabo` abaixo) pra ser
// exercitada por teste de integracao TLS real contra um servidor
// `node:https` local (`fetch-contabo.transport.test.ts`, achado "Important"
// da revisao de codigo de 26/07) -- o teste passa um par de
// certificado/fingerprint FAKE, gerado so pra teste (nunca a chave privada
// real do Contabo, que so existe no VPS), exercitando o MESMO mecanismo
// (`undici.Agent` + `dispatcher` + `checkServerIdentity`) que roda em
// producao, nao uma reimplementacao paralela no teste.
//
// `host` (default `CONTABO_HOST`, mesma constante que `sslContabo()` usa em
// `contabo-ca.ts` -- fonte unica, nao duplicar) decide QUANDO o Agent pinado
// e' aplicado -- ver achado abaixo. O default cobre o uso real em producao
// (`fetchContabo`); o parametro so existe pra o teste de transporte poder
// exercitar a mesma logica contra o host de loopback do servidor de teste,
// sem precisar apontar pro IP real do Contabo.
export function criarFetchContabo(
  caPem: string,
  fingerprintEsperado: string,
  host: string = CONTABO_HOST
): typeof fetch {
  const agent = new Agent({
    connect: {
      ca: caPem,
      checkServerIdentity: (_hostname, cert) => verificarFingerprintPinado(cert, fingerprintEsperado),
    },
  });

  // Fetch customizado para os clientes @supabase/supabase-js e @supabase/ssr,
  // que falam HTTP puro (nao pg.Pool) com o Postgrest/GoTrue expostos no
  // Contabo atras de um certificado auto-assinado. Requisicoes nao-HTTPS
  // (ex.: em testes/dev local) passam direto pelo fetch nativo.
  //
  // Usa o `fetch` exportado pelo pacote `undici` (nao o `fetch` global do
  // Node): o global tambem e' undici por baixo dos panos, mas nao aceita a
  // opcao `dispatcher` de forma utilizavel a partir de fora do runtime (a
  // tentativa original com `agent` de `node:https` era silenciosamente
  // ignorada pelo fetch global -- outro achado da Task 18, e' por isso que o
  // fetch exportado do pacote precisa ser usado, para o `dispatcher`
  // realmente valer).
  //
  // IMPORTANTE (achado real, confirmado testando este `fetchContabo` contra o
  // dominio real do Supabase -- deu `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`): sem
  // a checagem de host abaixo, o `ca` pinado do Contabo virava a UNICA
  // autoridade confiavel do `Agent` pra QUALQUER URL https, substituindo a
  // cadeia de CAs publica padrao que o Supabase (ou qualquer outro host)
  // realmente usa. Isso quebrava o plano de rollback do projeto: reverter as
  // env vars da Vercel de volta pro Supabase, sem mudar codigo, travaria
  // login e qualquer chamada por `admin.ts`/`server.ts`/`proxy.ts` com erro
  // de certificado. Mesmo padrao simples que `sslContabo()` ja usa em
  // `contabo-ca.ts` (`connectionString.includes(CONTABO_HOST)`, em vez de
  // fazer parsing de URL -- o `url` aqui pode ser `string | URL | Request`, e
  // `Request.prototype.toString()` nao retorna a URL real): fora do Contabo,
  // cai no fetch nativo, que valida contra a cadeia de CAs publica normal,
  // sem pinning nenhum -- exatamente como funcionava antes desta migracao.
  return (url, init) => {
    const urlString = typeof url === "string" ? url : url.toString();
    const isHttps = urlString.startsWith("https://");
    const isContabo = urlString.includes(host);
    if (!isHttps || !isContabo) return fetch(url, init);
    return undiciFetch(url as string, { ...(init as Record<string, unknown>), dispatcher: agent }) as unknown as Promise<Response>;
  };
}

export const fetchContabo: typeof fetch = criarFetchContabo(PINNED_CERT_PEM, PINNED_FINGERPRINT_SHA256);
