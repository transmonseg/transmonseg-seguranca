/**
 * Pagina principal -- Transmonseg Central
 *
 * Server Component que le dados do Supabase via createAdminClient (service_role).
 * O cliente ativo e determinado pelo query param ?cliente=<cod_user_unitrac>.
 * Toda a tela reflete somente o cliente selecionado.
 *
 * VISUAL: Painel de dois paineis em desktop (alertas | mapa), coluna unica em mobile.
 */

import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import CardVeiculoOperacao from "./components/CardVeiculoOperacao";
import FaixaColapsavel from "./components/FaixaColapsavel";
import VerTodosBtn from "./components/VerTodosBtn";
import MapaWrapper from "./components/MapaWrapper";
import AcoesAlerta from "./components/AcoesAlerta";
import PainelRoubo from "./components/PainelRoubo";
import AlertaSonoro from "./components/AlertaSonoro";
import FiltrosBar from "./components/FiltrosBar";

// Central ao vivo: nunca prerender estatico.
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* Tipos                                                                */
/* ------------------------------------------------------------------ */

type NivelDB = "verde" | "amarelo" | "vermelho" | "cinza" | "concluido";

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

interface PosicaoAtual {
  veiculo_id: string;
  lat: number | null;
  lng: number | null;
  velocidade: number;
  ignicao: boolean;
  atraso_min: number;
  panico: boolean;
  bau_aberto: boolean;
  nivel: NivelDB;
  motivo: string | null;
  local: string | null;
  entregas_feitas: number | null;
  entregas_total: number | null;
  parado_desde: string | null;
  updated_at: string;
}

interface Alerta {
  id: string;
  cliente_id: string;
  veiculo_id: string;
  nivel: "critico" | "atencao";
  tipo: string;
  motivo: string | null;
  desde: string;
  status: string;
  score: number | null;
}

/* Item de veiculo enriquecido para render */
export interface VeiculoItem {
  id: string;
  placa: string;
  cv: string;
  grupo?: string | null;
  lat: number | null;
  lng: number | null;
  nivel: NivelDB;
  motivo: string | null;
  velocidade: number;
  ignicao: boolean;
  atraso_min: number;
  panico: boolean;
  bau_aberto: boolean;
  local: string | null;
  entregas_feitas: number;
  entregas_total: number;
  parado_desde: string | null;
  updated_at: string | null;
}

/* ------------------------------------------------------------------ */
/* TAREFA A: Ordem de severidade dos alertas                           */
/* Menor numero = mais severo = aparece primeiro.                      */
/* Sinais (jammer/sinal/bloqueio) ficam por ultimo na fila.           */
/* ------------------------------------------------------------------ */

function ordemSeveridade(tipo: string): number {
  const t = tipo?.toLowerCase() ?? "";
  if (t.includes("panico")) return 0;
  if (t.includes("bau")) return 1;
  if (t.includes("favela")) return 2;
  if (t.includes("tiroteio")) return 3;
  if (t.includes("parada_cliente") || t === "parada_cliente") return 4;
  if (t.includes("parada_anomala") || t === "parada_anomala") return 5;
  if (t.includes("parada_longa") || t === "parada_longa") return 6;
  if (t.includes("desvio")) return 7;
  if (t.includes("excesso")) return 7;
  if (t.includes("jammer") || t.includes("sinal") || t.includes("bloqueio")) return 9;
  return 8;
}

/* ------------------------------------------------------------------ */
/* Helpers de formatacao                                                */
/* ------------------------------------------------------------------ */

