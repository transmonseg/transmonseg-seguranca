import QuestionarioForm from "./QuestionarioForm";

export const metadata = {
  title: "Questionário desvio — Transmonseg",
};

export default function QuestionarioDesvioPage() {
  return (
    <div className="min-h-[100dvh] px-5 py-10 sm:py-16" style={{ backgroundColor: "var(--bg)" }}>
      <div className="max-w-lg mx-auto mb-10">
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text)" }}>
          O que vocês acham das regras de desvio?
        </h1>
        <p className="text-sm mt-2 leading-relaxed" style={{ color: "var(--text-muted)" }}>
          10 perguntas rápidas sobre como o sistema decide o que é desvio hoje. Não precisa lembrar de nenhum caso
          específico, é só sua opinião sobre a regra em si. Leva uns 5 minutos.
        </p>
      </div>
      <QuestionarioForm />
    </div>
  );
}
