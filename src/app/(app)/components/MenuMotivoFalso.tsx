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
  // Categoria fica so selecionada (estado local) ate o operador clicar em
  // "Confirmar Falso" -- clicar numa categoria nao dispara mais onEscolher
  // na hora (fluxo de 2 passos: selecionar -> confirmar).
  const [selecionada, setSelecionada] = useState<CategoriaFalso | null>(null);
  // Zera texto e selecao ao fechar (nao ao abrir, pra nao chamar setState de
  // dentro de um effect) -- toda saida passa por aqui, entao a proxima
  // abertura ja comeca limpa. Nunca deve sobrar detalhe/selecao de um alerta
  // anterior grudado num alerta diferente.
  const fechar = () => { setDetalhe(""); setSelecionada(null); onFechar(); };
  const confirmar = () => {
    if (!selecionada) return;
    onEscolher(selecionada, detalhe);
    fechar();
  };
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
      // Achado real 01/09 (reclamacao da Rose no grupo DESVIO DE ROTA, com
      // print: "consegue aumentar essa aba? para ler a frase toda" -- o
      // print mostrava o menu cortado, "Nao foi ao cli...", "Confir..."):
      // o botao "Falso" e' o ultimo de uma fileira (Focar/Correto/Falso), e
      // este menu abria pra DIREITA a partir dele sem checar se cabia --
      // em tela estreita (mobile) o menu vazava pra fora da viewport e
      // ficava cortado pelo `overflow: hidden` do card. `right: 0` alinha a
      // borda DIREITA do menu com a borda direita do botao, crescendo pra
      // ESQUERDA -- funciona porque o botao "Falso" costuma estar perto da
      // borda direita do card (ultimo da fileira), entao crescer pra
      // esquerda mantem o menu dentro da area visivel.
      position: "absolute", right: 0, zIndex: 50, marginTop: 4,
      background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8,
      boxShadow: "0 8px 24px rgba(0,0,0,0.25)", padding: 6, minWidth: compacto ? 200 : 260,
      maxWidth: "min(92vw, 320px)",
      display: "flex", flexDirection: "column", gap: 3,
    }}>
      {CATEGORIAS_FALSO.map(c => {
        const ativa = selecionada === c.valor;
        return (
          <button key={c.valor} type="button"
            aria-pressed={ativa}
            onClick={() => setSelecionada(c.valor)}
            style={{
              textAlign: "left", padding: "6px 8px", borderRadius: 6,
              border: ativa ? "1px solid var(--accent)" : "1px solid transparent",
              background: ativa ? "var(--border-subtle)" : "transparent", cursor: "pointer",
            }}
            onMouseEnter={e => { if (!ativa) e.currentTarget.style.background = "var(--border-subtle)"; }}
            onMouseLeave={e => { if (!ativa) e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{c.label}</div>
            {!compacto && <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{c.apoio}</div>}
          </button>
        );
      })}
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
        {/* Achado real 01/09 (reclamacao da Rose no grupo DESVIO DE ROTA:
            "escrevemos e quando clica em confirmar, nao vai"): escrever so'
            no texto livre sem clicar numa categoria acima deixa o botao
            desabilitado SEM nenhum aviso -- parecia bug, era falta de
            feedback. `detalhe` nunca substitui a categoria (ver comentario
            de onEscolher acima), entao a regra continua a mesma -- so'
            ficou visivel por que o botao nao reage. */}
        {!selecionada && detalhe.trim().length > 0 && (
          <div style={{ fontSize: 10.5, color: "var(--vermelho)", marginTop: 4, marginBottom: 2 }}>
            Selecione uma opção acima também para confirmar
          </div>
        )}
        <button type="button"
          onClick={confirmar}
          disabled={!selecionada}
          style={{
            width: "100%", marginTop: 5, padding: "6px 8px", borderRadius: 6,
            border: "none", fontSize: 11.5, fontWeight: 600,
            background: selecionada ? "var(--accent)" : "var(--border-subtle)",
            color: selecionada ? "var(--accent-fg, #fff)" : "var(--text-muted)",
            cursor: selecionada ? "pointer" : "not-allowed",
          }}
        >
          Confirmar Falso
        </button>
      </div>
    </div>
  );
}
