import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { resolverPlacaNoCadastro } from "@/lib/romaneio";
import { compactarPlaca, placasOrigemCompactas, executarTrocaVeiculo, type ResultadoTroca } from "@/lib/troca-veiculo";

// Troca de carro do dia (06/10, "Confirmar troca" no Ao vivo do KPI): as
// entregas do dia que estavam no carro da escala passam pro carro que rodou de
// verdade -- desvio/rota no monitoramento acompanham o carro certo. So' via
// ponte (x-motor-key), chamada pelo KPI depois da confirmacao da operacao.

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || !process.env.MOTOR_SECRET || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }
  let body: { data?: unknown; placaDe?: unknown; placaPara?: unknown; nfs?: unknown };
  try { body = await request.json(); } catch { return Response.json({ erro: "corpo invalido" }, { status: 400 }); }
  const { data, placaDe, placaPara } = body;
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data) || typeof placaDe !== "string" || typeof placaPara !== "string") {
    return Response.json({ erro: "esperado { data: YYYY-MM-DD, placaDe, placaPara, nfs? }" }, { status: 400 });
  }
  // nfs (07/10): so' as notas da carga trocada. Sem isso, troca mutua (dois
  // carros escalados trocaram de carga entre si, RQV5F67 x RBG4F53 em 07/10)
  // terminava com as duas cargas no mesmo carro (a 2a troca levava tudo de volta).
  const nfs = Array.isArray(body.nfs) ? body.nfs.filter((n): n is string => typeof n === "string" && n.length > 0) : null;
  if (Array.isArray(body.nfs) && (!nfs || nfs.length === 0)) {
    return Response.json({ erro: "nfs vazio" }, { status: 400 });
  }
  const admin = createAdminClient();
  const { data: veiculos, error: e1 } = await admin.from("veiculos").select("id, placa");
  if (e1) return Response.json({ ok: false, erro: e1.message }, { status: 500 });
  const frota = (veiculos ?? []) as { id: string; placa: string }[];
  const cadastroCompacto = new Set(frota.map((v) => compactarPlaca(v.placa)));
  // Destino: exata ou unica variante O/0 do cadastro (nunca chuta).
  const paraCompacta = resolverPlacaNoCadastro(compactarPlaca(placaPara), cadastroCompacto);
  const para = paraCompacta ? frota.find((v) => compactarPlaca(v.placa) === paraCompacta) : undefined;
  if (!para) return Response.json({ ok: false, erro: `placa ${placaPara} fora da frota do monitoramento` }, { status: 404 });
  // F1-05: origem casada pela placa compacta (+ variantes O/0 que nao sao
  // outro carro) direto no Postgres -- o .in("placa", ["RQO5E38"]) antigo nao
  // casava "RQO-5E38" gravado pelo upload e respondia ok com 0 pontos.
  const origens = placasOrigemCompactas(placaDe, cadastroCompacto, compactarPlaca(para.placa));
  if (origens.length === 0) return Response.json({ ok: false, erro: "placa de origem igual a de destino" }, { status: 400 });
  const veiculosOrigemCadastro = frota.filter((v) => origens.includes(compactarPlaca(v.placa))).map((v) => v.id);

  const pool = new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 1 });
  try {
    const cliente = await pool.connect();
    let r: ResultadoTroca;
    try {
      r = await executarTrocaVeiculo(cliente, { data, origens, nfs, para, veiculosOrigemCadastro });
    } finally {
      cliente.release();
    }
    if (r.movidos + r.jaNoDestino === 0) {
      if (nfs) {
        // Antes: ok:true pontos:0 e a tela achava que a troca tinha sido feita.
        return Response.json({
          ok: false,
          pontos: 0,
          nfsNaoEncontradas: r.nfsNaoEncontradas,
          erro: `as ${nfs.length} notas de ${placaDe} em ${data} nao foram encontradas no monitoramento -- nada foi trocado`,
        }, { status: 404 });
      }
      return Response.json({ ok: true, pontos: 0, para: para.placa, aviso: `nenhuma entrega de ${placaDe} em ${data} no monitoramento` });
    }
    if (nfs && r.nfsNaoEncontradas.length > 0) {
      // Revisao F1-05 (R2): troca parcial nao passa calada. O que achou ja'
      // mudou de carro (COMMIT feito, nao desfaz); a falta vira ok:false com
      // a lista, que o KPI mostra em vermelho com este texto.
      const pedidas = new Set(nfs).size;
      const faltam = r.nfsNaoEncontradas;
      const lista = faltam.slice(0, 10).join(", ") + (faltam.length > 10 ? ", ..." : "");
      return Response.json({
        ok: false,
        parcial: true,
        pontos: r.movidos,
        jaNoDestino: r.jaNoDestino,
        desviosFechados: r.desviosFechados,
        nfsNaoEncontradas: faltam,
        para: para.placa,
        erro: `troca parcial: ${pedidas - faltam.length} de ${pedidas} notas estao em ${para.placa}; ${faltam.length} notas de ${placaDe} em ${data} nao estao no monitoramento (nem em ${placaDe} nem em ${para.placa}): ${lista}`,
      }, { status: 409 });
    }
    // jaNoDestino > 0 com pontos 0 = troca refeita (o KPI regrava a troca):
    // estado certo, nada de 404 (revisao F1-05 R1).
    return Response.json({ ok: true, pontos: r.movidos, jaNoDestino: r.jaNoDestino, desviosFechados: r.desviosFechados, para: para.placa });
  } catch (err) {
    return Response.json({ ok: false, erro: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    await pool.end().catch(() => {});
  }
}
