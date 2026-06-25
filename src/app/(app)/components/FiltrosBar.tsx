"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

/* ------------------------------------------------------------------ */
/* Tipos                                                                */
/* ------------------------------------------------------------------ */

interface ChipTipo {
  label: string;
  tipos: string[];
  cor: string;
}

export interface Contagens {
  tipos: Record<string, number>;
  nivel: { critico: number; atencao: number };
}

interface Props {
  contagens: Contagens;
}

/* ------------------------------------------------------------------ */
/* Dados dos chips de tipo                                             */
/* ------------------------------------------------------------------ */

const CHIPS_TIPO: ChipTipo[] = [
  { label: "Panico",         tipos: ["panico"],                        cor: "#ef4444" },
  { label: "Bau",            tipos: ["bau"],                           cor: "#f97316" },
  { label: "Favela",         tipos: ["favela"],                        cor: "#dc2626" },
  { label: "Tiroteio",       tipos: ["tiroteio"],                      cor: "#b91c1c" },
  { label: "Desvio",         tipos: ["desvio"],                        cor: "#f59e0b" },
  { label: "Parada cliente", tipos: ["parada_cliente"],                 cor: "#3b82f6" },
  { label: "Parada anômala", tipos: ["parada_anomala"],                 cor: "#f97316" },
  { label: "Parada longa",   tipos: ["parada_longa"],                   cor: "#64748b" },
  { label: "Jammer/Sinal",   tipos: ["jammer", "sinal", "bloqueio"],   cor: "#a855f7" },
  { label: "Excesso",        tipos: ["excesso"],                        cor: "#ea580c" },
  { label: "Ignicao fora",   tipos: ["ignicao_noturna"],                cor: "#7c3aed" },
  { label: "Saida base",     tipos: ["saida_nao_autorizada"],           cor: "#0891b2" },
];

/* ------------------------------------------------------------------ */
/* Componente                                                           */
/* ------------------------------------------------------------------ */

