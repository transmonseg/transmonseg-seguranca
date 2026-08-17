"use client";

import { useActionState } from "react";
import { enviarRespostas, type EstadoQuestionario } from "./actions";
import { PERGUNTAS } from "./perguntas";
import {
  DiagramaAfastandoTudo,
  DiagramaVelocidade,
  DiagramaNivel,
  DiagramaViagemLonga,
  DiagramaRuaEstreita,
  DiagramaCorredor,
  DiagramaRuaRara,
  DiagramaPrioridade,
  DiagramaParadaFora,
  DiagramaBase,
} from "./Diagramas";

const estadoInicial: EstadoQuestionario = {};

// Um diagrama por numero de pergunta -- ver Diagramas.tsx.
const DIAGRAMA_POR_NUMERO: Record<number, () => React.ReactElement> = {
  1: DiagramaAfastandoTudo,
  2: DiagramaVelocidade,
  3: DiagramaNivel,
  4: DiagramaViagemLonga,
  5: DiagramaRuaEstreita,
  6: DiagramaCorredor,
  7: DiagramaRuaRara,
  8: DiagramaPrioridade,
  9: DiagramaParadaFora,
  10: DiagramaBase,
};

const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
  color: "var(--text)",
};

export default function QuestionarioForm() {
  const [estado, formAction, pending] = useActionState(enviarRespostas, estadoInicial);

  if (estado.ok) {
    return (
      <div
        className="max-w-lg mx-auto mt-16 p-6 rounded-lg text-center animate-fade-in"
        style={{ backgroundColor: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)" }}
      >
        <p className="text-base font-medium" style={{ color: "var(--verde)" }}>
          Respostas enviadas, valeu!
        </p>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          Já foi direto pro Joaquim.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="max-w-lg mx-auto flex flex-col gap-8 pb-16">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="respondente" className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
          Seu nome
        </label>
        <input
          id="respondente"
          name="respondente"
          type="text"
          required
          placeholder="Ex: Erica, Ana, Elloisy"
          className="px-3.5 py-2.5 rounded-lg text-sm outline-none"
          style={inputStyle}
        />
      </div>

      {PERGUNTAS.map((p) => {
        const Diagrama = DIAGRAMA_POR_NUMERO[p.numero];
        return (
        <div key={p.numero} className="flex flex-col gap-3 pt-6" style={{ borderTop: "1px solid var(--border-subtle)" }}>
          <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border-subtle)" }}>
            <Diagrama />
          </div>

          <p className="text-sm leading-relaxed" style={{ color: "var(--text)" }}>
            <span style={{ color: "var(--accent)" }}>{p.numero}.</span> {p.texto}
          </p>
          <p className="text-xs leading-relaxed italic" style={{ color: "var(--text-muted)" }}>
            {p.exemplo}
          </p>

          <div className="flex flex-col gap-2">
            {p.opcoes.map((op) => (
              <label
                key={op}
                className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm cursor-pointer transition-colors"
                style={inputStyle}
              >
                <input type="radio" name={`resposta_${p.numero}`} value={op} required className="accent-current" />
                <span style={{ color: "var(--text)" }}>{op}</span>
              </label>
            ))}
          </div>

          <textarea
            name={`comentario_${p.numero}`}
            placeholder="Quer escrever mais sobre essa? Conta com suas palavras (opcional)"
            rows={2}
            className="px-3.5 py-2.5 rounded-lg text-sm outline-none resize-y"
            style={{ ...inputStyle, backgroundColor: "transparent" }}
          />
        </div>
        );
      })}

      <div className="flex flex-col gap-2 pt-6" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <label htmlFor="observacao_livre" className="text-sm font-medium" style={{ color: "var(--text)" }}>
          Espaço livre: tem mais alguma coisa que você acha que eu deveria saber?
        </label>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Pode escrever à vontade, o quanto quiser. Não precisa ser sobre as regras acima.
        </p>
        <textarea
          id="observacao_livre"
          name="observacao_livre"
          placeholder="Escreve aqui..."
          rows={5}
          className="px-3.5 py-2.5 rounded-lg text-sm outline-none resize-y"
          style={inputStyle}
        />
      </div>

      {estado.erro && (
        <p
          className="text-xs px-3 py-2 rounded-lg"
          style={{ backgroundColor: "rgba(239,68,68,0.1)", color: "var(--vermelho)", border: "1px solid rgba(239,68,68,0.2)" }}
        >
          {estado.erro}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="px-4 py-3 rounded-lg text-sm font-semibold transition-all active:translate-y-px disabled:opacity-60"
        style={{ backgroundColor: "var(--accent)", color: "#0a0a0a" }}
      >
        {pending ? "Enviando..." : "Enviar respostas"}
      </button>
    </form>
  );
}
