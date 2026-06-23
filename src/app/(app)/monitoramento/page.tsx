/**
 * Pagina de Monitoramento -- Transmonseg Central
 *
 * Server Component. Le o param ?cliente= (igual a home), carrega a lista de
 * clientes e os veiculos do cliente ativo via createAdminClient (service_role).
 * Renderiza o seletor de cliente e repassa tudo para o MonitorWrapper.
 */

import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import MonitorWrapper from "../components/MonitorWrapper";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* Tipos                                                                */
/* ------------------------------------------------------------------ */

interface Cliente {
  id: string;
  nome: string;
  cod_user_unitrac: string;
}

interface Veiculo {
  id: string;
  cliente_id: string;
  placa: string;
  cv: string;
}

/* ------------------------------------------------------------------ */
/* Icones SVG                                                           */
/* ------------------------------------------------------------------ */

function IconTruck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="15" height="13" />
      <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
    </svg>
  );
}

function IconMonitor({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Seletor de cliente (igual ao da home, adaptado para /monitoramento) */
/* ------------------------------------------------------------------ */

function SeletorCliente({
  clientes,
  clienteAtualId,
  veiculosPorCliente,
}: {
  clientes: Cliente[];
  clienteAtualId: string;
  veiculosPorCliente: Record<string, number>;
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {clientes.map((c) => {
        const ativo = c.id === clienteAtualId;
        const nVeics = veiculosPorCliente[c.id] ?? 0;
        return (
          <Link
            key={c.id}
            href={`/monitoramento?cliente=${c.cod_user_unitrac}`}
            className="flex items-center gap-2.5 px-5 py-2.5 rounded-2xl transition-all duration-150 no-underline"
            style={
              ativo
                ? {
                    backgroundColor: "var(--accent-dim)",
                    border: "1px solid var(--accent)",
                    color: "var(--accent)",
                  }
                : {
                    backgroundColor: "transparent",
                    border: "1px solid var(--border)",
                    color: "var(--text-muted)",
                  }
            }
          >
            <span style={{ color: ativo ? "var(--accent)" : "var(--text-dim)" }}>
              <IconTruck size={14} />
            </span>
            <span className="text-sm font-semibold tracking-tight leading-none">
              {c.nome}
            </span>
            <span
              className="num-mono text-xs font-bold"
              style={{
                fontFamily: "var(--font-geist-mono, monospace)",
                color: ativo ? "var(--accent)" : "var(--text-dim)",
                opacity: 0.8,
              }}
            >
              {nVeics}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pagina                                                               */
/* ------------------------------------------------------------------ */

export default async function MonitoramentoPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { cliente: clienteParam } = await searchParams;
  const supabase = createAdminClient();

  const [{ data: clientesRaw }, { data: veiculosRaw }] = await Promise.all([
    supabase.from("clientes").select("id, nome, cod_user_unitrac").order("cod_user_unitrac"),
    supabase.from("veiculos").select("id, cliente_id, placa, cv"),
  ]);

  const clientes: Cliente[] = clientesRaw ?? [];
  const todosVeiculos: Veiculo[] = veiculosRaw ?? [];

  const codParam = typeof clienteParam === "string" ? clienteParam : undefined;
  const clienteAtivo: Cliente =
    (codParam && clientes.find((c) => c.cod_user_unitrac === codParam)) ||
    clientes[0];

  if (!clienteAtivo) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ minHeight: "60vh", color: "var(--text-dim)" }}
      >
        Nenhum cliente cadastrado.
      </div>
    );
  }

  const veiculosPorCliente: Record<string, number> = {};
  for (const c of clientes) {
    veiculosPorCliente[c.id] = todosVeiculos.filter((v) => v.cliente_id === c.id).length;
  }

  const veiculosDoCliente = todosVeiculos
    .filter((v) => v.cliente_id === clienteAtivo.id)
    .map((v) => ({ placa: v.placa, cv: v.cv }));

  return (
    <div style={{ maxWidth: "1600px", margin: "0 auto", padding: "1.5rem 1.5rem 4rem" }}>

      {/* Cabecalho da pagina */}
      <section aria-label="Cabecalho de monitoramento" style={{ marginBottom: "1.5rem" }}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2" style={{ color: "var(--text-dim)" }}>
              <IconMonitor size={11} />
              <span
                className="text-xs uppercase tracking-widest"
                style={{ letterSpacing: "0.14em", color: "var(--text-dim)" }}
              >
                Monitoramento
              </span>
            </div>
            <SeletorCliente
              clientes={clientes}
              clienteAtualId={clienteAtivo.id}
              veiculosPorCliente={veiculosPorCliente}
            />
          </div>
          {/* Indicador de cliente ativo */}
          <div
            className="flex items-center gap-2 px-4 py-2 rounded-xl"
            style={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
            }}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: "var(--verde)" }}
            />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {clienteAtivo.nome}
            </span>
            <span
              className="num-mono text-xs font-semibold"
              style={{ fontFamily: "var(--font-geist-mono, monospace)", color: "var(--accent)" }}
            >
              {veiculosDoCliente.length} veiculos
            </span>
          </div>
        </div>
      </section>

      {/* Corpo: mapa + painel lateral (MonitorWrapper carrega o MapaMonitor client-side) */}
      <MonitorWrapper
        cliente={clienteAtivo.cod_user_unitrac}
        veiculos={veiculosDoCliente}
      />
    </div>
  );
}