function formatarTempoRelativo(iso: string): string {
  const data = new Date(iso);
  const agora = new Date();
  const diffMin = Math.floor((agora.getTime() - data.getTime()) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

/* ------------------------------------------------------------------ */
/* Icones SVG                                                            */
/* ------------------------------------------------------------------ */

function IconShield({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconTruck({ size = 16 }: { size?: number }) {
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

function IconMapPin({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconClock({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconAlertCircle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconCheck({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconNoSignal({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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

function IconPackage({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconJammer({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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

function IconPause({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function IconChevronRight({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconDesvio({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22V12" />
      <path d="M12 12C12 8 12 6 6 4" />
      <path d="M12 12c0-3 1-5 6-7" />
      <polyline points="16 3 18 5 16 7" />
    </svg>
  );
}

/* Icone de predio/loja para parada_cliente */
function IconLoja({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Tiroteio                                                              */
/* ------------------------------------------------------------------ */

function IconTiroteio({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="1" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="1" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="23" y2="12" />
    </svg>
  );
}

/* TAREFA B: icone para parada_cliente adicionado */
function IconTipoAlerta({ tipo, size = 16 }: { tipo: string; size?: number }) {
  const t = tipo?.toLowerCase() ?? "";
  if (t.includes("tiroteio") || t.includes("operacao") || t.includes("operacao")) {
    return <IconTiroteio size={size} />;
  }
  if (t.includes("jammer") || t.includes("sinal") || t.includes("bloqueio")) {
    return <IconJammer size={size} />;
  }
  if (t.includes("favela") || t.includes("area") || t.includes("risco") || t.includes("zona")) {
    return <IconMapPin size={size} />;
  }
  if (t.includes("cliente") || t.includes("loja")) {
    return <IconLoja size={size} />;
  }
  if (t.includes("parada") || t.includes("parado") || t.includes("longa")) {
    return <IconPause size={size} />;
  }
  if (t.includes("desvio") || t.includes("rota") || t.includes("fora")) {
    return <IconDesvio size={size} />;
  }
  return <IconAlertCircle size={size} />;
}

/* ------------------------------------------------------------------ */
/* Seletor de cliente                                                   */
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
            href={`?cliente=${c.cod_user_unitrac}`}
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
/* Metrica grande                                                       */
/* ------------------------------------------------------------------ */

function MetricaGrande({
  label,
  valor,
  sublabel,
  cor,
  compacto,
}: {
  label: string;
  valor: string | number;
  sublabel?: string;
  cor?: string;
  compacto?: boolean;
}) {
  const corEfetiva = cor ?? "var(--text)";
  return (
    <div className="flex flex-col gap-3">
      <p
        className="num-mono font-bold leading-none"
        style={{
          color: corEfetiva,
          fontFamily: "var(--font-geist-mono, monospace)",
          fontSize: compacto ? "clamp(1.75rem, 3.5vw, 2.5rem)" : "clamp(2.5rem, 5vw, 3.75rem)",
          wordBreak: "break-all",
        }}
      >
        {valor}
      </p>
      <div>
        <p className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
          {label}
        </p>
        {sublabel && (
          <p className="text-xs mt-0.5" style={{ color: "var(--text-dim)" }}>
            {sublabel}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card de alerta -- versao compacta para coluna de alertas            */
/* ------------------------------------------------------------------ */

function IconExternal({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function CardAlertaCritico({
  id,
  status,
  nivel,
  tipo,
  placa,
  motivo,
  local,
  desde,
  lat,
  lng,
  velocidade,
  ignicao,
  atraso_min,
  score,
}: {
  id: string;
  status: string;
  nivel: "critico" | "atencao";
  tipo: string;
  placa: string;
  motivo: string | null;
  local: string | null;
  desde: string;
  lat?: number | null;
  lng?: number | null;
  velocidade?: number | null;
  ignicao?: boolean | null;
  atraso_min?: number | null;
  score?: number | null;
}) {
  const corNivel = nivel === "critico" ? "var(--vermelho)" : "var(--amarelo)";
  const bgNivel = nivel === "critico" ? "#160c0c" : "#16120a";
  const temCoordenadas = lat != null && lng != null;
  const urlMapa = temCoordenadas ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  return (
    <div
      className="relative rounded-xl border overflow-hidden"
      style={{
        backgroundColor: bgNivel,
        borderColor: `color-mix(in srgb, ${corNivel} 30%, var(--border))`,
      }}
    >
      {/* Faixa lateral de acento */}
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ width: "3px", backgroundColor: corNivel, opacity: 0.8 }}
      />

      <div style={{ padding: "1rem 1rem 1rem 1.25rem" }}>

        {/* CABECALHO: badge tipo + tempo */}
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest px-2 py-1 rounded-md"
              style={{
                backgroundColor: `color-mix(in srgb, ${corNivel} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${corNivel} 25%, transparent)`,
                color: corNivel,
                letterSpacing: "0.09em",
                fontSize: "10px",
              }}
            >
              <span style={{ color: corNivel, opacity: 0.9 }}>
                <IconTipoAlerta tipo={tipo} size={10} />
              </span>
              {tipo}
            </span>
            {score != null && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 5,
                  backgroundColor:
                    score >= 80 ? "#ef444418" : score >= 50 ? "#f9731618" : "#f59e0b18",
                  border: `1px solid ${score >= 80 ? "#ef444444" : score >= 50 ? "#f9731644" : "#f59e0b44"}`,
                  color:
                    score >= 80 ? "#ef4444" : score >= 50 ? "#f97316" : "#f59e0b",
                  fontFamily: "var(--font-geist-mono, monospace)",
                }}
              >
                {score}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0" style={{ color: "var(--text-dim)" }}>
            <IconClock size={11} />
            <span className="num-mono text-xs" style={{ fontFamily: "var(--font-geist-mono, monospace)" }}>
              {formatarTempoRelativo(desde)}
            </span>
          </div>
        </div>

        {/* PLACA + badge nivel */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <p
            className="num-mono font-bold leading-none"
            style={{
              color: "var(--text)",
              fontFamily: "var(--font-geist-mono, monospace)",
              fontSize: "1.2rem",
              letterSpacing: "0.12em",
            }}
          >
            {placa}
          </p>
          <span
            className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
            style={{
              backgroundColor: `color-mix(in srgb, ${corNivel} 10%, transparent)`,
              color: corNivel,
              border: `1px solid color-mix(in srgb, ${corNivel} 20%, transparent)`,
              fontSize: "9px",
              letterSpacing: "0.06em",
            }}
          >
            {nivel === "critico" ? "CRÍTICO" : "ATENÇÃO"}
          </span>
        </div>

        {/* MOTIVO */}
        {motivo && (
          <div
            className="rounded-lg px-2.5 py-2 mb-2.5"
            style={{
              backgroundColor: `color-mix(in srgb, ${corNivel} 7%, transparent)`,
              border: `1px solid color-mix(in srgb, ${corNivel} 16%, transparent)`,
            }}
          >
            <p className="text-xs leading-relaxed" style={{ color: corNivel, opacity: 0.9 }}>
              {motivo}
            </p>
          </div>
        )}

        {/* DIVISOR */}
        <div style={{ height: "1px", backgroundColor: "var(--border-subtle)", marginBottom: "0.625rem" }} />

        {/* LOCALIZACAO */}
        <div className="mb-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-1.5 min-w-0">
              <span className="flex-shrink-0 mt-0.5" style={{ color: "var(--text-dim)" }}>
                <IconMapPin size={11} />
              </span>
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                {local ?? "Sem endereco disponivel"}
              </p>
            </div>
            {urlMapa && (
              <a
                href={urlMapa}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                style={{
                  backgroundColor: "var(--accent-dim)",
                  border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                  color: "var(--accent)",
                  textDecoration: "none",
                  fontSize: "10px",
                  whiteSpace: "nowrap",
                }}
              >
                <IconMapPin size={10} />
                Ver
                <IconExternal size={9} />
              </a>
            )}
          </div>
        </div>

        {/* TELEMETRIA */}
        {(velocidade != null || ignicao != null || (atraso_min != null && atraso_min > 0)) && (
          <>
            <div style={{ height: "1px", backgroundColor: "var(--border-subtle)", marginBottom: "0.625rem" }} />
            <div className="grid grid-cols-2" style={{ gap: "0.375rem" }}>
              {velocidade != null && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>velocidade</span>
                  <p className="num-mono text-xs font-semibold mt-0.5" style={{ fontFamily: "var(--font-geist-mono, monospace)", color: velocidade > 0 ? "var(--accent)" : "var(--text-muted)" }}>
                    {velocidade} km/h
                  </p>
                </div>
              )}
              {ignicao != null && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>ignicao</span>
                  <p className="text-xs font-semibold mt-0.5" style={{ color: ignicao ? "var(--verde)" : "var(--text-dim)" }}>
                    {ignicao ? "ligada" : "desligada"}
                  </p>
                </div>
              )}
              {atraso_min != null && atraso_min > 0 && (
                <div>
                  <span className="text-xs" style={{ color: "var(--text-dim)", fontSize: "10px" }}>sem comunicacao</span>
                  <p className="num-mono text-xs font-semibold mt-0.5" style={{ fontFamily: "var(--font-geist-mono, monospace)", color: "var(--text-muted)" }}>
                    {atraso_min < 60 ? `${atraso_min}min` : `${Math.floor(atraso_min / 60)}h${atraso_min % 60 > 0 ? `${atraso_min % 60}min` : ""}`}
                  </p>
                </div>
              )}
            </div>
          </>
        )}

        {/* Acoes do operador */}
        <AcoesAlerta id={id} status={status} desde={desde} />

      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Separador de secao                                                   */
/* ------------------------------------------------------------------ */

function SectionDivider({ label, cor, count }: { label: string; cor?: string; count?: number }) {
  return (
    <div className="flex items-center gap-4">
      {cor && (
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: cor }}
        />
      )}
      <h2
        className="text-xs font-semibold uppercase tracking-widest whitespace-nowrap"
        style={{ color: "var(--text-muted)", letterSpacing: "0.14em" }}
      >
        {label}
        {count !== undefined && (
          <span
            className="num-mono ml-3 font-bold"
            style={{
              fontFamily: "var(--font-geist-mono, monospace)",
              color: cor ?? "var(--text-muted)",
              fontSize: "0.85rem",
            }}
          >
            {count}
          </span>
        )}
      </h2>
      <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bloco de metricas compacto para a coluna direita                    */
/* ------------------------------------------------------------------ */

function BlocoMetricas({
  totalOperando,
  totalCriticos,
  entregasFeitas,
  entregasTotal,
}: {
  totalOperando: number;
  totalCriticos: number;
  entregasFeitas: number;
  entregasTotal: number;
}) {
  return (
    <div
      className="grid grid-cols-3"
      style={{
        gap: "0",
        borderRadius: "0.875rem",
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      {/* Operando */}
      <div
        style={{
          padding: "1.125rem 1rem",
          borderRight: "1px solid var(--border)",
          backgroundColor: "var(--card)",
        }}
      >
        <MetricaGrande label="operando" valor={totalOperando} compacto />
      </div>

      {/* Criticos */}
      <div
        style={{
          padding: "1.125rem 1rem",
          borderRight: "1px solid var(--border)",
          backgroundColor: totalCriticos > 0 ? "#130909" : "var(--card)",
        }}
      >
        <MetricaGrande
          label="critico"
          valor={totalCriticos}
          cor={totalCriticos > 0 ? "var(--vermelho)" : "var(--text-dim)"}
          compacto
        />
      </div>

      {/* Entregas */}
      <div
        style={{
          padding: "1.125rem 1rem",
          backgroundColor: "var(--card)",
        }}
      >
        {entregasTotal > 0 ? (
          <div className="flex flex-col gap-2">
            <MetricaGrande
              label="entregas"
              valor={`${entregasFeitas}/${entregasTotal}`}
              cor="var(--accent)"
              compacto
            />
            <div style={{ height: "2px", borderRadius: "2px", backgroundColor: "var(--border-subtle)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, Math.round((entregasFeitas / entregasTotal) * 100))}%`,
                  backgroundColor: "var(--verde)",
                  borderRadius: "2px",
                  transition: "width 0.5s ease",
                }}
              />
            </div>
          </div>
        ) : (
          <MetricaGrande label="entregas" valor="--" sublabel="sem dados" cor="var(--text-dim)" compacto />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pagina principal                                                      */
/* ------------------------------------------------------------------ */

const LIMITE_CARDS_OPERACAO = 12;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { cliente: clienteParam, tipos: tiposParam, problema: problemaParam, nivel: nivelParam } = await searchParams;
  const supabase = createAdminClient();

  // Expandir tipos selecionados: o chip "Jammer/Sinal" abrange jammer, sinal e bloqueio.
  const tiposRaw = typeof tiposParam === "string" ? tiposParam : "";
  const tiposChips = tiposRaw ? tiposRaw.split(",").filter(Boolean) : [];
  const GRUPO_JAMMER = ["jammer", "sinal", "bloqueio"];
  const tiposSelecionados = tiposChips.flatMap((t) =>
    GRUPO_JAMMER.includes(t) ? GRUPO_JAMMER : [t]
  );
  const tiposSelecionadosSet = [...new Set(tiposSelecionados)];

  const soProblema = problemaParam === "1";

  // Nivel selecionado pelo filtro ("critico" / "atencao" / ambos / nenhum)
  const nivelRaw = typeof nivelParam === "string" ? nivelParam : "";
  const niveisAtivos = nivelRaw ? nivelRaw.split(",").filter(Boolean) : [];

  const [
    { data: clientesRaw },
    { data: veiculosRaw },
    { data: posicoesRaw },
    { data: alertasRaw },
  ] = await Promise.all([
    supabase.from("clientes").select("id, nome, cod_user_unitrac").order("cod_user_unitrac"),
    supabase.from("veiculos").select("id, cliente_id, placa, cv"),
    supabase.from("posicoes_atuais").select(
      "veiculo_id, lat, lng, velocidade, ignicao, atraso_min, panico, bau_aberto, nivel, motivo, local, entregas_feitas, entregas_total, parado_desde, updated_at"
    ),
    supabase
      .from("alertas")
      .select("id, cliente_id, veiculo_id, nivel, tipo, motivo, desde, status, score")
      .in("status", ["ativo", "reconhecido"]),
  ]);

  const clientes: Cliente[] = clientesRaw ?? [];
  const todosVeiculos: Veiculo[] = veiculosRaw ?? [];
  const todasPosicoes: PosicaoAtual[] = (posicoesRaw ?? []) as PosicaoAtual[];
  const todosAlertas: Alerta[] = (alertasRaw ?? []) as Alerta[];

  // Determinar cliente ativo
  const codParam = typeof clienteParam === "string" ? clienteParam : undefined;
  const clienteAtivo: Cliente =
    (codParam && clientes.find((c) => c.cod_user_unitrac === codParam)) ||
    clientes[0];

  const veiculosPorCliente: Record<string, number> = {};
  for (const c of clientes) {
    veiculosPorCliente[c.id] = todosVeiculos.filter((v) => v.cliente_id === c.id).length;
  }

  // Filtrar para cliente ativo
  const veiculos = todosVeiculos.filter((v) => v.cliente_id === clienteAtivo.id);
  const veiculoIds = new Set(veiculos.map((v) => v.id));

  const posicaoPorVeiculo = new Map(
    todasPosicoes
      .filter((p) => veiculoIds.has(p.veiculo_id))
      .map((p) => [p.veiculo_id, p])
  );

  const alertas = todosAlertas.filter((a) => a.cliente_id === clienteAtivo.id);
  const veiculoById = new Map(veiculos.map((v) => [v.id, v]));

  // Construir itens enriquecidos
  const todosItens: VeiculoItem[] = veiculos.map((v) => {
    const pos = posicaoPorVeiculo.get(v.id);
    return {
      id: v.id,
      placa: v.placa,
      cv: v.cv,
      grupo: null,
      lat: pos?.lat ?? null,
      lng: pos?.lng ?? null,
      nivel: (pos?.nivel ?? "cinza") as NivelDB,
      motivo: pos?.motivo ?? null,
      velocidade: pos?.velocidade ?? 0,
      ignicao: pos?.ignicao ?? false,
      atraso_min: pos?.atraso_min ?? 9999,
      panico: pos?.panico ?? false,
      bau_aberto: pos?.bau_aberto ?? false,
      local: pos?.local ?? null,
      entregas_feitas: pos?.entregas_feitas ?? 0,
      entregas_total: pos?.entregas_total ?? 0,
      parado_desde: pos?.parado_desde ?? null,
      updated_at: pos?.updated_at ?? null,
    };
  });

  // Separar por nivel
  const emOperacaoRaw = todosItens
    .filter((i) => i.nivel === "verde")
    .sort((a, b) => {
      const aMovendo = a.velocidade > 0 ? 0 : 1;
      const bMovendo = b.velocidade > 0 ? 0 : 1;
      if (aMovendo !== bMovendo) return aMovendo - bMovendo;
      const aPendentes = a.entregas_total - a.entregas_feitas;
      const bPendentes = b.entregas_total - b.entregas_feitas;
      return bPendentes - aPendentes;
    });

  const emOperacaoVisiveis = emOperacaoRaw.slice(0, LIMITE_CARDS_OPERACAO);
  const emOperacaoOcultos = emOperacaoRaw.slice(LIMITE_CARDS_OPERACAO);

  const concluidos = todosItens.filter((i) => i.nivel === "concluido");
  const semComunicacao = todosItens.filter((i) => i.nivel === "cinza");

  // Metricas
  const totalOperando = emOperacaoRaw.length;
  const totalCriticos = todosItens.filter((i) => i.nivel === "vermelho").length;
  const totalConcluidos = concluidos.length;
  const totalSemCom = semComunicacao.length;

  // Entregas do dia
  const entregasFeitas = todosItens.reduce((s, i) => s + i.entregas_feitas, 0);
  const entregasTotal = todosItens.reduce((s, i) => s + i.entregas_total, 0);

  // Helper para checar se um tipo de alerta casa com os tipos selecionados pelo filtro.
  // O grupo jammer/sinal/bloqueio ja foi expandido em tiposSelecionadosSet acima.
  function tiposMatch(tipo: string): boolean {
    if (tiposSelecionadosSet.length === 0) return true;
    return tiposSelecionadosSet.includes(tipo?.toLowerCase() ?? "");
  }

  // TAREFA A: Alertas criticos ordenados por severidade + filtro de tipo (se ativo)
  const alertasCriticos = alertas
    .filter((a) => a.nivel === "critico")
    .map((a) => {
      const veiculo = veiculoById.get(a.veiculo_id);
      const pos = posicaoPorVeiculo.get(a.veiculo_id);
      return {
        ...a,
        placa: veiculo?.placa ?? "?????",
        local: pos?.local ?? null,
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        velocidade: pos?.velocidade ?? null,
        ignicao: pos?.ignicao ?? null,
        atraso_min: pos?.atraso_min ?? null,
      };
    })
    .filter((a) => tiposMatch(a.tipo))
    .sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo));

  // TAREFA A: Alertas atencao ordenados por severidade + filtro de tipo (se ativo)
  const alertasAtencao = alertas
    .filter((a) => a.nivel === "atencao")
    .map((a) => {
      const veiculo = veiculoById.get(a.veiculo_id);
      const pos = posicaoPorVeiculo.get(a.veiculo_id);
      return {
        ...a,
        placa: veiculo?.placa ?? "?????",
        local: pos?.local ?? null,
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        velocidade: pos?.velocidade ?? null,
        ignicao: pos?.ignicao ?? null,
        atraso_min: pos?.atraso_min ?? null,
      };
    })
    .filter((a) => tiposMatch(a.tipo))
    .sort((a, b) => ordemSeveridade(a.tipo) - ordemSeveridade(b.tipo));

  // TAREFA B: ids que devem apitar = todos os criticos + atencao do tipo parada_cliente
  const idsParaApitar = [
    ...alertasCriticos.map((a) => a.id),
    ...alertasAtencao
      .filter((a) => a.tipo === "parada_cliente")
      .map((a) => a.id),
  ];

  // Contagens para os badges dos chips da FiltrosBar (usa todos os alertas do cliente, sem filtros)
  const contagensTipos: Record<string, number> = {};
  for (const a of alertas) {
    const t = a.tipo ?? "outro";
    contagensTipos[t] = (contagensTipos[t] ?? 0) + 1;
  }
  // jammer agrupa sinal/bloqueio
  const jammerTotal = (contagensTipos["jammer"] ?? 0) + (contagensTipos["sinal"] ?? 0) + (contagensTipos["bloqueio"] ?? 0);
  if (jammerTotal > 0) contagensTipos["jammer"] = jammerTotal;

  const contagensNivel = {
    critico: alertas.filter((a) => a.nivel === "critico").length,
    atencao: alertas.filter((a) => a.nivel === "atencao").length,
  };

  // Visibilidade das secoes por filtro de nivel
  const mostrarCriticos = niveisAtivos.length === 0 || niveisAtivos.includes("critico");
  const mostrarAtencao  = niveisAtivos.length === 0 || niveisAtivos.includes("atencao");

  /* --------------------------------------------------------------- */
  /* Render: layout dois paineis em lg+, coluna unica em mobile       */
  /* --------------------------------------------------------------- */

  return (
    <div
      style={{ maxWidth: "1600px", margin: "0 auto", padding: "1.5rem 1.5rem 4rem" }}
    >

      {/* ============================================================
          1. SELETOR DE CLIENTE + APITO (topo, largura total)
          ============================================================ */}
      <section
        aria-label="Selecionar cliente"
        style={{ marginBottom: "1.5rem" }}
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2" style={{ color: "var(--text-dim)" }}>
              <IconShield size={11} />
              <span
                className="text-xs uppercase tracking-widest"
                style={{ letterSpacing: "0.14em", color: "var(--text-dim)" }}
              >
                Cliente
              </span>
            </div>
            <SeletorCliente
              clientes={clientes}
              clienteAtualId={clienteAtivo.id}
              veiculosPorCliente={veiculosPorCliente}
            />
          </div>
          {/* TAREFA B: AlertaSonoro com idsParaApitar */}
          <AlertaSonoro idsParaApitar={idsParaApitar} />
        </div>

        {/* Barra de filtros */}
        <div style={{ marginTop: "1rem" }}>
          <FiltrosBar contagens={{ tipos: contagensTipos, nivel: contagensNivel }} />
        </div>
      </section>

      {/* ============================================================
          TAREFA C: LAYOUT DOIS PAINEIS
          - lg+: [coluna alertas ~43%] [coluna mapa+metricas sticky ~57%]
          - mobile: coluna unica empilhada
          ============================================================ */}
      <div
        className="flex flex-col lg:flex-row"
        style={{ gap: "1.25rem", alignItems: "flex-start" }}
      >

        {/* ========================================================
            COLUNA ESQUERDA: fila de alertas (rolavel)
            ======================================================== */}
        <div
          className="w-full min-w-0"
          style={{ flex: "0 0 43%", maxWidth: "100%" }}
        >

          {/* CRITICOS */}
          {mostrarCriticos && (
          <section aria-label="Alertas críticos" style={{ marginBottom: "1.5rem" }}>
            <SectionDivider
              label="Crítico"
              cor={alertasCriticos.length > 0 ? "var(--vermelho)" : undefined}
              count={alertasCriticos.length}
            />

            <div style={{ marginTop: "0.875rem" }}>
              {alertasCriticos.length === 0 ? (
                <div
                  className="flex items-center gap-4 rounded-xl"
                  style={{
                    padding: "1.25rem 1.5rem",
                    backgroundColor: "#141414",
                    border: "1px solid #242424",
                  }}
                >
                  <span
                    className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
                    style={{ backgroundColor: "color-mix(in srgb, var(--verde) 10%, transparent)", color: "var(--verde)" }}
                  >
                    <IconCheck size={13} />
                  </span>
                  <p className="text-sm" style={{ color: "var(--text-dim)" }}>
                    Nenhuma ocorrência crítica no momento.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col" style={{ gap: "0.75rem" }}>
                  {alertasCriticos.map((a) => (
                    <CardAlertaCritico
                      key={a.id}
                      id={a.id}
                      status={a.status}
                      nivel={a.nivel}
                      tipo={a.tipo}
                      placa={a.placa}
                      motivo={a.motivo}
                      local={a.local}
                      desde={a.desde}
                      lat={a.lat}
                      lng={a.lng}
                      velocidade={a.velocidade}
                      ignicao={a.ignicao}
                      atraso_min={a.atraso_min}
                      score={a.score}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
          )}

          {/* ATENCAO */}
          {mostrarAtencao && (
          <section aria-label="Veículos em atenção" style={{ marginBottom: "1.5rem" }}>
            <SectionDivider
              label="Atenção"
              cor={alertasAtencao.length > 0 ? "var(--amarelo)" : undefined}
              count={alertasAtencao.length}
            />
            <div style={{ marginTop: "0.875rem" }}>
              {alertasAtencao.length === 0 ? (
                <div
                  className="flex items-center gap-4 rounded-xl"
                  style={{ padding: "1.25rem 1.5rem", backgroundColor: "#141414", border: "1px solid #242424" }}
                >
                  <span
                    className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
                    style={{ backgroundColor: "color-mix(in srgb, var(--verde) 10%, transparent)", color: "var(--verde)" }}
                  >
                    <IconCheck size={13} />
                  </span>
                  <p className="text-sm" style={{ color: "var(--text-dim)" }}>
                    Nada em atenção no momento.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col" style={{ gap: "0.75rem" }}>
                  {alertasAtencao.map((a) => (
                    <CardAlertaCritico
                      key={a.id}
                      id={a.id}
                      status={a.status}
                      nivel={a.nivel}
                      tipo={a.tipo}
                      placa={a.placa}
                      motivo={a.motivo}
                      local={a.local}
                      desde={a.desde}
                      lat={a.lat}
                      lng={a.lng}
                      velocidade={a.velocidade}
                      ignicao={a.ignicao}
                      atraso_min={a.atraso_min}
                      score={a.score}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
          )}

          {/* EM OPERACAO — ocultado quando "So com problema" esta ativo (nao e problema) */}
          {!soProblema && (
            <section aria-label="Veículos em operação" style={{ marginBottom: "1.5rem" }}>
              <SectionDivider
                label="Em operação"
                cor="var(--verde)"
                count={totalOperando}
              />

              <div style={{ marginTop: "0.875rem" }}>
                {totalOperando === 0 ? (
                  <div
                    className="flex items-center justify-center rounded-xl"
                    style={{
                      padding: "2rem",
                      backgroundColor: "var(--card)",
                      border: "1px solid var(--border)",
                      color: "var(--text-dim)",
                    }}
                  >
                    <p className="text-sm">Nenhum veículo em operação no momento.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col" style={{ gap: "0.75rem" }}>
                      {emOperacaoVisiveis.map((item) => (
                        <CardVeiculoOperacao key={item.id} item={item} />
                      ))}
                    </div>

                    {emOperacaoOcultos.length > 0 && (
                      <VerTodosBtn totalOcultos={emOperacaoOcultos.length}>
                        <div className="flex flex-col" style={{ gap: "0.75rem", marginTop: "0.75rem" }}>
                          {emOperacaoOcultos.map((item) => (
                            <CardVeiculoOperacao key={item.id} item={item} />
                          ))}
                        </div>
                      </VerTodosBtn>
                    )}
                  </>
                )}
              </div>
            </section>
          )}

          {/* CONCLUIDOS + SEM COMUNICACAO — ocultados quando "So com problema" esta ativo */}
          {!soProblema && (
            <div className="flex flex-col" style={{ gap: "0.5rem" }}>
              <FaixaColapsavel
                label="concluídos"
                count={totalConcluidos}
                cor="var(--verde)"
                icone={<IconCheck size={13} />}
              >
                <div className="flex flex-col" style={{ gap: "0.75rem" }}>
                  {concluidos.map((item) => (
                    <CardVeiculoOperacao key={item.id} item={item} />
                  ))}
                </div>
              </FaixaColapsavel>

              <FaixaColapsavel
                label="sem comunicação"
                count={totalSemCom}
                icone={<IconNoSignal size={13} />}
              >
                <div className="flex flex-col" style={{ gap: "0.75rem" }}>
                  {semComunicacao.map((item) => (
                    <CardVeiculoOperacao key={item.id} item={item} />
                  ))}
                </div>
              </FaixaColapsavel>
            </div>
          )}

          {/* Roubo de carga: contexto de inteligencia, abaixo da fila de alertas */}
          <div style={{ marginTop: "1.5rem" }}>
            <PainelRoubo />
          </div>
        </div>

        {/* ========================================================
            COLUNA DIREITA: metricas + mapa (sticky em desktop)
            ======================================================== */}
        <div
          className="w-full min-w-0 lg:sticky"
          style={{
            flex: "1 1 0%",
            top: "calc(var(--header-h, 64px) + 1rem)",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          {/* Metricas compactas */}
          <BlocoMetricas
            totalOperando={totalOperando}
            totalCriticos={totalCriticos}
            entregasFeitas={entregasFeitas}
            entregasTotal={entregasTotal}
          />

          {/* Mapa ao vivo da frota: altura determinada (vh) pro Leaflet montar com tamanho correto,
              calculada pra a coluna inteira caber na viewport sem estourar */}
          <div
            className="rounded-2xl overflow-hidden"
            style={{ border: "1px solid var(--border)", flexShrink: 0 }}
          >
            <MapaWrapper
              cliente={clienteAtivo.cod_user_unitrac}
              altura="calc(100vh - var(--header-h, 64px) - 8.5rem)"
              tiposAtivos={tiposSelecionadosSet.length > 0 ? tiposSelecionadosSet : undefined}
              soProblema={true}
            />
          </div>
        </div>

      </div>
    </div>
  );
}
