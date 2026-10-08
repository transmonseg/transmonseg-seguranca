import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { destinoAposLogin } from "@/lib/destino-login";
import { verificarPasse } from "@/lib/passe-central";

// Entrada do monitoramento pela Central (08/10): o quadro passa a ser SEMPRE de
// quem esta' logado no KPI (passe assinado, ver src/lib/passe-central.ts). Sessao
// aberta de outra pessoa no navegador e' encerrada; email sem conta aqui nao
// entra em conta nenhuma (fail-closed). Location relativo: atras do Caddy o
// host da requisicao e' 127.0.0.1:3010.
const ir = (caminho: string) => new Response(null, { status: 303, headers: { Location: caminho, "Cache-Control": "no-store" } });
const login = (erro: string) => ir(`/login?erro=${encodeURIComponent(erro)}`);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const passe = verificarPasse(url.searchParams.get("p"), process.env.MOTOR_SECRET, Math.floor(Date.now() / 1000));
  if (!passe) return login("Entrada pela Central expirou. Abra o monitoramento de novo pelo menu.");
  const destino = destinoAposLogin(url.searchParams.get("para"));

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.email?.toLowerCase() === passe.email) return ir(destino);
  if (user) await supabase.auth.signOut({ scope: "local" });

  const { data: link, error } = await createAdminClient().auth.admin.generateLink({ type: "magiclink", email: passe.email });
  const hash = link?.properties?.hashed_token;
  if (error || !hash) return login(`A conta ${passe.email} ainda não tem acesso ao monitoramento.`);
  const { error: e2 } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: hash });
  if (e2) return login("Não foi possível entrar pela Central. Tente de novo.");
  return ir(destino);
}
