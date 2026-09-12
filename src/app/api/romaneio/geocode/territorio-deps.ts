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
    // bairroNormalizado ja chega acentos-fora/maiusculo (normalizarBairro em
    // src/lib/territorio.ts) -- mesma normalizacao usada pra gravar
    // localidade_norm em cnefe_bairros, entao a comparacao no banco e' exata.
    async distanciaAoBairro(lat, lng, bairroNormalizado) {
      const { data, error } = await admin.rpc("distancia_ao_bairro", {
        p_lat: lat,
        p_lng: lng,
        p_bairro: bairroNormalizado,
      });
      if (error) return null;
      return typeof data === "number" ? data : null;
    },
  };
}
