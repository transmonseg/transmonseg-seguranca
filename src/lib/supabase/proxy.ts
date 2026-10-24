import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { fetchContabo } from "./fetch-contabo";
import { destinoAposLogin } from "@/lib/destino-login";

// Atualiza a sessão (refresh do token) e protege as rotas de página.
// Roda no proxy.ts (Node runtime no Next 16). Tudo exige login, exceto /login.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
      // Achado da Task 18: faltava aqui (Task 17 so cobriu server.ts/admin.ts) --
      // sem isso, TODA navegacao de pagina (proxy.ts roda em toda rota exceto
      // /login) tentava validar a sessao contra o Contabo com o fetch padrao,
      // que rejeita o certificado auto-assinado, e o usuario era chutado de
      // volta pro /login mesmo com cookie de sessao valido.
      global: { fetch: fetchContabo },
    }
  );

  // IMPORTANTE: não rode código entre createServerClient e getUser (token refresh).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const ehLogin = path === "/login";
  // /questionario-desvio e /desvio-proximos-passos (17/08): paginas publicas
  // pra Erica/Ana/Elloisy -- documento explicando o plano + formulario de
  // opiniao sobre as regras de desvio. Elas nao sao operadoras cadastradas,
  // nao dá pra exigir login.
  const ehRotaPublica =
    ehLogin || path === "/questionario-desvio" || path === "/desvio-proximos-passos";

  // Não autenticado em rota protegida → manda pro login.
  if (!user && !ehRotaPublica) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = path === "/" ? "" : `?volta=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  // Já autenticado tentando ver o login → mesma regra do login: a tela pedida
  // ou a Central Romaneio (R-F3-12-01: a Central Unitrac de 76 MB fica na engrenagem).
  if (user && ehLogin) {
    // nextUrl.clone() (não request.url): atrás do Caddy o host da requisição
    // é 127.0.0.1:3010.
    const destino = new URL(destinoAposLogin(request.nextUrl.searchParams.get("volta")), "http://x");
    const url = request.nextUrl.clone();
    url.pathname = destino.pathname;
    url.search = destino.search;
    return NextResponse.redirect(url);
  }

  return response;
}
