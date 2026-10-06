import { createAdminClient } from "@/lib/supabase/admin";
import { acessoDoUsuario } from "@/lib/acesso-cliente";
import { janelaDiaBR, paradaDaEntrega, maisPerto, afinarRastro, distanciaM, normPlacaVariantes, type PontoRastro } from "@/lib/entrega-mapa";
import EntregaMapaWrapper from "./EntregaMapaWrapper";

// "Entrega no mapa" (05/10): aberta pelo botão "Ver no monitoramento" de cada
// NF no KPI ao vivo. Mostra o rastro do dia da placa, o endereço do cliente,
// a parada que o KPI contou como entrega (chegada -> saída) e, se for hoje,
// onde o caminhão está agora. O resultado (entregue ou não) vem do KPI.
export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const txt = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const num = (v: string | string[] | undefined) => { const n = Number(txt(v)); return Number.isFinite(n) && txt(v) !== "" ? n : null; };
const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

export default async function EntregaPage({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const placa = txt(q.placa).toUpperCase();
  const data = /^\d{4}-\d{2}-\d{2}$/.test(txt(q.data)) ? txt(q.data) : hoje();
  const cliente = { nome: txt(q.cliente), nf: txt(q.nf), endereco: txt(q.endereco), lat: num(q.lat), lng: num(q.lng) };
  const chegada = txt(q.chegada) || null, saida = txt(q.saida) || null;
  const situacao = txt(q.situacao), status = txt(q.status), volta = txt(q.volta);
  const paradaKpi = num(q.plat) != null && num(q.plng) != null ? { lat: num(q.plat)!, lng: num(q.plng)! } : null;
  // Rota inteira da placa (vem do KPI): "ordem|nf|situação|lat|lng|cliente;..."
  const rota = txt(q.pts).split(";").filter(Boolean).slice(0, 80).map(item => {
    const [ordem, nf, sit, lat, lng, nome] = item.split("|");
    const la = Number(lat), ln = Number(lng);
    return { ordem: Number(ordem) || 0, nf: nf ?? "", situacao: sit ?? "", nome: nome ?? "", lat: lat && Number.isFinite(la) ? la : null, lng: lng && Number.isFinite(ln) ? ln : null };
  });

  const admin = createAdminClient();
  // Cadastro duplicado na frota (O/0, I/1 trocados -- achado 06/10, RQO-9H37 x
  // RQ0-9H37): entre as grafias que existem, vale o rastreador que mais se
  // mexeu no dia (o outro fica parado no mesmo ponto).
  const acesso = await acessoDoUsuario();
  let consultaVeiculos = admin.from("veiculos").select("id, placa, ativo").in("placa", normPlacaVariantes(placa));
  // Conta de um cliente só: placa de outra frota não abre (vira "sem rastro").
  if (acesso.tipo === "um") consultaVeiculos = consultaVeiculos.eq("cliente_id", acesso.clienteId);
  const { data: candidatos } = acesso.tipo === "nenhum" ? { data: [] } : await consultaVeiculos;
  const { inicio, fim } = janelaDiaBR(data);
  async function posicoesDoDia(veiculoId: string): Promise<PontoRastro[]> {
    const out: PontoRastro[] = [];
    for (let de = 0; de < 20000; de += 1000) {
      const { data: lote, error } = await admin.from("posicoes_historico").select("lat, lng, criado_em")
        .eq("veiculo_id", veiculoId).gte("criado_em", inicio).lt("criado_em", fim)
        .order("criado_em", { ascending: true }).range(de, de + 999);
      if (error || !lote?.length) break;
      for (const p of lote) if (p.lat != null && p.lng != null && (p.lat !== 0 || p.lng !== 0)) out.push({ lat: Number(p.lat), lng: Number(p.lng), em: p.criado_em as string });
      if (lote.length < 1000) break;
    }
    return out;
  }
  const lugaresDe = (pts: PontoRastro[]) => new Set(pts.map(p => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`)).size;
  let veiculo: { id: string; placa: string; ativo: boolean } | null = null;
  let pontos: PontoRastro[] = [];
  for (const v of (candidatos ?? []).slice(0, 4)) {
    const pts = await posicoesDoDia(v.id);
    if (!veiculo || lugaresDe(pts) > lugaresDe(pontos) || (lugaresDe(pts) === lugaresDe(pontos) && v.ativo && !veiculo.ativo)) { veiculo = v; pontos = pts; }
  }

  const alvo = cliente.lat != null && cliente.lng != null ? { lat: cliente.lat, lng: cliente.lng } : null;
  // Rastreador que grava sempre o mesmo ponto (achado 05/10, RQO-9H37).
  const lugares = new Set(pontos.map(p => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`)).size;
  const rastroTravado = pontos.length > 20 && lugares <= 2;
  // Onde o caminhão ficou na entrega: as posições do monitoramento entre a
  // chegada e a saída do KPI (achado 05/10: a coordenada da parada da Unitrac
  // às vezes fica a 1 km+ do lugar real -- Atacadão Friburgo, 1,4 km vs 65 m).
  // Rastreador travado/sem posição: o ponto da parada da Unitrac (vem do KPI).
  const parada = (!rastroTravado ? paradaDaEntrega(pontos, data, chegada, saida) : null) ?? paradaKpi;
  const perto = alvo && !parada ? maisPerto(pontos, alvo) : null;
  const atual = data === hoje() && pontos.length && !rastroTravado ? pontos[pontos.length - 1] : null;

  return (
    <EntregaMapaWrapper
      info={{
        placa: veiculo?.placa ?? placa, data, ...cliente, chegada, saida, situacao, status,
        semVeiculo: !veiculo, semRastro: !!veiculo && pontos.length === 0, rastroTravado, volta,
        distParadaM: parada && alvo ? Math.round(distanciaM(parada, alvo)) : null,
        perto: perto ? { lat: perto.lat, lng: perto.lng, em: perto.em, distM: Math.round(perto.distM) } : null,
      }}
      rastro={rastroTravado ? [] : afinarRastro(pontos, 2500).map(p => [p.lat, p.lng] as [number, number])}
      rota={rota}
      alvo={alvo}
      parada={parada}
      atual={atual}
    />
  );
}