export default function FiltrosBar({ contagens }: Props) {
  const router    = useRouter();
  const pathname  = usePathname();
  const params    = useSearchParams();

  /* --- ler estado da URL ------------------------------------------ */
  const tiposAtivos  = (params.get("tipos") ?? "").split(",").filter(Boolean);
  const niveisAtivos = (params.get("nivel") ?? "").split(",").filter(Boolean);
  const soProblema   = params.get("problema") === "1";
  const soTurno      = params.get("turno") === "1";
  const temFiltro    = tiposAtivos.length > 0 || niveisAtivos.length > 0 || soProblema || soTurno;

  /* --- helpers de URL -------------------------------------------- */
  function baseParams(): URLSearchParams {
    const p = new URLSearchParams();
    const c = params.get("cliente");
    if (c) p.set("cliente", c);
    return p;
  }

  function ir(p: URLSearchParams) {
    router.push(pathname + "?" + p.toString(), { scroll: false });
  }

  function buildUrl({
    tipos = tiposAtivos,
    niveis = niveisAtivos,
    problema = soProblema,
    turno = soTurno,
  }: { tipos?: string[]; niveis?: string[]; problema?: boolean; turno?: boolean } = {}) {
    const p = baseParams();
    if (tipos.length > 0)  p.set("tipos",    tipos.join(","));
    if (niveis.length > 0) p.set("nivel",    niveis.join(","));
    if (problema)          p.set("problema", "1");
    if (turno)             p.set("turno",    "1");
    return p;
  }

  /* --- handlers --------------------------------------------------- */
  function alternarTipo(chip: ChipTipo) {
    const ativo   = chip.tipos.some((t) => tiposAtivos.includes(t));
    const proximos = ativo
      ? tiposAtivos.filter((t) => !chip.tipos.includes(t))
      : [...tiposAtivos, ...chip.tipos.filter((t) => !tiposAtivos.includes(t))];
    ir(buildUrl({ tipos: proximos }));
  }

  function alternarNivel(n: "critico" | "atencao") {
    const ativo    = niveisAtivos.includes(n);
    const proximos = ativo ? niveisAtivos.filter((x) => x !== n) : [...niveisAtivos, n];
    ir(buildUrl({ niveis: proximos }));
  }

  function alternarProblema() {
    ir(buildUrl({ problema: !soProblema }));
  }

  function alternarTurno() {
    ir(buildUrl({ turno: !soTurno }));
  }

  function limpar() {
    ir(baseParams());
  }

  /* --- utilitarios de render -------------------------------------- */
  function chipTipoAtivo(chip: ChipTipo) {
    return chip.tipos.some((t) => tiposAtivos.includes(t));
  }

  function contTipo(chip: ChipTipo): number {
    return chip.tipos.reduce((s, t) => s + (contagens.tipos[t] ?? 0), 0);
  }

  /* Estilos base */
  const base =
    "inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all cursor-pointer select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent)]";

  const inativo: React.CSSProperties = {
    backgroundColor: "transparent",
    border: "1px solid var(--border)",
    color: "var(--text-muted)",
  };

  function ativoStyle(cor: string): React.CSSProperties {
    return {
      backgroundColor: cor + "22",
      border: `1px solid ${cor}`,
      color: cor,
    };
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label="Filtros"
    >

      {/* ============================================================
          GRUPO 1: Nivel (critico / atencao)
          ============================================================ */}

      <GroupLabel>Nível</GroupLabel>

      <Chip
        base={base}
        style={niveisAtivos.includes("critico") ? ativoStyle("#ef4444") : inativo}
        pressed={niveisAtivos.includes("critico")}
        onClick={() => alternarNivel("critico")}
      >
        Crítico
        <Badge n={contagens.nivel.critico} cor="#ef4444" />
      </Chip>

      <Chip
        base={base}
        style={niveisAtivos.includes("atencao") ? ativoStyle("#f59e0b") : inativo}
        pressed={niveisAtivos.includes("atencao")}
        onClick={() => alternarNivel("atencao")}
      >
        Atenção
        <Badge n={contagens.nivel.atencao} cor="#f59e0b" />
      </Chip>

      <Divider />

      {/* ============================================================
          GRUPO 2: Tipo de alerta
          ============================================================ */}

      <GroupLabel>Tipo</GroupLabel>

      {CHIPS_TIPO.map((chip) => {
        const ativo = chipTipoAtivo(chip);
        const n     = contTipo(chip);
        return (
          <Chip
            key={chip.label}
            base={base}
            style={ativo ? ativoStyle(chip.cor) : inativo}
            pressed={ativo}
            onClick={() => alternarTipo(chip)}
          >
            {chip.label}
            <Badge n={n} cor={ativo ? chip.cor : "#888"} />
          </Chip>
        );
      })}

      <Divider />

      {/* ============================================================
          GRUPO 3: Visao
          ============================================================ */}

      <Chip
        base={base}
        style={
          soTurno
            ? {
                backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)",
                border: "1px solid var(--accent)",
                color: "var(--accent)",
              }
            : inativo
        }
        pressed={soTurno}
        onClick={alternarTurno}
      >
        Turno (8h)
      </Chip>

      <Chip
        base={base}
        style={
          soProblema
            ? {
                backgroundColor: "color-mix(in srgb, var(--vermelho) 12%, transparent)",
                border: "1px solid var(--vermelho)",
                color: "var(--vermelho)",
              }
            : inativo
        }
        pressed={soProblema}
        onClick={alternarProblema}
      >
        Só alertas
      </Chip>

      {/* Limpar */}
      {temFiltro && (
        <button
          type="button"
          onClick={limpar}
          className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg transition-colors cursor-pointer select-none"
          style={{ color: "var(--text-dim)", border: "1px solid transparent" }}
          title="Limpar todos os filtros"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Limpar
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-componentes internos                                            */
/* ------------------------------------------------------------------ */

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-xs uppercase tracking-widest leading-none"
      style={{ color: "var(--text-dim)", fontSize: "9px", letterSpacing: "0.12em", marginRight: "2px" }}
    >
      {children}
    </span>
  );
}

function Divider() {
  return (
    <div
      style={{ width: "1px", height: "20px", backgroundColor: "var(--border)", flexShrink: 0, margin: "0 4px" }}
    />
  );
}

function Chip({
  base,
  style,
  pressed,
  onClick,
  children,
}: {
  base: string;
  style: React.CSSProperties;
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={base} style={style}>
      {children}
    </button>
  );
}

function Badge({ n, cor }: { n: number; cor: string }) {
  if (n === 0) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "999px",
        fontSize: "9px",
        fontWeight: 700,
        lineHeight: 1,
        minWidth: "15px",
        height: "15px",
        padding: "0 3px",
        backgroundColor: cor + "33",
        color: cor,
      }}
    >
      {n}
    </span>
  );
}
