import { createAdminClient } from "@/lib/supabase/admin";
import { geocodificarEndereco, geocodificarGoogle, geocodificarNominatim } from "@/lib/romaneio-geocode";

export const maxDuration = 60;

const LOTE_POR_INVOCACAO = 40;
// Espera sequencial ANTES de cada chamada real de rede (nao de cache-hit)
// -- respeita a politica real de 1 req/s do Nominatim publico. Loop unico
// sequencial: nao precisa da fila esperarVaga()/filaThrottle da cerca
// virtual (aquele mecanismo coordena chamadas concorrentes de VARIOS
// pontos do motor no mesmo ciclo; aqui e um unico loop, throttle simples
// ja basta).
const ESPERA_ENTRE_CHAMADAS_MS = 1100;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: pendentes, error: erroPendentes } = await admin
    .from("romaneio_pontos")
    .select("id, endereco_bruto")
    .eq("geocode_status", "pendente")
    .order("criado_em", { ascending: true })
    .limit(LOTE_POR_INVOCACAO);

  if (erroPendentes) {
    console.error(`Erro ao buscar romaneio_pontos pendentes: ${erroPendentes.message}`);
  }

  if (!pendentes || pendentes.length === 0) {
    return Response.json({ processados: 0 });
  }

  const buscarCache = async (chaveNormalizada: string) => {
    const { data } = await admin.from("romaneio_geocode_cache").select("lat, lng, fonte").eq("endereco_normalizado", chaveNormalizada).maybeSingle();
    return data ?? null;
  };
  const salvarCache = async (chaveNormalizada: string, r: { lat: number; lng: number; fonte: string }) => {
    await admin.from("romaneio_geocode_cache").upsert({ endereco_normalizado: chaveNormalizada, lat: r.lat, lng: r.lng, fonte: r.fonte, atualizado_em: new Date().toISOString() });
  };

  let ok = 0;
  let falhou = 0;

  for (const linha of pendentes) {
    // So espera antes de chamada de rede REAL -- cache-hit nao precisa de
    // throttle (buscarCache e so leitura local). geocodificarEndereco ja
    // checa cache primeiro internamente, entao esperamos incondicionalmente
    // aqui (simples, custo desprezivel num cache-hit: so atrasa a
    // proxima linha do MESMO lote, nao afeta corretude).
    await esperar(ESPERA_ENTRE_CHAMADAS_MS);
    const geocode = await geocodificarEndereco(linha.endereco_bruto, { buscarCache, salvarCache, geocodificarGoogle, geocodificarNominatim });

    const geocodeStatus = geocode ? "ok" : "falhou";
    if (geocode) ok++; else falhou++;

    const { error: erroUpdate } = await admin
      .from("romaneio_pontos")
      .update({ lat: geocode?.lat ?? null, lng: geocode?.lng ?? null, geocode_status: geocodeStatus })
      .eq("id", linha.id);

    if (erroUpdate) {
      console.warn(`Aviso: erro ao atualizar geocode_status do ponto ${linha.id}: ${erroUpdate.message}`);
    }
  }

  return Response.json({ processados: pendentes.length, ok, falhou });
}
