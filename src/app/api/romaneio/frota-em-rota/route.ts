import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { DIST_MIN_BASE_ROMANEIO_AUSENTE_M, SQL_FROTA_EM_ROTA, type VeiculoEmRotaComRomaneio } from "@/lib/romaneio-ausente";

// F3-07 (ACH-04): o tick do KPI pergunta, as 06:30 e 07:30 BRT, se a frota do
// cliente esta' rodando antes de avisar o dono que o romaneio nao chegou
// (S-06: nao avisar "sem romaneio" quando a frota nao rodou). Mesma regra do
// card romaneio_ausente (@/lib/romaneio-ausente). So' leitura, so' via ponte
// (x-motor-key), servidor a servidor.
export const maxDuration = 20;

const LIMIAR_ATRASO_FRESCO_MIN = 60;

export async function GET(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }
  const url = new URL(request.url);
  const data = url.searchParams.get("data");
  const cod = url.searchParams.get("cod");
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return Response.json({ erro: "parametro data (YYYY-MM-DD) obrigatorio" }, { status: 400 });
  }
  if (!cod || !/^\d{1,10}$/.test(cod)) {
    return Response.json({ erro: "parametro cod obrigatorio" }, { status: 400 });
  }
  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 1 });
  try {
    const { rows } = await pool.query<Pick<VeiculoEmRotaComRomaneio, "placa" | "tem_romaneio">>(
      SQL_FROTA_EM_ROTA,
      [[cod], LIMIAR_ATRASO_FRESCO_MIN, data, DIST_MIN_BASE_ROMANEIO_AUSENTE_M],
    );
    const sem = rows.filter((r) => !r.tem_romaneio).map((r) => r.placa).sort();
    return Response.json({ data, cod, emRota: rows.length, semRomaneio: sem.length, placasSemRomaneio: sem });
  } catch (e) {
    // Erro nao vira "frota parada": o KPI trata como desconhecido.
    // Revisao F3-07 (R6): o motivo vai pro log e pra resposta (so' a ponte,
    // com x-motor-key, le) -- antes o banner "frota nao conferida" saia sem
    // ninguem saber se era timeout, SQL ou conexao.
    const motivo = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    console.error(`[romaneio/frota-em-rota] cod ${cod} dia ${data}: consulta falhou: ${motivo}`);
    return Response.json({ erro: `falha na consulta: ${motivo}` }, { status: 500 });
  } finally {
    await pool.end().catch(() => {});
  }
}
