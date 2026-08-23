import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OrigemRomaneio } from "@/lib/romaneio-origem";

type LinhaStatus = {
  nf: string;
  cliente_nome: string;
  endereco_bruto: string;
  lat: number | null;
  lng: number | null;
  geocode_status: string;
  origem?: string | null;
};

const COLUNAS_BASE = "nf, cliente_nome, endereco_bruto, lat, lng, geocode_status";

export async function GET(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const data = searchParams.get("data");
  const modoTeste = searchParams.get("modoTeste") === "true";
  if (!data) return Response.json({ ok: false, erro: "parametro data obrigatorio" }, { status: 400 });

  const admin = createAdminClient();

  // Achado real 12/08: sem o filtro de modo_teste, o status misturava
  // contagem de romaneio real e de teste do mesmo dia quando os dois
  // existiam -- mesma classe de bug do /api/romaneio/reverter.
  const consultar = (colunas: string) =>
    admin
      .from("romaneio_pontos")
      .select(colunas)
      .eq("romaneio_data", data)
      .eq("modo_teste", modoTeste);

  // `origem` so' existe a partir da migration 059. Se o codigo subir antes
  // dela ser aplicada, o PostgREST devolve erro de coluna inexistente --
  // nesse caso repete a consulta antiga e responde origemDisponivel:false,
  // em vez de deixar a /romaneio sem status nenhum por causa de uma coluna
  // que so' serve pro resumo separado.
  let origemDisponivel = true;
  let resposta = await consultar(`${COLUNAS_BASE}, origem`);
  if (resposta.error) {
    origemDisponivel = false;
    resposta = await consultar(COLUNAS_BASE);
  }

  const linhas = (resposta.data ?? []) as unknown as LinhaStatus[];
  const contagens = { total: linhas.length, geocodadosOk: 0, falhou: 0, pendente: 0 };
  // Linha antiga (origem null) entra so' no total: nao sabemos de onde veio
  // e inventar 'romaneio' pra ela seria afirmar sobre o passado uma coisa
  // que o banco nao registrou (ver migration 059).
  const porOrigem: Record<OrigemRomaneio, number> & { semOrigem: number } = {
    romaneio: 0,
    escala_pao: 0,
    semOrigem: 0,
  };
  for (const l of linhas) {
    if (l.geocode_status === "ok") contagens.geocodadosOk++;
    else if (l.geocode_status === "falhou") contagens.falhou++;
    else contagens.pendente++;

    if (l.origem === "romaneio" || l.origem === "escala_pao") porOrigem[l.origem]++;
    else porOrigem.semOrigem++;
  }

  return Response.json({
    ok: true,
    ...contagens,
    origemDisponivel,
    porOrigem: origemDisponivel ? porOrigem : null,
    pontos: linhas.map((l) => ({
      nf: l.nf,
      clienteNome: l.cliente_nome,
      enderecoBruto: l.endereco_bruto,
      lat: l.lat,
      lng: l.lng,
      geocodeStatus: l.geocode_status,
      origem: origemDisponivel ? (l.origem ?? null) : null,
    })),
  });
}
