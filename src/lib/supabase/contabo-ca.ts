import crypto from "node:crypto";
import type { ConnectionOptions } from "node:tls";

// Certificado auto-assinado gerado no Contabo (Task 16,
// docs/plans/2026-07-25-migracao-contabo.md / .superpowers/sdd/task-16-report.md).
// PEM publico -- e literalmente enviado em claro em todo handshake TLS por
// qualquer cliente que conectar, entao nao ha problema nenhum em versionar.
//
// Fonte unica compartilhada entre os dois caminhos de conexao Vercel->Contabo
// (achado "Important" da revisao de codigo de 26/07): `undici.Agent`
// (fetch-contabo.ts, usado por @supabase/supabase-js e @supabase/ssr) e
// `pg.Pool`/`pg.Client` (rotas que falam Postgres direto, ver `sslContabo()`
// abaixo). NAO duplicar esta string em nenhum outro arquivo -- sempre
// importar daqui.
export const CONTABO_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIFIDCCAwigAwIBAgIUV4lRUmoCuqw5AARnYAHC7eFpjVEwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMMTY5LjU4LjczLjk0MB4XDTI2MDcyNjA1MDgwMVoXDTM2
MDcyMzA1MDgwMVowFzEVMBMGA1UEAwwMMTY5LjU4LjczLjk0MIICIjANBgkqhkiG
9w0BAQEFAAOCAg8AMIICCgKCAgEAtFTooG2S9MZnzjWVDAA3vYdCycRMuApMiW/m
nce4t2y+J86fZYZM6on6Q7bLXo6tQ/KRIgiWiJApB7Zh93zfRWXohpMKhDmVhT2F
4NDnHKPZaUKjrvgInOXq/coFuct2QpjdSYL2m725rwSUx7P8TYV1J6VueoD5KTqa
QmXGNQP9T8cfkeVXEQ4uGBPxyqPE2xjjtZXNb79FQ1u/hcwrYrj4RDzZI9ScWwnO
s2VyrYPn2IKjZyKGO1Kw6lI1mUXqTMegfxVVovW3KNKPaZiu5h9bVmLkDdE8bqtu
fR+9LpeR0Y4HTyN/jOgahdT2wO77ROqwL1C9WKa9MwCShF8IygQ3WWXfDeUYEVC+
tpHN3Ks/WEc3x/wT4lFV9NpPFsq5oXhwsbtv5QqOb4Y4Jj/p33hpeSD77GHCRS89
WwxtuFsQznx8OB2XfzDppJ4JyIVWO1MA0PsQKV4EDNWYKlv71gqcTXBMeL/LlyId
svfjPzYes2dDa+0nbS7DKg+nCWdsn47p2HIQHJYqt4ghEGCAaN2AWyvhx6827MJs
dJQWs1HBVdq9mXT52WErkBTZelPDHTeb0bNnQ7L+lxnofN7wxCPbiohwkLsWamIv
7hh+p7Gshl7//1dO5YDm31ylKxgLzcZ9JUzR0fiJab0Q7O0UrT6e3NVJ/CnIoZZM
Q/Y2S70CAwEAAaNkMGIwHQYDVR0OBBYEFEMJvdZ/SGJf4DsNAMkvfLDUrI0VMB8G
A1UdIwQYMBaAFEMJvdZ/SGJf4DsNAMkvfLDUrI0VMA8GA1UdEwEB/wQFMAMBAf8w
DwYDVR0RBAgwBocEqTpJXjANBgkqhkiG9w0BAQsFAAOCAgEARvvgXBZwq/fD78ca
Df1mClC+0731N8zUvyBDf82w8DK8kOd0hgSE2Z/kvSxDoNb8c6uHWiDywHpVNpQM
67zSTW3CJhDPHoKvUbC7g1EJ8pNdGaKC7lKmvpHcF17fFUMieHlpjRHN2NO+RrSM
vZ1h3bv+fOB+FOKnu3Ga/hRsZ7TAoYXV13ByS8+e/VXNX2wqa0JtMG0qRAEs/tbj
CaEZP9BEphtmJesb2wlgIJF1dloKYffDVA/FqQPu++P8D8IS7ox3juYV8jpEEGXv
eyLPhpceK9DQ0Pk9GrLlrkrXjQtUOCiU9Cxc6VZocd7BQPUzUp+LRs5y5Pi98OBm
fizLdz061f+TQ4UY/V7k8aXcp0JMQrL7Cn9pC3cLPcG+TM5y2kgFqpfF47BAUn0f
KkRF1ltKeQDxdscQ4h3W6Nvaj2i3JxbYIZl25pWwjQkrqvyv59lgC4GpvgyayznJ
GBfyijGnwhBnYj8rrDY4+olLPpIdmr1du5wz8amwC4AphAl57U/1fEI+R9Ek5fm+
dOTvW3qxtQT7nQwmtyCd6EC/mkbayQ2cNnC9DJApBrGkut3PG2sAsFchxRL+u0XA
pHftd3DHcmZ4aTJeswvGKur0yU/bPBoXA2Y0/HO+vCKKjsc2D+XR213YoJiSsDuy
AWfDavptvzcJtq70G6iXeiwg12k=
-----END CERTIFICATE-----
`;

// IP publico do Postgres do Contabo. Usado por `sslContabo()` abaixo pra
// decidir se a `DATABASE_URL` em uso aponta pro Contabo (aplica o `ca`
// pinado) ou pra outro host (Supabase, com CA publica valida; Postgres local
// via SSH/tunel, sem TLS nenhum; etc) -- nesses outros casos preserva o
// comportamento pre-existente, sem `ca` customizado.
export const CONTABO_HOST = "169.58.73.94";

// Fingerprint SHA-256 do certificado acima -- mantido como segunda camada de
// verificacao (defesa em profundidade, ver `verificarFingerprintPinado`
// abaixo) e para os testes que exercitam so a logica pura de comparacao.
export const PINNED_FINGERPRINT_SHA256 =
  "FA:3D:40:2D:4F:21:BA:1B:C6:50:37:FA:82:31:9A:65:FA:94:BA:4F:19:1C:BD:CC:7E:03:7A:8E:46:12:1F:67";

// Calcula o fingerprint SHA-256 (formato AA:BB:...:ZZ, hex maiusculo) de um
// certificado a partir do buffer bruto (cert.raw / DER).
export function calcularFingerprintSha256(certRaw: Buffer): string {
  return crypto
    .createHash("sha256")
    .update(certRaw)
    .digest("hex")
    .toUpperCase()
    .match(/.{2}/g)!
    .join(":");
}

// Funcao pura que implementa a verificacao de identidade por fingerprint
// pinado -- mesmo contrato que o Node espera de `checkServerIdentity`
// (retorna undefined se aceito, Error se rejeitado). Extraida do agente TLS
// (undici e pg, abaixo) para ser testavel sem precisar de uma conexao TLS
// real.
export function verificarFingerprintPinado(
  cert: { raw: Buffer },
  esperado: string = PINNED_FINGERPRINT_SHA256
): Error | undefined {
  const fingerprint = calcularFingerprintSha256(cert.raw);
  if (fingerprint !== esperado) {
    return new Error(
      `Certificado do Contabo nao bate com o fingerprint fixado (esperado ${esperado}, recebido ${fingerprint})`
    );
  }
  return undefined; // aceito
}

// Config de `ssl` pra `pg.Pool`/`pg.Client`: pinning real (`ca` = certificado
// do Contabo, `rejectUnauthorized` no default = true, TLS so fecha handshake
// se o servidor apresentar EXATAMENTE este certificado) quando a
// `connectionString` aponta pro IP publico do Contabo -- mesma protecao que
// `fetch-contabo.ts` ja aplica no caminho @supabase/supabase-js e
// @supabase/ssr, agora tambem no caminho `pg` direto (achado "Important" da
// revisao de 26/07: `rejectUnauthorized: false` sozinho criptografa mas nao
// verifica identidade nenhuma -- um atacante ativo apresentando outro
// certificado auto-assinado no mesmo IP seria aceito sem reclamar).
//
// IMPORTANTE (achado real, confirmado por teste de conexao ao vivo contra o
// Contabo, 26/07): o driver `pg` NAO passa `servername`/`host` pro
// `tls.connect()` quando o host de conexao e' um IP puro (SNI nao se aplica
// a enderecos IP, RFC 6066 -- ver `node_modules/pg/lib/connection.js`,
// `upgradeToSSL`). Sem isso, o `checkServerIdentity` padrao do Node usa o
// default 'localhost' como hostname esperado e rejeita QUALQUER certificado
// real (`ERR_TLS_CERT_ALTNAME_INVALID`), mesmo com o `ca` certo -- achado que
// so apareceu testando uma conexao real, nao no `tsc`/lint. Por isso, junto
// com `ca`, fixamos tambem um `checkServerIdentity` proprio que ignora o
// hostname (a cadeia de confianca do `ca` self-signed ja e' o pinning em si)
// e reusa a mesma verificacao por fingerprint do caminho `undici` acima --
// defesa em profundidade, nao so tolerancia.
//
// Fora do Contabo (Supabase local/dev, ou qualquer outro host) mantem o
// comportamento anterior (`rejectUnauthorized: false`) sem alteracao --
// evita quebrar ambientes que nao usam o certificado auto-assinado do
// Contabo (dev local aponta pro Supabase hoje, ver `.env.local`).
export function sslContabo(connectionString: string | undefined): ConnectionOptions {
  if (connectionString?.includes(CONTABO_HOST)) {
    return {
      ca: CONTABO_CA_PEM,
      checkServerIdentity: (_hostname, cert) => verificarFingerprintPinado(cert),
    };
  }
  return { rejectUnauthorized: false };
}
