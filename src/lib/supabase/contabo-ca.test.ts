import { describe, it, expect } from "vitest";
import pg from "pg";
import {
  CONTABO_HOST,
  sslContabo,
  limparParametrosSsl,
  configPoolContabo,
} from "./contabo-ca";

// `connectionParameters` e' uma propriedade real de `pg.Client` (ver
// `node_modules/pg/lib/client.js`: `this.connectionParameters = new
// ConnectionParameters(config)`), mas nao faz parte do tipo publico exposto
// por `@types/pg` -- helper so pra acessar essa propriedade real de forma
// tipada nos testes de integracao abaixo, sem `any` solto pelo arquivo.
function sslResolvidoDoCliente(cliente: pg.Client): Record<string, unknown> {
  return (cliente as unknown as { connectionParameters: { ssl: Record<string, unknown> } }).connectionParameters.ssl;
}

// ─── limparParametrosSsl ────────────────────────────────────────────────────
describe("limparParametrosSsl", () => {
  it("remove sslmode de uma URL do Contabo, preservando host/porta/user/senha/database", () => {
    const original = `postgres://usuario:senha@${CONTABO_HOST}:5432/meubanco?sslmode=require`;
    const limpa = limparParametrosSsl(original);
    const url = new URL(limpa!);
    expect(url.searchParams.has("sslmode")).toBe(false);
    expect(url.username).toBe("usuario");
    expect(url.password).toBe("senha");
    expect(url.hostname).toBe(CONTABO_HOST);
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/meubanco");
  });

  it("remove sslmode mesmo com outro valor (ex: verify-full)", () => {
    const original = `postgres://usuario:senha@${CONTABO_HOST}:5432/meubanco?sslmode=verify-full`;
    const url = new URL(limparParametrosSsl(original)!);
    expect(url.searchParams.has("sslmode")).toBe(false);
  });

  it("nao altera nada se nao houver sslmode", () => {
    const original = `postgres://usuario:senha@${CONTABO_HOST}:5432/meubanco`;
    const url = new URL(limparParametrosSsl(original)!);
    const urlOriginal = new URL(original);
    expect(url.toString()).toBe(urlOriginal.toString());
  });

  it("preserva outros query params nao relacionados a ssl", () => {
    const original = `postgres://usuario:senha@${CONTABO_HOST}:5432/meubanco?uselibpqcompat=true&sslmode=require`;
    const url = new URL(limparParametrosSsl(original)!);
    expect(url.searchParams.get("uselibpqcompat")).toBe("true");
    expect(url.searchParams.has("sslmode")).toBe(false);
  });

  it("remove tambem o parametro `ssl` (nao so sslmode) da query string", () => {
    const original = `postgres://usuario:senha@${CONTABO_HOST}:5432/meubanco?ssl=true`;
    const url = new URL(limparParametrosSsl(original)!);
    expect(url.searchParams.has("ssl")).toBe(false);
  });

  it("undefined retorna undefined", () => {
    expect(limparParametrosSsl(undefined)).toBeUndefined();
  });

  it("string malformada passa direto, sem lancar", () => {
    const malformada = "isso nao e uma URL valida";
    expect(limparParametrosSsl(malformada)).toBe(malformada);
  });
});

// ─── configPoolContabo ───────────────────────────────────────────────────────
describe("configPoolContabo", () => {
  const urlContaboSemSslmode = `postgres://usuario:senha@${CONTABO_HOST}:5432/meubanco`;
  const urlContaboComSslmode = `postgres://usuario:senha@${CONTABO_HOST}:5432/meubanco?sslmode=require`;
  const urlSupabase = "postgres://usuario:senha@db.algumprojeto.supabase.co:5432/postgres";

  it("TESTE CENTRAL -- URL do Contabo com ?sslmode=require: o `ssl` retornado ainda e' o pinning real (ca/checkServerIdentity), nunca {}", () => {
    const config = configPoolContabo(urlContaboComSslmode);
    expect(config.ssl).not.toEqual({});
    expect(config.ssl).toHaveProperty("ca");
    expect((config.ssl as { ca: string }).ca).toContain("BEGIN CERTIFICATE");
    expect(typeof (config.ssl as { checkServerIdentity: unknown }).checkServerIdentity).toBe("function");
  });

  it("URL do Contabo sem sslmode: comportamento identico a sslContabo direto (pinning)", () => {
    // Nao usa `toEqual(sslContabo(...))` direto: `checkServerIdentity` e' uma
    // nova closure a cada chamada de `sslContabo`, entao duas chamadas
    // separadas nunca sao referencia-iguais -- compara estrutura (mesmo `ca`,
    // `checkServerIdentity` presente e funcional) em vez de identidade da
    // funcao.
    const config = configPoolContabo(urlContaboSemSslmode);
    const esperado = sslContabo(urlContaboSemSslmode) as { ca: string; checkServerIdentity: unknown };
    expect((config.ssl as { ca: string }).ca).toBe(esperado.ca);
    expect(typeof (config.ssl as { checkServerIdentity: unknown }).checkServerIdentity).toBe("function");
    expect(config.connectionString).toBe(urlContaboSemSslmode);
  });

  it("URL que nao e' do Contabo (Supabase): connectionString intocada, ssl continua { rejectUnauthorized: false }", () => {
    const config = configPoolContabo(urlSupabase);
    expect(config.connectionString).toBe(urlSupabase);
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });
});

