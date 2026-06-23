import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next 16: o antigo middleware.ts virou proxy.ts (Node runtime).
// Protege todas as rotas de página; exclui api, assets e otimizações.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.ico$).*)"],
};
