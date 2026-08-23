import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ORIGENS_ROMANEIO, type OrigemRomaneio } from "@/lib/romaneio-origem";

// Achado real 31/07 (cliente Nutry Max): usuario quer poder desfazer um
// romaneio processado (ex.: subiu o arquivo errado, ou quer reprocessar do
// zero). E' um "comeca de novo" pra aquele dia, nao um desfazer parcial.
//
// Achado real 12/08: a versao original apagava TODAS as linhas daquele
// romaneio_data de uma vez (teste e reais juntas, sem distincao) --
// resetar o romaneio real de producao apagava silenciosamente qualquer
// romaneio de modo teste do mesmo dia (e vice-versa), sem nenhum aviso
// disso. Agora sempre escopado por modoTeste -- reseta so' o que a tela
// tinha selecionado no momento do clique, nunca os dois juntos.
//
// 23/08: com a coluna `origem` (migration 059) da pra resetar so' um dos
// dois arquivos do dia. `origem` e' OPCIONAL -- sem ela o comportamento e'
// exatamente o de antes (apaga o dia inteiro daquele modo_teste). Um valor
// fora da allowlist e' 400, nunca "ignora o filtro": num DELETE, filtro
// ignorado apaga mais do que a tela pediu.
export async function POST(request: Request) {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const romaneioData = typeof body?.romaneioData === "string" ? body.romaneioData : null;
  const modoTeste = body?.modoTeste === true;
  if (!romaneioData) {
    return Response.json({ ok: false, erro: "romaneioData obrigatorio" }, { status: 400 });
  }

  const origemBruta = body?.origem;
  const temOrigem = origemBruta !== undefined && origemBruta !== null;
  if (temOrigem && !ORIGENS_ROMANEIO.includes(origemBruta as OrigemRomaneio)) {
    return Response.json({ ok: false, erro: "origem invalida" }, { status: 400 });
  }
  const origem = temOrigem ? (origemBruta as OrigemRomaneio) : null;

  const admin = createAdminClient();
  let consulta = admin
    .from("romaneio_pontos")
    .delete()
    .eq("romaneio_data", romaneioData)
    .eq("modo_teste", modoTeste);
  if (origem) consulta = consulta.eq("origem", origem);
  const { data, error } = await consulta.select("id");

  if (error) {
    return Response.json({ ok: false, erro: `Erro ao reverter: ${error.message}` }, { status: 500 });
  }

  return Response.json({ ok: true, linhasRemovidas: data?.length ?? 0 });
}
