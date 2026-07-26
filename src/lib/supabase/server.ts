import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { fetchContabo } from "./fetch-contabo";

// Cliente de servidor (anon/publishable + cookies) — respeita RLS,
// para Server Components e leitura autenticada do operador.
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // chamado de Server Component sem resposta mutável — ignorar
          }
        },
      },
      global: { fetch: fetchContabo },
    }
  );
}