// ─── Teste de integracao real: reproduz o bug original e prova que sumiu ──
// Diferente dos testes acima (que so exercitam a logica pura de
// limparParametrosSsl/configPoolContabo), este bloco instancia um `pg.Client`
// DE VERDADE (sem chamar `.connect()`, sem rede nenhuma) e inspeciona
// `connectionParameters.ssl` -- o resultado do MESMO merge interno do driver
// `pg` (`ConnectionParameters`, `connection-parameters.js`) que causa o bug
// documentado: `Object.assign({}, config, parse(config.connectionString))`
// da prioridade ao que `parse()` extrai de `sslmode` na URL, sobrescrevendo
// silenciosamente o `ssl` explicito passado ao Pool/Client.
//
// Por que isso E' um teste de integracao real (nao uma reimplementacao
// paralela do bug): exercita o codigo de terceiros (`pg/lib/connection-parameters.js`
// via `new pg.Client(...)`) de verdade, sem mock nenhum -- e' exatamente o
// ponto onde o bug acontece. Um teste de handshake TLS via `node:https`/
// servidor Postgres real (nos moldes de `fetch-contabo.transport.test.ts`)
// testaria o modulo `tls` do Node dado um `ssl` config correto/incorreto --
// mas o bug aqui NAO esta no handshake TLS em si (esse ja e' testado, e
// funciona, no teste unitario de `sslContabo`/`verificarFingerprintPinado`);
// esta no PARSING da connectionString que decide qual config chega no
// handshake. Simular o protocolo binario do Postgres (startup packet, SSL
// request byte, upgrade TLS) so pra chegar no mesmo ponto que
// `connectionParameters.ssl` ja expoe diretamente seria reimplementar o
// wire protocol do Postgres sem ganhar cobertura adicional sobre o bug real.
describe("bug real (26/07): ?sslmode= na connectionString sobrescreve ssl explicito do pg.Pool/Client", () => {
  const urlContaboComSslmode = `postgres://usuario:senha@${CONTABO_HOST}:5432/meubanco?sslmode=require`;

  it("REPRODUZ o bug original: sem o fix, o padrao antigo (`connectionString` + `ssl: sslContabo(...)` direto) perde o pinning", () => {
    // Mesmo padrao que os 9 call sites tinham ANTES deste fix.
    const clienteVulneravel = new pg.Client({
      connectionString: urlContaboComSslmode,
      ssl: sslContabo(urlContaboComSslmode),
    });
    const sslResolvido = sslResolvidoDoCliente(clienteVulneravel);
    // Achado ao rodar este teste (26/07): na versao instalada de
    // pg-connection-string (2.14.0, via pg 8.22), `sslmode=require` sem
    // `sslrootcert` resolve pra `{}` (objeto vazio) -- essa versao trata
    // 'require'/'prefer'/'verify-ca' como alias de 'verify-full' (aviso de
    // deprecation, sem relaxar `rejectUnauthorized`), diferente de versoes
    // mais antigas/da doc mais comum que resolviam pra
    // `{ rejectUnauthorized: false }`. De qualquer forma o `ssl` explicito
    // pinado (`ca`/`checkServerIdentity`) e' descartado pelo merge interno
    // (`Object.assign` em `connection-parameters.js`) -- SEM `ca`, SEM
    // `checkServerIdentity`, sobra so `{}`. Na pratica isso faz a conexao
    // FALHAR (TLS usaria a cadeia de CA publica padrao do sistema, que nao
    // reconhece o certificado auto-assinado do Contabo) em vez de aceitar
    // silenciosamente um MITM -- ainda assim e' o mesmo bug de fundo (o
    // `ssl` explicito e' descartado, o comportamento depende da query string
    // da URL configurada, nao do codigo), so que o modo de falha e'
    // "quebra tudo alto e claro" em vez de "aceita certificado errado em
    // silencio" nesta versao especifica do driver.
    expect(sslResolvido).not.toHaveProperty("ca");
    expect(sslResolvido).not.toHaveProperty("checkServerIdentity");
    expect(sslResolvido).toEqual({});
  });

  it("PROVA que o fix funciona: com configPoolContabo, o pinning real sobrevive ao merge interno do driver pg", () => {
    const clienteCorrigido = new pg.Client(configPoolContabo(urlContaboComSslmode));
    const sslResolvido = sslResolvidoDoCliente(clienteCorrigido);
    expect(sslResolvido).toHaveProperty("ca");
    expect(String(sslResolvido.ca)).toContain("BEGIN CERTIFICATE");
    expect(typeof sslResolvido.checkServerIdentity).toBe("function");
  });
});
