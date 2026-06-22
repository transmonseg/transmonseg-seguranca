"use client";

import { useState } from "react";

type NivelRisco = "verde" | "amarelo" | "vermelho";

/* Limiar a partir do qual o veiculo e considerado sem comunicacao */
const LIMIAR_SEM_COM_MIN = 60;

interface FrotaItem {
  id: string;
  placa: string;
  cv: string;
  clienteNome: string;
  clienteId: string;
  nivel: NivelRisco;
  motivo: string | null;
  velocidade: number;
  atraso_min: number;
  ignicao: boolean;
  panico: boolean;
  bau_aberto: boolean;
  parado_desde: string | null;
  updated_at: string | null;
  semComunicacao: boolean;
}

interface ClienteOpcao {
  id: string;
  nome: string;
}

interface FrotaGridProps {
  itens: FrotaItem[];
  clientes: ClienteOpcao[];
}

/**
 * Formata um atraso em minutos para texto legivel.
 * Ex.: 45 -> "45 min" | 90 -> "1h 30min" | 1440 -> "1 dia" | 2880 -> "2 dias"
 */
function formataAtraso(min: number): string {
  if (min < 2)    return "agora";
  if (min < 60)   return `${min} min`;
  const horas = Math.floor(min / 60);
  const resto = min % 60;
  if (horas < 24) return resto > 0 ? `${horas}h ${resto}min` : `${horas}h`;
  const dias = Math.floor(horas / 24);
  return `${dias} dia${dias !== 1 ? "s" : ""}`;
}

function IconIgnicao({ on }: { on: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={on ? "var(--verde)" : "var(--text-muted)"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label={on ? "Ignicao ligada" : "Ignicao desligada"}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/** Icone de sinal cortado para veiculos sem comunicacao */
function IconSemSinal() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--text-muted)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Sem comunicacao"
    >
      {/* Antena base */}
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  );
}

