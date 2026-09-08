// Estado compartilhado de qual mapa a Central deve renderizar (Google ou
// fallback OSM self-hospedado), ver spec
// docs/superpowers/specs/2026-09-08-mapa-fallback-quota-google-design.md.
// GET e' lido por toda tela que monta o mapa, no mesmo polling de 30s que
// ja existe hoje (nao introduz intervalo novo). POST e' chamado pelo
// navegador quando detecta o erro de cota do Google (deteccao-cota-google.ts)
// ou quando termina uma tentativa de retry.

import pg from "pg";
import { createClient } from "@/lib/supabase/server";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { transicionar, type EventoMapaProvider, type MapaProviderEstado } from "@/lib/mapa-provider";

function linhaParaEstado(row: {
  provider: string;
  quota_excedida_em: string | null;
  proxima_tentativa_em: string | null;
}): MapaProviderEstado {
  return {
    provider: row.provider as MapaProviderEstado["provider"],
    quotaExcedidaEm: row.quota_excedida_em,
    proximaTentativaEm: row.proxima_tentativa_em,
  };
}

export async function GET() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 2 });
  try {
    const { rows } = await pool.query(
      `SELECT provider, quota_excedida_em, proxima_tentativa_em FROM mapa_provider_estado WHERE id = 1`
    );
    if (rows.length === 0) {
      return Response.json({ erro: "estado do mapa nao inicializado (migracao 075 rodou?)" }, { status: 500 });
    }
    return Response.json(linhaParaEstado(rows[0]));
  } finally {
    await pool.end();
  }
}

const EVENTOS_VALIDOS: EventoMapaProvider[] = ["quota_excedida", "retry_sucesso", "retry_falhou"];

export async function POST(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const evento = body?.evento as EventoMapaProvider | undefined;
  if (!evento || !EVENTOS_VALIDOS.includes(evento)) {
    return Response.json({ erro: `evento invalido, esperado um de: ${EVENTOS_VALIDOS.join(", ")}` }, { status: 400 });
  }

  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 2 });
  try {
    const { rows } = await pool.query(
      `SELECT provider, quota_excedida_em, proxima_tentativa_em FROM mapa_provider_estado WHERE id = 1`
    );
    if (rows.length === 0) {
      return Response.json({ erro: "estado do mapa nao inicializado (migracao 075 rodou?)" }, { status: 500 });
    }
    const estadoAtual = linhaParaEstado(rows[0]);
    const agoraIso = new Date().toISOString();
    const novoEstado = transicionar(estadoAtual, evento, agoraIso);

    await pool.query(
      `UPDATE mapa_provider_estado
          SET provider = $1, quota_excedida_em = $2, proxima_tentativa_em = $3, atualizado_em = now()
        WHERE id = 1`,
      [novoEstado.provider, novoEstado.quotaExcedidaEm, novoEstado.proximaTentativaEm]
    );
    return Response.json(novoEstado);
  } finally {
    await pool.end();
  }
}
