import { createClient } from "@supabase/supabase-js";

// Cliente ADMIN (service_role) — bypassa RLS.
// USO EXCLUSIVO no backend (motor, API routes). Nunca importar no client.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
