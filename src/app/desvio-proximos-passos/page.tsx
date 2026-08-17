import Link from "next/link";

export const metadata = {
  title: "Desvio de rota — próximos passos",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
};

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold tracking-tight mb-4" style={{ color: "var(--accent)" }}>
        {titulo}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Item({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 p-4 rounded-lg" style={cardStyle}>
      <span
        className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold"
        style={{ backgroundColor: "var(--accent-dim)", color: "var(--accent)" }}
      >
        {n}
      </span>
      <p className="text-sm leading-relaxed" style={{ color: "var(--text)" }}>
        {children}
      </p>
    </div>
  );
}

export default function DesvioProximosPassosPage() {
  return (
    <div className="min-h-[100dvh] px-5 py-10 sm:py-16" style={{ backgroundColor: "var(--bg)" }}>
      <div className="max-w-lg mx-auto">
        <p className="text-xs font-medium tracking-wide" style={{ color: "var(--text-dim)" }}>
          TRANSMONSEG · DESVIO DE ROTA
        </p>
        <h1 className="text-2xl font-semibold tracking-tight mt-2" style={{ color: "var(--text)" }}>
          Próximos passos
        </h1>
        <p className="text-sm mt-3 leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Fechei o que preciso pra evoluir o sistema de desvio. Primeiro o que preciso de vocês, depois o que eu vou
          fazer daqui, sem depender de nada.
        </p>

        <Secao titulo="O que preciso de vocês">
          <Item n={1}>
            Uma reunião, pode ser sábado ou quinta à tarde, sem precisar ser horário de carro rodando: você e a Ana
            ou a Elloisy, mostrando o Unitrac e explicando o que é desvio, como identificam. Um treinamento pra mim.
          </Item>
          <Item n={2}>
            Nessa mesma reunião, quero trazer casos reais do banco e revisar junto com vocês, ao vivo: vocês me
            dizendo &ldquo;esse é real, esse é falso e por quê&rdquo;, pra eu ter um gabarito confiável, não só uma
            demonstração.
          </Item>
          <Item n={3}>
            Depois disso, que a Ana e a Elloisy passem a usar de verdade o botão Falso com o motivo, caso a caso, em
            vez de resolver tudo em massa. Sem isso o dado que vou construir não serve pra nada, ninguém vai
            preencher.
          </Item>
          <Item n={4}>
            Se elas notarem um padrão se repetindo, tipo &ldquo;esse aqui sempre dá falso&rdquo;, me avisar direto
            em vez de só ir resolvendo caladas. Isso vira pista pra eu investigar rápido.
          </Item>
          <Item n={5}>
            E preciso que quem for revisar tenha tempo de verdade reservado pra isso. Sei que é operação corrida,
            mas sem alguém dedicado revisando direito, nem o melhor sistema do mundo aprende sozinho.
          </Item>
        </Secao>

        <Secao titulo="O que eu vou fazer, sem depender de nada de vocês">
          <Item n={1}>
            Ajustar o motor pra disparar mais rápido, quase na hora, sempre testando contra um dia real inteiro
            antes de colocar no ar, pra não sair atirando alerta bobo.
          </Item>
          <Item n={2}>
            Corrigir um bug que achei essa semana: hoje a maioria dos alertas não grava onde o desvio aconteceu,
            então nem eu nem vocês conseguem olhar no mapa depois e confirmar. Corrigindo isso, toda revisão fica
            muito mais fácil de fazer de verdade.
          </Item>
          <Item n={3}>
            Fazer o corredor real, a rota de verdade que o caminhão deveria seguir, virar o critério principal pra
            disparar o alerta. Hoje ele só reforça um alerta que já ia disparar por outro motivo.
          </Item>
          <Item n={4}>
            Colocar dois botões nos alertas, Correto e Falso. Quando marcar Falso, abre perguntas rápidas: se ele
            tava indo pra algum cliente pendente, se a marcação no mapa bate com onde ele realmente tava, se foi
            rodovia longa entre clientes distantes, se foi pra base ou oficina.
          </Item>
          <Item n={5}>
            Trabalhar na geolocalização: hoje entrega que não confirma direito fica &ldquo;pendente&rdquo; a rota
            inteira, e isso confunde o sistema. Melhorando isso, os pendentes ficam mais reais e o desvio fica mais
            preciso, sozinho, sem custar nada.
          </Item>
        </Secao>

        <div className="mt-10 p-5 rounded-lg text-center" style={{ backgroundColor: "var(--accent-dim)", border: "1px solid var(--border)" }}>
          <p className="text-sm leading-relaxed" style={{ color: "var(--text)" }}>
            Antes da reunião, um favor: 10 perguntas rápidas sobre as regras de hoje, pra eu já chegar sabendo o que
            vocês pensam.
          </p>
          <Link
            href="/questionario-desvio"
            className="inline-block mt-4 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all active:translate-y-px"
            style={{ backgroundColor: "var(--accent)", color: "#0a0a0a" }}
          >
            Responder o questionário
          </Link>
        </div>

        <p className="text-xs mt-8 text-center" style={{ color: "var(--text-dim)" }}>
          Vou mandando conforme for saindo, pra vocês verem de fato o que mudou.
        </p>
      </div>
    </div>
  );
}
