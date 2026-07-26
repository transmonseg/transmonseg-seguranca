// Teste de integracao do TRANSPORTE real de `fetch-contabo.ts` -- diferente
// de `fetch-contabo.test.ts` (que so testa `verificarFingerprintPinado`
// isolada, uma funcao pura de comparacao), este arquivo sobe um servidor
// `node:https` local de verdade e exercita `criarFetchContabo` (a mesma
// factory que produz o `fetchContabo` usado em producao) fazendo um
// handshake TLS real contra ele.
//
// Motivo (achado "Important" da revisao de codigo de 26/07): os bugs reais
// encontrados nas Tasks 17/18 -- a opcao `agent` do `node:https` sendo
// silenciosamente ignorada pelo `fetch` global do Node, e `checkServerIdentity`
// nunca sendo chamado quando `rejectUnauthorized: false` -- SO apareceriam
// num teste que exercita o transporte de verdade. Um teste que só chama
// `verificarFingerprintPinado(cert)` diretamente nunca passa perto do
// `undici.Agent`/`dispatcher` real, entao nao teria pego nenhum dos dois.
//
// Sem rede externa, sem depender do Contabo real estar no ar: os certificados
// usados aqui sao fixtures self-signed geradas uma vez (`openssl`) so pra
// este teste, commitadas em `__fixtures__/` -- nunca a chave privada real do
// Contabo (que so existe no VPS, `chmod 600`, nunca commitada).
//
// Tambem cobre o achado de 26/07 sobre `criarFetchContabo` aplicar o Agent
// pinado (com `ca` do Contabo como UNICA autoridade confiavel) pra QUALQUER
// URL https, nao so pro Contabo -- via o terceiro parametro (`host`) da
// factory, exercitado com o endereco de loopback do servidor de teste no
// lugar do IP real do Contabo (ver teste "NAO aplica o Agent pinado"
// abaixo).
import { describe, it, expect, afterEach } from "vitest";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { criarFetchContabo, calcularFingerprintSha256 } from "./fetch-contabo";

const FIXTURES = path.join(__dirname, "__fixtures__");

const certoPem = fs.readFileSync(path.join(FIXTURES, "tls-certo.crt"), "utf8");
const certoKey = fs.readFileSync(path.join(FIXTURES, "tls-certo.key"), "utf8");
const atacantePem = fs.readFileSync(path.join(FIXTURES, "tls-atacante.crt"), "utf8");
const atacanteKey = fs.readFileSync(path.join(FIXTURES, "tls-atacante.key"), "utf8");

// Fingerprint do certificado "correto" (pinado pelo cliente nos testes) --
// calculado a partir do DER real via a MESMA funcao que a producao usa, nao
// hardcoded, entao nao quebra se as fixtures forem regeneradas.
const fingerprintCorreto = calcularFingerprintSha256(new crypto.X509Certificate(certoPem).raw);

// Sobe um `https.Server` local de teste com o cert/key fornecidos, numa
// porta efêmera do loopback. Devolve a URL base e uma função de shutdown.
function subirServidorTeste(cert: string, key: string): Promise<{ url: string; fechar: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = https.createServer({ cert, key }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `https://127.0.0.1:${port}/`,
        fechar: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("fetchContabo (transporte TLS real, node:https local)", () => {
  let fechar: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (fechar) {
      await fechar();
      fechar = null;
    }
  });

  // As duas primeiras servidor.url apontam pra `127.0.0.1` (endereco de
  // loopback do servidor de teste), entao o `host` passado pra
  // `criarFetchContabo` precisa bater com isso -- em producao o default e'
  // `CONTABO_HOST` (o IP real do Contabo), mas o teste nao pode bindar
  // localmente naquele endereco, entao exercita a MESMA logica de host com
  // o endereco de loopback no lugar (ver achado abaixo, no teste "NAO aplica
  // o Agent pinado").

  it("aceita quando o `ca` configurado bate com o certificado real do servidor", async () => {
    const servidor = await subirServidorTeste(certoPem, certoKey);
    fechar = servidor.fechar;

    const fetchPinado = criarFetchContabo(certoPem, fingerprintCorreto, "127.0.0.1");
    const res = await fetchPinado(servidor.url);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("REJEITA quando o servidor apresenta um certificado DIFERENTE do pinado (simula MITM)", async () => {
    // Servidor de teste usa o certificado do "atacante" -- outra chave
    // privada, outra raiz -- mas o cliente continua pinado no certificado
    // "correto". E exatamente o cenario que garante que o pinning funciona
    // de verdade: um atacante ativo com OUTRO certificado auto-assinado no
    // mesmo endereco tem que ser rejeitado, nao aceito silenciosamente.
    const servidor = await subirServidorTeste(atacantePem, atacanteKey);
    fechar = servidor.fechar;

    const fetchPinado = criarFetchContabo(certoPem, fingerprintCorreto, "127.0.0.1");

    await expect(fetchPinado(servidor.url)).rejects.toThrow();
  });

  it("NAO aplica o Agent pinado quando a URL de destino nao e' do host do Contabo -- cai no fetch nativo", async () => {
    // Achado real (revisao de 26/07, confirmado testando `fetchContabo` ao
    // vivo contra o dominio real do Supabase -- deu
    // `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`): antes deste teste/fix,
    // `criarFetchContabo` aplicava o Agent pinado (com o `ca` do Contabo como
    // UNICA autoridade confiavel) pra QUALQUER URL https, nao so pro
    // Contabo -- quebrando o plano de rollback do projeto (reverter env vars
    // da Vercel de volta pro Supabase, sem mudar codigo).
    //
    // Aqui o servidor de teste usa o certificado "correto" -- o MESMO que o
    // teste "aceita" acima prova que o Agent pinado aceitaria -- mas o
    // `host` passado pra `criarFetchContabo` e' um host que NAO bate com o
    // endereco real do servidor (`127.0.0.1`). Se a checagem de host
    // estiver funcionando, isso cai no `fetch` nativo, que valida contra a
    // cadeia de CAs publica padrao -- e rejeita, porque um certificado
    // self-signed nao pinado nao esta nela. Ou seja: o MESMO certificado que
    // seria aceito com pinning e' rejeitado sem ele, provando que a
    // checagem de host de fato desativa o pinning pra hosts que nao sao o
    // Contabo.
    const servidor = await subirServidorTeste(certoPem, certoKey);
    fechar = servidor.fechar;

    const fetchNaoPinado = criarFetchContabo(certoPem, fingerprintCorreto, "host-que-nao-bate-com-nada.invalid");

    await expect(fetchNaoPinado(servidor.url)).rejects.toThrow();
  });

  it("sem `ca` nenhum configurado, um certificado self-signed tambem e rejeitado (sem fallback silencioso)", async () => {
    // Prova que nao existe nenhum caminho que "aceita qualquer coisa": o
    // `fetch` padrao do Node (sem agent/dispatcher customizado nenhum, sem
    // `ca` pinado) usa a cadeia de confianca padrao do sistema -- um
    // certificado self-signed arbitrario NAO esta nela, entao tem que
    // rejeitar tambem, com ou sem o mecanismo de pinning no meio.
    const servidor = await subirServidorTeste(certoPem, certoKey);
    fechar = servidor.fechar;

    await expect(fetch(servidor.url)).rejects.toThrow();
  });
});
