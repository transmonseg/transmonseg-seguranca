"use client";

/**
 * FiltrosBar — barra horizontal de chips para filtrar alertas e mapa
 * simultaneamente pela URL (sobrevive ao auto-refresh de 30s).
 *
 * Params de URL mantidos:
 *   cliente  — preservado ao navegar
 *   tipos    — lista separada por virgula dos tipos de alerta selecionados
 *   problema — "1" quando o chip "So com problema" esta ativo
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";

// Definicao dos chips de tipo
interface ChipTipo {
  label: string;
  // tipos tecnicos que este chip representa (exato, minusculo)
  tipos: string[];
}

const CHIPS_TIPO: ChipTipo[] = [
  { label: "Desvio",         tipos: ["desvio"] },
  { label: "Parada cliente", tipos: ["parada_cliente"] },
  { label: "Parada longa",   tipos: ["parada_longa"] },
  { label: "Tiroteio",       tipos: ["tiroteio"] },
  { label: "Favela",         tipos: ["favela"] },
  { label: "Jammer/Sinal",   tipos: ["jammer", "sinal", "bloqueio"] },
  { label: "Excesso",        tipos: ["excesso"] },
  { label: "Panico",         tipos: ["panico"] },
  { label: "Bau",            tipos: ["bau"] },
];

export default function FiltrosBar() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Ler estado atual da URL
  const tiposParam = params.get("tipos") ?? "";
  const tiposAtivos = tiposParam ? tiposParam.split(",").filter(Boolean) : [];
  const soProblema = params.get("problema") === "1";
  const temFiltro = tiposAtivos.length > 0 || soProblema;

  // Navega preservando "cliente"
  function navegar(novosParams: URLSearchParams) {
    router.push(pathname + "?" + novosParams.toString(), { scroll: false });
  }

  function buildParams(): URLSearchParams {
    const next = new URLSearchParams();
    const cliente = params.get("cliente");
    if (cliente) next.set("cliente", cliente);
    return next;
  }

  // Verifica se um chip de tipo esta ativo: basta qualquer dos seus tipos estar na lista
  function chipAtivo(chip: ChipTipo): boolean {
    return chip.tipos.some((t) => tiposAtivos.includes(t));
  }

  function alternarTipo(chip: ChipTipo) {
    const ativo = chipAtivo(chip);
    let proximos: string[];
    if (ativo) {
      // Remove todos os tipos do chip
      proximos = tiposAtivos.filter((t) => !chip.tipos.includes(t));
    } else {
      // Adiciona todos os tipos do chip
      const novos = chip.tipos.filter((t) => !tiposAtivos.includes(t));
      proximos = [...tiposAtivos, ...novos];
    }
    const next = buildParams();
    if (proximos.length > 0) next.set("tipos", proximos.join(","));
    if (soProblema) next.set("problema", "1");
    navegar(next);
  }

  function alternarProblema() {
    const next = buildParams();
    if (tiposAtivos.length > 0) next.set("tipos", tiposAtivos.join(","));
    if (!soProblema) next.set("problema", "1");
    navegar(next);
  }

  function limpar() {
    const next = buildParams();
    navegar(next);
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Filtros de alerta"
    >
      {/* Chips de tipo */}
      {CHIPS_TIPO.map((chip) => {
        const ativo = chipAtivo(chip);
        return (
          <button
            key={chip.label}
            type="button"
            aria-pressed={ativo}
            onClick={() => alternarTipo(chip)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl transition-colors cursor-pointer"
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
            {chip.label}
          </button>
        );
      })}

      {/* Separador visual */}
      <div
        style={{
          width: "1px",
          height: "20px",
          backgroundColor: "var(--border)",
          flexShrink: 0,
        }}
      />

      {/* Chip-acao: So com problema */}
      <button
        type="button"
        aria-pressed={soProblema}
        onClick={alternarProblema}
        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl transition-colors cursor-pointer"
        style={
          soProblema
            ? {
                backgroundColor: "color-mix(in srgb, var(--vermelho) 12%, transparent)",
                border: "1px solid var(--vermelho)",
                color: "var(--vermelho)",
              }
            : {
                backgroundColor: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
              }
        }
      >
        So com problema
      </button>

      {/* Limpar filtros */}
      {temFiltro && (
        <button
          type="button"
          onClick={limpar}
          className="inline-flex items-center text-xs font-medium px-2 py-1.5 rounded-xl transition-colors cursor-pointer"
          style={{
            backgroundColor: "transparent",
            border: "1px solid var(--border-subtle, var(--border))",
            color: "var(--text-dim)",
          }}
        >
          Limpar
        </button>
      )}
    </div>
  );
}
