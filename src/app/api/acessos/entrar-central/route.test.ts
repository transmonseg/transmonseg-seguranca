import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const est = vi.hoisted(() => ({
  sessao: null as null | { email: string },
  saiu: false,
  linkDe: null as null | string,
  entrouCom: null as null | string,
  existe: new Set<string>(["erica@x.com"]),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: est.sessao } }),
      signOut: async () => { est.saiu = true; est.sessao = null; return { error: null }; },
      verifyOtp: async ({ token_hash }: { token_hash: string }) => { est.entrouCom = token_hash; return { error: null }; },
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        generateLink: async ({ email }: { email: string }) => {
          est.linkDe = email;
          return est.existe.has(email)
            ? { data: { properties: { hashed_token: `hash-${email}` } }, error: null }
            : { data: null, error: { message: "User not found" } };
        },
      },
    },
  }),
}));

import { GET } from "./route";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function passe(email: string, x = Math.floor(Date.now() / 1000) + 60) {
  const corpo = b64(JSON.stringify({ e: email, x }));
  return `${corpo}.${b64(createHmac("sha256", "seg").update(`entrar-central:${corpo}`).digest())}`;
}
const req = (q: string) => new Request(`https://monitoramento.transmonseg.com.br/api/acessos/entrar-central?${q}`);
// Location relativo (atras do Caddy o host da requisicao e' 127.0.0.1:3010).
const destino = (r: Response) => { expect(r.status).toBe(303); return r.headers.get("location")!; };

describe("GET /api/acessos/entrar-central", () => {
  beforeEach(() => {
    process.env.MOTOR_SECRET = "seg";
    Object.assign(est, { sessao: null, saiu: false, linkDe: null, entrouCom: null });
  });

  it("sessao aberta de OUTRA pessoa: sai dela e entra na conta do passe", async () => {
    est.sessao = { email: "joaquim@x.com" };
    const r = await GET(req(`p=${passe("erica@x.com")}&para=${encodeURIComponent("/central-romaneio?cliente=4096")}`));
    expect(est.saiu).toBe(true);
    expect(est.entrouCom).toBe("hash-erica@x.com");
    expect(destino(r)).toBe("/central-romaneio?cliente=4096");
  });

  it("ja' e' a mesma pessoa: so' segue pra pagina", async () => {
    est.sessao = { email: "Erica@x.com" };
    const r = await GET(req(`p=${passe("erica@x.com")}&para=/`));
    expect(est.saiu).toBe(false);
    expect(est.linkDe).toBeNull();
    expect(destino(r)).toBe("/");
  });

  it("passe invalido: nao mexe em sessao nenhuma e manda pro login", async () => {
    est.sessao = { email: "joaquim@x.com" };
    const r = await GET(req(`p=lixo&para=/`));
    expect(destino(r)).toMatch(/^\/login/);
    expect(est.linkDe).toBeNull();
  });

  it("email sem conta no monitoramento: sai da sessao antiga (nunca mostra a de outra pessoa) e avisa", async () => {
    est.sessao = { email: "joaquim@x.com" };
    const r = await GET(req(`p=${passe("nova@x.com")}&para=/`));
    expect(est.saiu).toBe(true);
    expect(est.entrouCom).toBeNull();
    expect(destino(r)).toMatch(/^\/login\?erro=/);
  });

  it("destino de fora do site vira a pagina inicial", async () => {
    est.sessao = { email: "erica@x.com" };
    expect(destino(await GET(req(`p=${passe("erica@x.com")}&para=${encodeURIComponent("//evil.com/x")}`)))).toBe("/");
  });
});