function CardVeiculo({ item }: { item: FrotaItem }) {
  const offline = item.atraso_min > LIMIAR_SEM_COM_MIN || item.semComunicacao;

  /* ----------------------------------------------------------------
     Borda: faixa lateral esquerda colorida APENAS para alertas.
     Cards normais/verdes e offline: borda neutra em todo o contorno.
     Cards criticos recebem fundo levemente tingido.
     ---------------------------------------------------------------- */
  const borderLeftColor =
    !offline && item.nivel === "vermelho"
      ? "var(--vermelho)"
      : !offline && item.nivel === "amarelo"
      ? "var(--amarelo)"
      : "var(--border)";

  const bgCard =
    !offline && item.nivel === "vermelho"
      ? "#1a1212"
      : "var(--card)";

  /* Cor do motivo inline (somente alertas ativos e com comunicacao) */
  const corMotivo =
    item.nivel === "vermelho" ? "var(--vermelho)" : "var(--amarelo)";

  return (
    <div
      className="rounded-2xl border p-4 flex flex-col gap-3 transition-colors"
      style={{
        backgroundColor: bgCard,
        borderColor: "var(--border)",
        borderLeftWidth: "3px",
        borderLeftColor,
        /* Opacidade reduzida para veiculos offline, reforça estado inativo */
        opacity: offline ? 0.72 : 1,
      }}
    >
      {/* Cabecalho do card */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p
            className="font-mono font-bold text-base tracking-wider"
            style={{ color: offline ? "var(--text-muted)" : "var(--text)" }}
          >
            {item.placa}
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {item.clienteNome}
          </p>
        </div>

        {/* Indicadores de status */}
        <div className="flex items-center gap-2">
          {!offline && item.panico && (
            <span
              className="px-1.5 py-0.5 rounded text-xs font-bold"
              style={{ backgroundColor: "var(--vermelho)22", color: "var(--vermelho)" }}
            >
              PANICO
            </span>
          )}
          {!offline && item.bau_aberto && (
            <span
              className="px-1.5 py-0.5 rounded text-xs font-bold"
              style={{ backgroundColor: "var(--amarelo)22", color: "var(--amarelo)" }}
            >
              BAU
            </span>
          )}
          {offline ? <IconSemSinal /> : <IconIgnicao on={item.ignicao} />}
        </div>
      </div>

      {/* Status principal */}
      {offline ? (
        /* Veiculo sem comunicacao: exibe aviso neutro/apagado */
        <p className="text-xs flex items-center gap-1.5" style={{ color: "#57534e" }}>
          Sem comunicacao ha {formataAtraso(item.atraso_min)}
        </p>
      ) : item.motivo ? (
        <p
          className="text-xs rounded px-2 py-1.5"
          style={{ backgroundColor: `${corMotivo}11`, color: corMotivo }}
        >
          {item.motivo}
        </p>
      ) : (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {item.ignicao ? "Em circulacao" : "Parado"}
        </p>
      )}

      {/* Metricas */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div
          className="rounded-lg px-2.5 py-2 flex flex-col"
          style={{ backgroundColor: "var(--card-hover)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>
            {offline ? "Ultima leitura" : "Velocidade"}
          </span>
          <span
            className="font-semibold mt-0.5"
            style={{ color: offline ? "#57534e" : "var(--text)" }}
          >
            {offline
              ? `${item.velocidade} km/h`
              : `${item.velocidade} km/h`}
          </span>
        </div>
        <div
          className="rounded-lg px-2.5 py-2 flex flex-col"
          style={{ backgroundColor: "var(--card-hover)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>
            {offline ? "Sem sinal" : "Atraso"}
          </span>
          <span
            className="font-semibold mt-0.5"
            style={{
              color: offline
                ? "#57534e"
                : item.atraso_min > 15
                ? "var(--amarelo)"
                : "var(--text)",
            }}
          >
            {offline ? formataAtraso(item.atraso_min) : formataAtraso(item.atraso_min)}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function FrotaGrid({ itens, clientes }: FrotaGridProps) {
  const [filtroCliente, setFiltroCliente] = useState("todos");

  const itensFiltrados =
    filtroCliente === "todos"
      ? itens
      : itens.filter((i) => i.clienteId === filtroCliente);

  /*
   * Ordenacao: vermelho -> amarelo -> verde ativos -> offline
   * Veiculos offline vao ao final independente do nivel registrado.
   */
  const itensOrdenados = [...itensFiltrados].sort((a, b) => {
    const aOffline = a.atraso_min > LIMIAR_SEM_COM_MIN || a.semComunicacao;
    const bOffline = b.atraso_min > LIMIAR_SEM_COM_MIN || b.semComunicacao;

    if (aOffline && !bOffline) return 1;
    if (!aOffline && bOffline) return -1;

    const ordemNivel: Record<NivelRisco, number> = { vermelho: 0, amarelo: 1, verde: 2 };
    return ordemNivel[a.nivel] - ordemNivel[b.nivel];
  });

  const totalOffline = itensFiltrados.filter(
    (i) => i.atraso_min > LIMIAR_SEM_COM_MIN || i.semComunicacao
  ).length;

  return (
    <div className="space-y-4">
      {/* Filtro por cliente */}
      <div className="flex items-center gap-2 flex-wrap">
        {clientes.map((c) => (
          <button
            key={c.id}
            onClick={() => setFiltroCliente(c.id)}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={
              filtroCliente === c.id
                ? {
                    backgroundColor: "var(--accent)",
                    color: "#0a0a0a",
                  }
                : {
                    backgroundColor: "var(--card)",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)",
                  }
            }
          >
            {c.nome}
          </button>
        ))}
      </div>

      {/* Contagem filtrada */}
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        {itensFiltrados.length} veiculo{itensFiltrados.length !== 1 ? "s" : ""}
        {totalOffline > 0 && (
          <span style={{ color: "#57534e" }}> &middot; {totalOffline} sem comunicacao</span>
        )}
      </p>

      {/* Grid de cards */}
      {itensOrdenados.length === 0 ? (
        <div
          className="flex items-center justify-center py-16 rounded-2xl border text-sm"
          style={{ backgroundColor: "var(--card)", borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          Nenhum veiculo neste cliente.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {itensOrdenados.map((item) => (
            <CardVeiculo key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
