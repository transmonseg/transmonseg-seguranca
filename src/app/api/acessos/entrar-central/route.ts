import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { destinoAposLogin } from "@/lib/destino-login";
import { consumirPasse, verificarPasse } from "@/lib/passe-central";

// Entrada do monitoramento pela Central (08/10): o quadro passa a ser SEMPRE de
// quem esta' logado no KPI (passe assinado, ver src/lib/passe-central.ts).
//  - so' dentro de um quadro do mesmo site (Sec-Fetch-*): link mandado por
//    alguem nao troca a conta de ninguem (login CSRF);
//  - falha dentro do quadro encerra a sessao aberta e mostra o erro aqui mesmo
//    (o /login rebate quem ja' esta' logado e voltaria a sessao de outra pessoa);
//  - "recovery" (nao "magiclink"): pro email sem conta o GoTrue responde erro
//    em vez de criar a conta.
// Location relativo: atras do Caddy o host da requisicao e' 127.0.0.1:3010.
const ir = (caminho: string) => new Response(null, { status: 303, headers: { Location: caminho, "Cache-Control": "no-store" } });

function erro(texto: string): Response {
  const t = texto.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monitoramento</title>`
    + `<body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;font:15px system-ui,sans-serif;background:#0b0f14;color:#e5e7eb;text-align:center;padding:16px">`
    + `<div><p style="margin:0 0 8px">${t}</p><p style="margin:0;color:#9ca3af">Abra o monitoramento de novo pelo menu da Central.</p></div></body></html>`;
  return new Response(html, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (request.headers.get("sec-fetch-dest") !== "iframe" || (site !== "same-site" && site !== "same-origin")) {
    return erro("Esta entrada só funciona dentro da Central Transmonseg.");
  }
  const url = new URL(request.url);
  const agora = Math.floor(Date.now() / 1000);
  const passe = verificarPasse(url.searchParams.get("p"), process.env.PASSE_CENTRAL_SECRET, agora);
  const supabase = await createClient();
  const sair = async () => { await supabase.auth.signOut({ scope: "local" }); };

  if (!passe || !consumirPasse(passe, agora)) {
    await sair();
    return erro("A entrada pela Central expirou.");
  }
  const destino = destinoAposLogin(url.searchParams.get("para"));
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.email?.toLowerCase() === passe.email) return ir(destino);
  if (user) await sair();

  const { data: link, error } = await createAdminClient().auth.admin.generateLink({ type: "recovery", email: passe.email });
  const hash = link?.properties?.hashed_token;
  if (error || !hash) return erro(`A conta ${passe.email} ainda não tem acesso ao monitoramento.`);
  const { error: e2 } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: hash });
  if (e2) {
    await sair();
    return erro("Não foi possível entrar pela Central. Tente de novo.");
  }
  return ir(destino);
}
