"use client";
import { useRef, useEffect, useState } from "react";

export const CATEGORIAS_FALSO = [
  { valor: "NAO_FOI_AO_CLIENTE", label: "Não foi ao cliente", apoio: "O carro não chegou perto de nenhum cliente pendente" },
  { valor: "NAO_SAIU_DA_BASE", label: "Não saiu da base", apoio: "Ainda estava na base ou oficina" },
  { valor: "DESATUALIZADO", label: "Marcação desatualizada", apoio: "A marcação/endereço não bate com onde ele realmente estava" },
  { valor: "MUDOU_DE_ROTA", label: "Mudou de rota (mas ok)", apoio: "Foi por outro caminho, mas ainda ia pro destino certo" },
] as const;

export type CategoriaFalso = typeof CATEGORIAS_FALSO[number]["valor"];

export default function MenuMotivoFalso({
  onEscolher, aberto, onFechar, compacto = false,
}: {
  // Pedido do time (grupo DESVIO DE ROTA, 26/08): "colocar uma aba para
  // escrever o motivo" -- detalhe em texto livre OPCIONAL, ao lado da
  // categoria fixa (nunca a substitui -- ver acoes-alertas.ts/migration 060).
  onEscolher: (categoria: CategoriaFalso, detalhe: string) => void;
  aberto: boolean;
  onFechar: () => void;
  compacto?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [detalhe, setDetalhe] = useState("");
  // Zera o texto ao fechar (nao ao abrir, pra nao chamar setState de dentro
  // de um effect) -- toda saida passa por aqui, entao a proxima abertura ja
  // comeca limpa. Nunca deve sobrar detalhe de um alerta anterior grudado
  // num alerta diferente.
  const fechar = () => { setDetalhe(""); onFechar(); };
  useEffect(() => {
    if (!aberto) return;
    const onClickFora = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fechar();
    };
    document.addEventListener("mousedown", onClickFora);
    return () => document.removeEventListener("mousedown", onClickFora);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fechar() e' recriada a cada render (fecha sobre detalhe/onFechar atuais), incluir na dep list reagendaria o listener toda hora sem mudar comportamento.
  }, [aberto]);

  if (!aberto) return null;
  return (
    <div ref={ref} style={{
      position: "absolute", zIndex: 50, marginTop: 4,
      background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8,
      boxShadow: "0 8px 24px rgba(0,0,0,0.25)", padding: 6, minWidth: compacto ? 200 : 260,
      display: "flex", flexDirection: "column", gap: 3,
    }}>
      {CATEGORIAS_FALSO.map(c => (
        <button key={c.valor} type="button"
          onClick={() => { onEscolher(c.valor, detalhe); fechar(); }}
          style={{
            textAlign: "left", padding: "6px 8px", borderRadius: 6, border: "none",
            background: "transparent", cursor: "pointer",
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--border-subtle)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{c.label}</div>
          {!compacto && <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{c.apoio}</div>}
        </button>
      ))}
      <div style={{ borderTop: "1px solid var(--border)", marginTop: 3, paddingTop: 5 }}>
        <textarea
          value={detalhe}
          onChange={e => setDetalhe(e.target.value)}
          onClick={e => e.stopPropagation()}
          placeholder="Motivo (opcional) -- escreva se nenhuma opção acima descreve o caso"
          rows={2}
          style={{
            width: "100%", resize: "vertical", fontSize: 11, padding: "5px 6px",
            borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)",
            color: "var(--text)", fontFamily: "inherit", boxSizing: "border-box",
          }}
        />
      </div>
    </div>
  );
}
