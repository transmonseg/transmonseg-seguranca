// Adaptador entre o cliente Supabase da rota e as deps puras de
// src/lib/territorio.ts. Toda falha de consulta vira null -- quem decide o que
// fazer com a ausencia de dado e' validarTerritorio, que e' fail-open.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DepsTerritorio } from "@/lib/territorio";

export function montarDepsTerritorio(admin: SupabaseClient): DepsTerritorio {
  return {
    async municipioDaCoordenada(lat, lng) {
      const { data, error } = await admin.rpc("municipio_da_coordenada", { p_lat: lat, p_lng: lng });
      if (error || !Array.isArray(data) || data.length === 0) return null;
      const codigo = (data[0] as { municipio_codigo?: unknown }).municipio_codigo;
      return typeof codigo === "string" ? codigo : null;
    },
    async bairroDaCoordenada(lat, lng) {
      const { data, error } = await admin.rpc("bairro_da_coordenada", { p_lat: lat, p_lng: lng });
      if (error || !Array.isArray(data) || data.length === 0) return null;
      const linha = data[0] as { localidade?: unknown; distancia_m?: unknown };
      if (typeof linha.localidade !== "string" || typeof linha.distancia_m !== "number") return null;
      return { localidade: linha.localidade, distanciaM: linha.distancia_m };
    },
  };
}
