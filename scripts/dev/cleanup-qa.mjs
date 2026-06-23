// Remove os operadores de teste criados nos E2E (emails qa-*@transmonseg.com).
// Uso: node --env-file=.env.local scripts/dev/cleanup-qa.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

let page = 1;
let apagados = 0;
for (;;) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error("erro:", error.message); break; }
  const users = data.users ?? [];
  if (!users.length) break;
  for (const u of users) {
    if (u.email?.startsWith("qa-")) {
      await sb.auth.admin.deleteUser(u.id);
      apagados++;
    }
  }
  if (users.length < 200) break;
  page++;
}
console.log("usuarios QA apagados:", apagados);
