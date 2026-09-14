// Adaptador entre o cliente Supabase da rota e as deps puras de
// src/lib/territorio.ts. Toda falha de consulta vira null -- quem decide o que
// fazer com a ausencia de dado e' validarTerritorio, que e' fail-open.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DepsTerritorio } from "@/lib/territorio";

export function montarDepsTerritorio(admin: SupabaseClient): DepsTerritorio {
  return {
    async municipioDaCoordenada(lat, lng) {
      const { data, error } = await admin.rpc("municipio_da_coordenada", { p_lat: lat, p_lng: lng });
      // Fix 2 (Fase 2, 13/09): so' loga quando a RPC de fato falhou -- data
      // vazio SEM erro e' resposta normal (nenhum poligono contem o ponto,
      // fora do RJ ou malha incompleta), nunca deve virar barulho.
      if (error) {
        console.error("[territorio-deps] RPC municipio_da_coordenada falhou -- aprovando por fail-open", error);
        return null;
      }
      if (!Array.isArray(data) || data.length === 0) return null;
      const codigo = (data[0] as { municipio_codigo?: unknown }).municipio_codigo;
      return typeof codigo === "string" ? codigo : null;
    },
    // bairroNormalizado ja chega acentos-fora/maiusculo (normalizarBairro em
    // src/lib/territorio.ts) -- mesma normalizacao usada pra gravar
    // localidade_norm em cnefe_bairros, entao a comparacao no banco e' exata.
    // municipioCodigo (Fix 1, Fase 2 13/09): repassado pra RPC como
    // p_municipio pra que 084 filtre o hull pelo municipio esperado --
    // null mantem o comportamento fail-open de buscar em todos os
    // municipios (ver src/lib/territorio.ts).
    async distanciaAoBairro(lat, lng, bairroNormalizado, municipioCodigo) {
      const { data, error } = await admin.rpc("distancia_ao_bairro", {
        p_lat: lat,
        p_lng: lng,
        p_bairro: bairroNormalizado,
        p_municipio: municipioCodigo,
      });
      // Fix 2 (Fase 2, 13/09) -- achado real do dia: migration 084 aplicada
      // antes do codigo criou uma segunda "distancia_ao_bairro" (3 args),
      // deixando a chamada ambigua; a RPC passou a errar em TODA chamada, o
      // erro virava null aqui e a guarda ficou morta em producao sem log
      // nenhum ate teste manual achar coordenada 5km errada aprovada. Data
      // null SEM erro e' resposta normal (bairro nao existe no CNEFE, 942
      // enderecos, esperado e comum) -- so' loga quando ha erro de fato.
      if (error) {
        console.error("[territorio-deps] RPC distancia_ao_bairro falhou -- aprovando por fail-open", error);
        return null;
      }
      return typeof data === "number" ? data : null;
    },
  };
}
