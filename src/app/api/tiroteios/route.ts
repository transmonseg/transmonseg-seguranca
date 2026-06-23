// Tiroteios do RJ (Fogo Cruzado) das últimas 24h, para a camada de risco.
// Os das últimas 3h vêm marcados como "recente" (acontecendo agora).
// Cache curto na lib; aqui evitamos cache de borda longo pra ser ao vivo.
import { buscarTiroteiosRJ } from "@/lib/fogocruzado";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  // Mesma proteção do resto da central: só operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const tiroteios = await buscarTiroteiosRJ(1);
  return Response.json(
    { tiroteios },
    { headers: { "Cache-Control": "private, max-age=60" } }
  );
}
