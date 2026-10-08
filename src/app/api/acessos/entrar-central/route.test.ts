import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";

const est = vi.hoisted(() => ({
  sessao: null as null | { email: string },
  saiu: false,
  linkDe: null as null | { email: string; type: string },
  entrouCom: null as null | { token_hash: string; type: string },
  existe: new Set<string>(["erica@x.com"]),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: est.sessao } }),
      signOut: async () => { est.saiu = true; est.sessao = null; return { error: null }; },
      verifyOtp: async (a: { token_hash: string; type: string }) => { est.entrouCom = a; return { error: null }; },
    },
  }),
}));
// GoTrue de verdade: "recovery" pra email sem conta responde erro (nunca cria conta).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        generateLink: async ({ email, type }: { email: string; type: string }) => {
          est.linkDe = { email, type };
          return est.existe.has(email)
            ? { data: { properties: { hashed_token: `hash-${email}` } }, error: null }
            : { data: { properties: null, user: null }, error: { message: "User not found", status: 404 } };
        },
      },
    },
  }),
}));

import { GET } from "./route";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function passe(email: string, x = Math.floor(Date.now() / 1000) + 60, segredo = "seg-passe") {
  const corpo = b64(JSON.stringify({ e: email, x, j: randomUUID() }));
  return `${corpo}.${b64(createHmac("sha256", segredo).update(`entrar-central:${corpo}`).digest())}`;
}
const NO_QUADRO = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" };
const req = (q: string, h: Record<string, string> = NO_QUADRO) =>
  new Request(`https://monitoramento.transmonseg.com.br/api/acessos/entrar-central?${q}`, { headers: h });
// Location relativo (atras do Caddy o host da requisicao e' 127.0.0.1:3010).
const destino = (r: Response) => { expect(r.status).toBe(303); return r.headers.get("location")!; };

describe("GET /api/acessos/entrar-central", () => {
  beforeEach(() => {
    process.env.PASSE_CENTRAL_SECRET = "seg-passe";
    process.env.MOTOR_SECRET = "seg-motor";
    Object.assign(est, { sessao: null, saiu: false, linkDe: null, entrouCom: null });
  });

  it("sessao aberta de OUTRA pessoa: sai dela e entra na conta do passe", async () => {
    est.sessao = { email: "joaquim@x.com" };
    const r = await GET(req(`p=${passe("erica@x.com")}&para=${encodeURIComponent("/central-romaneio?cliente=4096")}`));
    expect(est.saiu).toBe(true);
    expect(est.linkDe).toEqual({ email: "erica@x.com", type: "recovery" });
    expect(est.entrouCom).toEqual({ token_hash: "hash-erica@x.com", type: "recovery" });
    expect(destino(r)).toBe("/central-romaneio?cliente=4096");
  });

  it("ja' e' a mesma pessoa: so' segue pra pagina", async () => {
    est.sessao = { email: "Erica@x.com" };
    const r = await GET(req(`p=${passe("erica@x.com")}&para=/`));
    expect(est.saiu).toBe(false);
    expect(est.linkDe).toBeNull();
    expect(destino(r)).toBe("/");
  });

  it("o mesmo passe nao serve duas vezes", async () => {
    est.sessao = { email: "erica@x.com" };
    const p = passe("erica@x.com");
    expect((await GET(req(`p=${p}&para=/`))).status).toBe(303);
    est.sessao = { email: "joaquim@x.com" };
    const r2 = await GET(req(`p=${p}&para=/`));
    expect(r2.status).toBe(403);
    expect(est.saiu).toBe(true); // nunca deixa a sessao de outra pessoa no quadro
  });

  it("passe assinado com o MOTOR_SECRET (vazado) nao entra", async () => {
    est.sessao = { email: "joaquim@x.com" };
    const r = await GET(req(`p=${passe("erica@x.com", undefined, "seg-motor")}&para=/`));
    expect(r.status).toBe(403);
    expect(est.linkDe).toBeNull();
  });

  it("passe invalido dentro do quadro: encerra a sessao aberta e mostra o erro (sem rebater pro login)", async () => {
    est.sessao = { email: "joaquim@x.com" };
    const r = await GET(req(`p=lixo&para=/`));
    expect(r.status).toBe(403);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(await r.text()).toMatch(/expirou/);
    expect(est.saiu).toBe(true);
  });

  it("aberto fora de um quadro da Central (link mandado por alguem): recusa sem mexer na sessao", async () => {
    est.sessao = { email: "joaquim@x.com" };
    const r = await GET(req(`p=${passe("erica@x.com")}&para=/`, { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" }));
    expect(r.status).toBe(403);
    expect(est.saiu).toBe(false);
    expect(est.linkDe).toBeNull();
  });

  it("email sem conta no monitoramento: sai da sessao antiga, nao cria conta e avisa", async () => {
    est.sessao = { email: "joaquim@x.com" };
    const r = await GET(req(`p=${passe("nova@x.com")}&para=/`));
    expect(est.saiu).toBe(true);
    expect(est.entrouCom).toBeNull();
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/nova@x\.com/);
  });

  it("destino de fora do site vira a pagina inicial", async () => {
    est.sessao = { email: "erica@x.com" };
    expect(destino(await GET(req(`p=${passe("erica@x.com")}&para=${encodeURIComponent("/\t/evil.com")}`)))).toBe("/");
  });
});
