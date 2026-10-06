import { createAdminClient } from "@/lib/supabase/admin";
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
  const situacao = txt(q.situacao), status = txt(q.status);

  const admin = createAdminClient();
  const { data: veiculos } = await admin.from("veiculos").select("id, placa, ativo").in("placa", normPlacaVariantes(placa));
  const veiculo = (veiculos ?? []).sort((a, b) => Number(b.ativo) - Number(a.ativo))[0] ?? null;

  const pontos: PontoRastro[] = [];
  if (veiculo) {
    const { inicio, fim } = janelaDiaBR(data);
    for (let de = 0; de < 20000; de += 1000) {
      const { data: lote, error } = await admin.from("posicoes_historico").select("lat, lng, criado_em")
        .eq("veiculo_id", veiculo.id).gte("criado_em", inicio).lt("criado_em", fim)
        .order("criado_em", { ascending: true }).range(de, de + 999);
      if (error || !lote?.length) break;
      for (const p of lote) if (p.lat != null && p.lng != null && (p.lat !== 0 || p.lng !== 0)) pontos.push({ lat: Number(p.lat), lng: Number(p.lng), em: p.criado_em as string });
      if (lote.length < 1000) break;
    }
  }

  const alvo = cliente.lat != null && cliente.lng != null ? { lat: cliente.lat, lng: cliente.lng } : null;
  const parada = paradaDaEntrega(pontos, data, chegada, saida);
  const perto = alvo && !parada ? maisPerto(pontos, alvo) : null;
  const atual = data === hoje() && pontos.length ? pontos[pontos.length - 1] : null;

  return (
    <EntregaMapaWrapper
      info={{
        placa: veiculo?.placa ?? placa, data, ...cliente, chegada, saida, situacao, status,
        semVeiculo: !veiculo, semRastro: !!veiculo && pontos.length === 0,
        distParadaM: parada && alvo ? Math.round(distanciaM(parada, alvo)) : null,
        perto: perto ? { lat: perto.lat, lng: perto.lng, em: perto.em, distM: Math.round(perto.distM) } : null,
      }}
      rastro={afinarRastro(pontos, 2500).map(p => [p.lat, p.lng] as [number, number])}
      alvo={alvo}
      parada={parada}
      atual={atual}
    />
  );
}
