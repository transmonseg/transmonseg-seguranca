// src/app/api/alvos-teste/route.ts
//
// Marcacoes do modo teste: SEMPRE por endereco geocodificado do
// romaneio, nunca da Unitrac -- ao contrario de /api/alvos, que so cai
// pro endereco quando nao existe alvo Unitrac casando por NF. Espelha o
// padrao de auth/cache de src/app/api/alvos/route.ts, mas so le
// romaneio_pontos com modo_teste=true, sem nenhuma consulta a Unitrac.
import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { createClient } from "@/lib/supabase/server";

const pool = new pg.Pool(configPoolContabo(process.env.DATABASE_URL));

function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

type PontoEntregaTeste = {
  lat: number;
  lng: number;
  nome: string;
  enderecoBruto: string;
  feito: boolean;
  romaneioId: string;
};

export async function GET(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const placa = searchParams.get("placa");
  if (!placa) return Response.json({ pontos: [] });

  const { rows } = await pool.query<{
    id: string; lat: number; lng: number; cliente_nome: string; endereco_bruto: string; presenca_confirmada_em: string | null;
  }>(
    `SELECT id::text, lat, lng, cliente_nome, endereco_bruto, presenca_confirmada_em
       FROM romaneio_pontos
      WHERE placa = $1
        AND romaneio_data = $2::date
        AND modo_teste = true
        AND lat IS NOT NULL AND lng IS NOT NULL`,
    [placa, hojeSP()]
  );

  const pontos: PontoEntregaTeste[] = rows.map((r) => ({
    lat: r.lat,
    lng: r.lng,
    nome: r.cliente_nome,
    enderecoBruto: r.endereco_bruto,
    feito: r.presenca_confirmada_em != null,
    romaneioId: r.id,
  }));

  return Response.json({ pontos });
}
