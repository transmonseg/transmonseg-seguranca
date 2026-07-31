import { createAdminClient } from "@/lib/supabase/admin";

// Achado real 31/07 (cliente Nutry Max): usuario quer que QUALQUER tela do
// painel (Central, Analise, Romaneio) mostre se o romaneio de hoje ja foi
// processado -- hoje o resultado do upload so existia no estado local da
// pagina /romaneio, invisivel pra qualquer outro operador/tela. Server
// component: le direto do banco, igual a CentralPage (page.tsx) ja faz.
export default async function RomaneioStatusBadge() {
  const hojeSP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const admin = createAdminClient();

  const { data } = await admin
    .from("romaneio_pontos")
    .select("criado_em, enviado_por")
    .eq("romaneio_data", hojeSP)
    .eq("modo_teste", false)
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    return (
      <div
        className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-md text-xs"
        style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}
        title="Nenhum romaneio processado ainda hoje"
      >
        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "var(--text-muted)" }} />
        Romaneio pendente hoje
      </div>
    );
  }

  const hora = new Date(data.criado_em).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-md text-xs"
      style={{ color: "var(--verde)", border: "1px solid var(--border)" }}
      title={data.enviado_por ? `Processado por ${data.enviado_por}` : undefined}
    >
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "var(--verde)" }} />
      Romaneio de hoje processado às {hora}
      {data.enviado_por ? ` por ${data.enviado_por}` : ""}
    </div>
  );
}
