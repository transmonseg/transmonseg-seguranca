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

interface FrotaGridProps {
  itens: FrotaItem[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function formataAtraso(min: number): string {
  if (min < 2)    return "agora";
  if (min < 60)   return `${min}m`;
  const horas = Math.floor(min / 60);
  const resto = min % 60;
  if (horas < 24) return resto > 0 ? `${horas}h${resto}m` : `${horas}h`;
  const dias = Math.floor(horas / 24);
  return `${dias}d`;
}

/* ------------------------------------------------------------------ */
/* Icones SVG inline                                                    */
/* ------------------------------------------------------------------ */

function IconIgnicao({ on }: { on: boolean }) {
  /* Power button icon */
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke={on ? "var(--verde)" : "var(--text-dim)"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label={on ? "Ignicao ligada" : "Ignicao desligada"}
    >
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function IconSemSinal() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--text-dim)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Sem comunicacao"
    >
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

function IconSpeed({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 12l4.35-4.35" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function IconClock({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Card de veiculo                                                       */
/* ------------------------------------------------------------------ */

function CardVeiculo({ item }: { item: FrotaItem }) {
  const offline = item.atraso_min > LIMIAR_SEM_COM_MIN || item.semComunicacao;

  /* Nivel visual efetivo: offline anula nivel de risco */
  const nivelEfetivo: "vermelho" | "amarelo" | "verde" | "offline" =
    offline ? "offline" : item.nivel;

  /* Cores por nivel */
  const corFaixa: Record<typeof nivelEfetivo, string> = {
    vermelho: "var(--vermelho)",
    amarelo:  "var(--amarelo)",
    verde:    "transparent",
    offline:  "var(--border)",
  };

  const bgCard: Record<typeof nivelEfetivo, string> = {
    vermelho: "#160c0c",
    amarelo:  "#15110a",
    verde:    "var(--card)",
    offline:  "var(--card)",
  };

  const corPlaca: Record<typeof nivelEfetivo, string> = {
    vermelho: "var(--text)",
    amarelo:  "var(--text)",
    verde:    "var(--text)",
    offline:  "var(--text-dim)",
  };

  const corMotivo =
    item.nivel === "vermelho" ? "var(--vermelho)" : "var(--amarelo)";

  return (
    <div
      className="group relative rounded-xl border overflow-hidden transition-all duration-150 cursor-default"
      style={{
        backgroundColor: bgCard[nivelEfetivo],
        borderColor: nivelEfetivo === "vermelho"
          ? "color-mix(in srgb, var(--vermelho) 22%, var(--border))"
          : nivelEfetivo === "amarelo"
          ? "color-mix(in srgb, var(--amarelo) 18%, var(--border))"
          : "var(--border)",
        opacity: offline ? 0.6 : 1,
      }}
      onMouseEnter={(e) => {
        if (!offline) (e.currentTarget as HTMLElement).style.borderColor =
          nivelEfetivo === "vermelho" ? "color-mix(in srgb, var(--vermelho) 40%, var(--border))"
          : nivelEfetivo === "amarelo" ? "color-mix(in srgb, var(--amarelo) 35%, var(--border))"
          : "var(--accent)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor =
          nivelEfetivo === "vermelho" ? "color-mix(in srgb, var(--vermelho) 22%, var(--border))"
          : nivelEfetivo === "amarelo" ? "color-mix(in srgb, var(--amarelo) 18%, var(--border))"
          : "var(--border)";
      }}
    >
      {/* Faixa lateral de nivel */}
      <div
        className="absolute top-0 bottom-0 left-0 w-0.5"
        style={{ backgroundColor: corFaixa[nivelEfetivo] }}
      />

      {/* Conteudo */}
      <div className="pl-3 pr-3.5 pt-3 pb-3 flex flex-col gap-2.5">

        {/* Linha 1: placa + badges + status */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <p
              className="num-mono text-sm font-bold tracking-wider leading-none"
              style={{ color: corPlaca[nivelEfetivo], fontFamily: "var(--font-geist-mono, monospace)", letterSpacing: "0.08em" }}
            >
              {item.placa}
            </p>
            <p className="text-xs mt-1 truncate max-w-[100px]" style={{ color: "var(--text-muted)", fontSize: "10px" }}>
              {item.cv}
            </p>
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* Badge panico */}
            {!offline && item.panico && (
              <span
                className="tag animate-pulse-alert"
                style={{ backgroundColor: "color-mix(in srgb, var(--vermelho) 15%, transparent)", color: "var(--vermelho)", border: "1px solid color-mix(in srgb, var(--vermelho) 30%, transparent)", fontFamily: "var(--font-geist-mono, monospace)" }}
              >
                PANICO
              </span>
            )}
            {/* Badge bau aberto */}
            {!offline && item.bau_aberto && (
              <span
                className="tag"
                style={{ backgroundColor: "color-mix(in srgb, var(--amarelo) 12%, transparent)", color: "var(--amarelo)", border: "1px solid color-mix(in srgb, var(--amarelo) 25%, transparent)", fontFamily: "var(--font-geist-mono, monospace)" }}
              >
                BAU
              </span>
            )}
            {/* Icone de status */}
            {offline ? <IconSemSinal /> : <IconIgnicao on={item.ignicao} />}
          </div>
        </div>

        {/* Linha 2: estado / motivo */}
        {offline ? (
          <p
            className="text-xs"
            style={{ color: "var(--text-dim)", fontSize: "10px" }}
          >
            sem sinal ha {formataAtraso(item.atraso_min)}
          </p>
        ) : item.motivo ? (
          <p
            className="text-xs rounded px-2 py-1 leading-snug"
            style={{ backgroundColor: `color-mix(in srgb, ${corMotivo} 10%, transparent)`, color: corMotivo, fontSize: "10px" }}
          >
            {item.motivo}
          </p>
        ) : (
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: item.ignicao ? "var(--verde)" : "var(--text-dim)" }}
            />
            <p
              className="text-xs"
              style={{ color: item.ignicao ? "var(--verde)" : "var(--text-muted)", fontSize: "10px" }}
            >
              {item.ignicao ? "Em circulacao" : "Parado"}
            </p>
          </div>
        )}

        {/* Linha 3: metricas */}
        <div
          className="grid grid-cols-2 gap-1.5 pt-0.5 border-t"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          {/* Velocidade */}
          <div className="flex flex-col gap-0.5">
            <span
              className="flex items-center gap-1"
              style={{ color: "var(--text-dim)", fontSize: "9px", letterSpacing: "0.05em" }}
            >
              <IconSpeed />
              vel.
            </span>
            <span
              className="num-mono text-xs font-semibold"
              style={{ color: offline ? "var(--text-dim)" : "var(--text)", fontFamily: "var(--font-geist-mono, monospace)" }}
            >
              {item.velocidade} km/h
            </span>
          </div>

          {/* Atraso */}
          <div className="flex flex-col gap-0.5">
            <span
              className="flex items-center gap-1"
              style={{ color: "var(--text-dim)", fontSize: "9px", letterSpacing: "0.05em" }}
            >
              <IconClock />
              atraso
            </span>
            <span
              className="num-mono text-xs font-semibold"
              style={{
                color: offline
                  ? "var(--text-dim)"
                  : item.atraso_min > 15
                  ? "var(--amarelo)"
                  : "var(--text)",
                fontFamily: "var(--font-geist-mono, monospace)",
              }}
            >
              {formataAtraso(item.atraso_min)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tipos de filtro por nivel                                            */
/* ------------------------------------------------------------------ */

type FiltroNivel = "todos" | "alerta" | "atencao" | "em-rota";

const FILTROS: { id: FiltroNivel; label: string }[] = [
  { id: "todos",   label: "Todos" },
  { id: "alerta",  label: "Alerta" },
  { id: "atencao", label: "Atencao" },
  { id: "em-rota", label: "Em rota" },
];

/* ------------------------------------------------------------------ */
/* Grid principal com filtro por nivel                                  */
/* ------------------------------------------------------------------ */

export default function FrotaGrid({ itens }: FrotaGridProps) {
  const [filtroNivel, setFiltroNivel] = useState<FiltroNivel>("todos");

  const itensFiltrados = itens.filter((i) => {
    const offline = i.atraso_min > LIMIAR_SEM_COM_MIN || i.semComunicacao;
    if (filtroNivel === "alerta")  return !offline && i.nivel === "vermelho";
    if (filtroNivel === "atencao") return !offline && i.nivel === "amarelo";
    if (filtroNivel === "em-rota") return !offline && i.ignicao;
    return true;
  });

  const itensOrdenados = [...itensFiltrados].sort((a, b) => {
    const aOffline = a.atraso_min > LIMIAR_SEM_COM_MIN || a.semComunicacao;
    const bOffline = b.atraso_min > LIMIAR_SEM_COM_MIN || b.semComunicacao;

    if (aOffline && !bOffline) return 1;
    if (!aOffline && bOffline) return -1;

    const ordemNivel: Record<NivelRisco, number> = { vermelho: 0, amarelo: 1, verde: 2 };
    return ordemNivel[a.nivel] - ordemNivel[b.nivel];
  });

  const totalOffline = itens.filter(
    (i) => i.atraso_min > LIMIAR_SEM_COM_MIN || i.semComunicacao
  ).length;

  const totalVermelho = itens.filter(
    (i) => !(i.atraso_min > LIMIAR_SEM_COM_MIN || i.semComunicacao) && i.nivel === "vermelho"
  ).length;

  return (
    <div className="space-y-5">
      {/* Filtro por nivel: segmented control */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div
          className="inline-flex rounded-lg p-0.5 gap-0.5"
          style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
        >
          {FILTROS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFiltroNivel(f.id)}
              className="rounded-md text-xs font-medium transition-all duration-150 cursor-pointer"
              style={
                filtroNivel === f.id
                  ? {
                      padding: "5px 14px",
                      backgroundColor: "var(--accent-dim)",
                      color: "var(--accent)",
                      border: "none",
                      outline: "none",
                    }
                  : {
                      padding: "5px 14px",
                      backgroundColor: "transparent",
                      color: "var(--text-muted)",
                      border: "none",
                      outline: "none",
                    }
              }
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Contadores inline */}
        <div className="flex items-center gap-3 text-xs" style={{ color: "var(--text-muted)" }}>
          <span className="num-mono" style={{ fontFamily: "var(--font-geist-mono, monospace)" }}>
            {itensFiltrados.length} veiculos
          </span>
          {totalVermelho > 0 && (
            <span className="num-mono font-semibold" style={{ color: "var(--vermelho)", fontFamily: "var(--font-geist-mono, monospace)" }}>
              {totalVermelho} criticos
            </span>
          )}
          {totalOffline > 0 && (
            <span className="num-mono" style={{ color: "var(--text-dim)", fontFamily: "var(--font-geist-mono, monospace)" }}>
              {totalOffline} offline
            </span>
          )}
        </div>
      </div>

      {/* Grid de cards */}
      {itensOrdenados.length === 0 ? (
        <div
          className="flex items-center justify-center py-16 rounded-xl border text-sm"
          style={{ backgroundColor: "var(--card)", borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          Nenhum veiculo neste filtro.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {itensOrdenados.map((item) => (
            <CardVeiculo key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
