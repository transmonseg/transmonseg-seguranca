// Tiroteios recentes do RJ (Fogo Cruzado), para a camada de risco do mapa.
// Cacheado: a API tem limite e os dados mudam de hora em hora, não a cada acesso.
import { buscarTiroteiosRJ } from "@/lib/fogocruzado";
import { createClient } from "@/lib/supabase/server";

export const revalidate = 600; // 10 min

export async function GET() {
  // Mesma proteção do resto da central: só operador logado.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const tiroteios = await buscarTiroteiosRJ(3);
  return Response.json(
    { tiroteios },
    { headers: { "Cache-Control": "private, max-age=300, s-maxage=600" } }
  );
}
