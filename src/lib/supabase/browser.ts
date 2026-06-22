import { createBrowserClient } from "@supabase/ssr";

// Cliente do navegador (anon/publishable) — respeita RLS.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
