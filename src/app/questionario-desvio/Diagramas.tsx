// Diagramas SVG explicando visualmente cada regra do questionario --
// pedido direto do usuario 17/08 ("explique melhor as regras dando
// exemplos ate visuais dos carros, use a skill de designer"). Sem chave
// Gemini configurada neste ambiente pra gerar icone via IA (script
// scripts/icon/generate.py da skill "design") -- ilustracao construida a
// mao, mas com acabamento de painel de radar/mapa de verdade (grade,
// brilho radial, sombra), nao geometria solta. Paleta das CSS vars
// (--accent/--vermelho/--amarelo/--verde), mesma familia visual do escudo
// do header/login (traco 1.5-2, rounded caps).

import { useId as useIdReact } from "react";

// Wrapper fino sobre o useId nativo do React (seguro pra hidratacao SSR,
// ao contrario de um contador de modulo) -- só troca o prefixo padrão
// (":r0:") por algo legível nos ids dos <defs>.
function useId(prefixo: string) {
  return `${prefixo}${useIdReact().replace(/:/g, "")}`;
}

// Moldura: painel escuro tipo "radar" -- grade sutil de mapa, brilho
// radial atras do centro de acao, vinheta nas bordas. viewBox 340x170,
// consideravelmente maior que a v1 (300x130) pra caber detalhe de verdade.
function Moldura({ children, foco = { x: 170, y: 78 } }: { children: React.ReactNode; foco?: { x: number; y: number } }) {
  const gradId = useId("grad");
  const gridId = useId("grid");
  const vinhetaId = useId("vin");
  return (
    <svg viewBox="0 0 340 170" className="w-full h-auto block" style={{ maxHeight: 200 }} aria-hidden="true">
      <defs>
        <radialGradient id={gradId} cx={`${(foco.x / 340) * 100}%`} cy={`${(foco.y / 170) * 100}%`} r="65%">
          <stop offset="0%" stopColor="var(--accent-dim)" stopOpacity={0.9} />
          <stop offset="100%" stopColor="var(--bg)" stopOpacity={0} />
        </radialGradient>
        <pattern id={gridId} width={17} height={17} patternUnits="userSpaceOnUse">
          <path d="M17 0 L0 0 0 17" fill="none" stroke="var(--border-subtle)" strokeWidth={0.6} />
        </pattern>
        <radialGradient id={vinhetaId} cx="50%" cy="50%" r="75%">
          <stop offset="60%" stopColor="black" stopOpacity={0} />
          <stop offset="100%" stopColor="black" stopOpacity={0.35} />
        </radialGradient>
      </defs>
      <rect x={0.5} y={0.5} width={339} height={169} rx={12} fill="var(--bg)" stroke="var(--border)" />
      <rect x={1} y={1} width={338} height={168} rx={11.5} fill={`url(#${gridId})`} />
      <rect x={1} y={1} width={338} height={168} rx={11.5} fill={`url(#${gradId})`} />
      {children}
      <rect x={1} y={1} width={338} height={168} rx={11.5} fill={`url(#${vinhetaId})`} />
    </svg>
  );
}

// Caminhao-bau visto de perfil: cabine com para-brisa inclinado + bau de
// carga com linhas de painel + rodas com aro detalhado + sombra de
// contato no chao. Reconhecivel como "caminhao de entrega" mesmo pequeno,
// nao mais uma mancha retangular.
function Caminhao({
  x, y, rot = 0, escala = 1, cor = "var(--accent)", apagado = false,
}: { x: number; y: number; rot?: number; escala?: number; cor?: string; apagado?: boolean }) {
  const op = apagado ? 0.55 : 1;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot}) scale(${escala})`} opacity={op}>
      <ellipse cx={0} cy={12.5} rx={19} ry={2.6} fill="black" opacity={0.35} />
      {/* bau de carga */}
      <rect x={-17} y={-13} width={24} height={19} rx={2} fill={cor} opacity={0.16} stroke={cor} strokeWidth={1.6} />
      <line x1={-9} y1={-13} x2={-9} y2={6} stroke={cor} strokeWidth={0.9} opacity={0.5} />
      <line x1={-1} y1={-13} x2={-1} y2={6} stroke={cor} strokeWidth={0.9} opacity={0.5} />
      {/* cabine */}
      <path d="M7 6 L7 -5 L11.5 -5 L17 1.5 L17 6 Z" fill={cor} stroke={cor} strokeWidth={1.6} strokeLinejoin="round" />
      <path d="M9.3 -4 L9.3 0.5 L14.4 0.5 L11.2 -4 Z" fill="var(--bg)" opacity={0.85} />
      {/* parachoque + grade */}
      <line x1={17} y1={5.6} x2={19.5} y2={5.6} stroke={cor} strokeWidth={2} strokeLinecap="round" />
      {/* rodas */}
      {[-9, 12].map((wx) => (
        <g key={wx} transform={`translate(${wx} 8)`}>
          <circle r={4.6} fill="var(--bg)" stroke={cor} strokeWidth={1.8} />
          <circle r={1.7} fill={cor} />
        </g>
      ))}
    </g>
  );
}

// Pin de cliente: gota com aro duplo + sombra de contato, estado "ativo"
// preenche solido.
function PinCliente({ x, y, cor = "var(--text-muted)", ativo = false, rotulo }: { x: number; y: number; cor?: string; ativo?: boolean; rotulo?: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse cx={0} cy={14.5} rx={5} ry={1.4} fill="black" opacity={0.3} />
      <path
        d="M0 -13 C7 -13 12 -8 12 -2.2 C12 5.5 0 15 0 15 C0 15 -12 5.5 -12 -2.2 C-12 -8 -7 -13 0 -13 Z"
        fill={ativo ? cor : "var(--bg)"}
        stroke={cor}
        strokeWidth={1.8}
      />
      <circle cx={0} cy={-2.2} r={3.6} fill={ativo ? "var(--bg)" : cor} />
      {rotulo && (
        <text x={0} y={26} fontSize={8} fill={cor} textAnchor="middle" fontFamily="var(--font-geist), sans-serif" fontWeight={600}>
          {rotulo}
        </text>
      )}
    </g>
  );
}

function Rotulo({ x, y, children, cor = "var(--text-muted)", tamanho = 9.5, peso = 500 }: { x: number; y: number; children: React.ReactNode; cor?: string; tamanho?: number; peso?: number }) {
  return (
    <text x={x} y={y} fontSize={tamanho} fill={cor} fontFamily="var(--font-geist), sans-serif" fontWeight={peso} textAnchor="middle">
      {children}
    </text>
  );
}

function Legenda({ children }: { children: React.ReactNode }) {
  return (
    <text x={170} y={158} fontSize={10} fill="var(--text)" fontFamily="var(--font-geist), sans-serif" fontWeight={600} textAnchor="middle">
      {children}
    </text>
  );
}

// Marcadores de seta com id unico por instancia (useId) -- markers em SVG
// sao resolvidos no DOM inteiro da pagina, nao escopados por <svg>; com 10
// diagramas na mesma pagina, um id fixo tipo "seta-accent" repetido em
// varios diagramas quebraria os markers dos diagramas depois do primeiro.
function useMarcadores() {
  const idAccent = useId("seta-a-");
  const idDim = useId("seta-d-");
  const idVermelho = useId("seta-v-");
  const defs = (
    <defs>
      <marker id={idAccent} markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
        <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--accent)" />
      </marker>
      <marker id={idDim} markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
        <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--text-dim)" />
      </marker>
      <marker id={idVermelho} markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
        <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--vermelho)" />
      </marker>
    </defs>
  );
  return { setaAccent: `url(#${idAccent})`, setaDim: `url(#${idDim})`, setaVermelho: `url(#${idVermelho})`, defs };
}

// 1. Sinal principal: caminhao no centro, 3 clientes ao redor, setas
// tracejadas vermelhas crescendo dos 3 ao mesmo tempo.
export function DiagramaAfastandoTudo() {
  const { setaVermelho, defs } = useMarcadores();
  return (
    <Moldura>
      {defs}
      {[[62, 38], [270, 42], [255, 118]].map(([px, py], i) => (
        <line key={i} x1={170} y1={80} x2={px} y2={py} stroke="var(--vermelho)" strokeWidth={1.6} strokeDasharray="4 4" opacity={0.8} markerEnd={setaVermelho} />
      ))}
      {[[62, 38], [270, 42], [255, 118]].map(([px, py], i) => (
        <PinCliente key={i} x={px} y={py} cor="var(--text-muted)" />
      ))}
      <Caminhao x={170} y={80} />
      <Legenda>Distância aumenta pra TODOS ao mesmo tempo</Legenda>
    </Moldura>
  );
}

// 2. Velocidade de disparo: 2 leituras de GPS na linha do tempo.
export function DiagramaVelocidade() {
  return (
    <Moldura foco={{ x: 240, y: 75 }}>
      <line x1={50} y1={80} x2={295} y2={80} stroke="var(--border)" strokeWidth={2} strokeLinecap="round" />
      <g transform="translate(100 80)">
        <circle r={5.5} fill="var(--card)" stroke="var(--text-muted)" strokeWidth={2} />
        <Rotulo x={0} y={-16} cor="var(--text-muted)">leitura 1</Rotulo>
        <Rotulo x={0} y={30} cor="var(--text-dim)" tamanho={8.5} peso={400}>0s</Rotulo>
      </g>
      <path d="M120 80 L225 80" stroke="var(--text-dim)" strokeWidth={1.3} strokeDasharray="2 4" />
      <g transform="translate(240 80)">
        <circle r={13} fill="var(--vermelho)" opacity={0.18}>
          <animate attributeName="r" values="13;17;13" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.22;0.05;0.22" dur="1.6s" repeatCount="indefinite" />
        </circle>
        <circle r={7} fill="var(--vermelho)" />
        <Rotulo x={0} y={-22} cor="var(--vermelho)" peso={700}>leitura 2 → crítico</Rotulo>
        <Rotulo x={0} y={30} cor="var(--text-dim)" tamanho={8.5} peso={400}>~30s</Rotulo>
      </g>
      <Legenda>2 leituras seguidas afastando já dispara</Legenda>
    </Moldura>
  );
}

// 3. Nivel do alerta: amarelo/atencao riscado -> vermelho/critico direto.
export function DiagramaNivel() {
  const { setaDim, defs } = useMarcadores();
  return (
    <Moldura>
      {defs}
      <g transform="translate(110 78)">
        <circle r={22} fill="var(--amarelo)" opacity={0.12} />
        <circle r={22} fill="none" stroke="var(--amarelo)" strokeWidth={2} strokeDasharray="3 4" opacity={0.7} />
        <path d="M-9 -9 L9 9 M9 -9 L-9 9" stroke="var(--amarelo)" strokeWidth={2.2} strokeLinecap="round" opacity={0.85} />
        <Rotulo x={0} y={42} cor="var(--text-muted)" tamanho={9}>“atenção” não existe mais</Rotulo>
      </g>
      <path d="M158 78 L182 78" stroke="var(--text-dim)" strokeWidth={1.8} markerEnd={setaDim} />
      <g transform="translate(230 78)">
        <circle r={24} fill="var(--vermelho)" opacity={0.16}>
          <animate attributeName="r" values="24;28;24" dur="1.8s" repeatCount="indefinite" />
        </circle>
        <circle r={13} fill="var(--vermelho)" />
        <path d="M-3.5 -6 L3.5 -6 L2 3 L-2 3 Z M-1.5 5 L1.5 5 L1.5 7.5 L-1.5 7.5 Z" fill="var(--bg)" />
        <Rotulo x={0} y={42} cor="var(--vermelho)" peso={700}>nasce crítico</Rotulo>
      </g>
      <Legenda>Todo desvio já dispara vermelho, direto</Legenda>
    </Moldura>
  );
}

// 4. Viagem longa: rodovia comprida, caminhao no meio, cliente a 300km.
export function DiagramaViagemLonga() {
  return (
    <Moldura foco={{ x: 240, y: 75 }}>
      <line x1={35} y1={80} x2={300} y2={80} stroke="var(--border)" strokeWidth={4} strokeDasharray="10 7" strokeLinecap="round" />
      <Caminhao x={95} y={80} />
      <PinCliente x={272} y={80} ativo cor="var(--accent)" rotulo="300 km" />
      <Rotulo x={170} y={45} cor="var(--text-muted)">continua avaliando o trajeto inteiro</Rotulo>
      <Legenda>Só ignora desvio acima de 300 km</Legenda>
    </Moldura>
  );
}

// 5. Rua estreita: via principal larga -> rua estreita, relogio de 10min.
export function DiagramaRuaEstreita() {
  return (
    <Moldura>
      <rect x={20} y={70} width={110} height={20} rx={2} fill="var(--border-subtle)" />
      <rect x={130} y={76} width={90} height={8} rx={1.5} fill="var(--border-subtle)" />
      <Caminhao x={175} y={80} />
      <g transform="translate(268 78)">
        <circle r={22} fill="none" stroke="var(--amarelo)" strokeWidth={2} />
        <line x1={0} y1={0} x2={0} y2={-13} stroke="var(--amarelo)" strokeWidth={2} strokeLinecap="round" />
        <line x1={0} y1={0} x2={8} y2={4} stroke="var(--amarelo)" strokeWidth={2} strokeLinecap="round" />
        <circle r={1.8} fill="var(--amarelo)" />
      </g>
      <Rotulo x={268} y={112} cor="var(--amarelo)" peso={700}>até 10 min depois</Rotulo>
      <Rotulo x={75} y={112} cor="var(--text-muted)">via principal</Rotulo>
      <Legenda>Via principal → rua estreita reforça o alerta</Legenda>
    </Moldura>
  );
}

// 6. Corredor real: rota conhecida (linha verde) vs posicao real fora dela.
export function DiagramaCorredor() {
  return (
    <Moldura>
      <path d="M45 118 C 110 45, 230 45, 295 118" fill="none" stroke="var(--verde)" strokeWidth={2.6} opacity={0.6} strokeLinecap="round" />
      <Caminhao x={192} y={80} />
      <line x1={192} y1={80} x2={178} y2={101} stroke="var(--vermelho)" strokeWidth={1.8} strokeDasharray="3 3" />
      <circle cx={178} cy={101} r={2.6} fill="var(--vermelho)" />
      <Rotulo x={100} y={128} cor="var(--verde)" peso={600}>rota real conhecida</Rotulo>
      <Legenda>Fora de qualquer rota real reforça o alerta</Legenda>
    </Moldura>
  );
}

// 7. Rua rara: grade de ruas, maioria "quente", uma rara/fraca.
export function DiagramaRuaRara() {
  const ruas: [number, number, number, number, number][] = [
    [40, 45, 110, 45, 6], [130, 45, 230, 45, 6], [250, 45, 300, 45, 5],
    [40, 80, 155, 80, 6], [175, 80, 300, 80, 1],
    [40, 115, 240, 115, 5],
  ];
  return (
    <Moldura>
      {ruas.map(([x1, y1, x2, y2, peso], i) => (
        <line
          key={i} x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={peso <= 1 ? "var(--vermelho)" : "var(--accent)"}
          strokeWidth={peso <= 1 ? 3 : 5}
          strokeLinecap="round"
          opacity={peso <= 1 ? 0.9 : 0.3}
        />
      ))}
      <circle cx={237} cy={80} r={4} fill="var(--vermelho)" />
      <Rotulo x={237} y={100} cor="var(--vermelho)" peso={700}>rara (≤2 visitas)</Rotulo>
      <Rotulo x={237} y={112} cor="var(--text-dim)" tamanho={8.5} peso={400}>regra desligada hoje</Rotulo>
      <Legenda>Rua que a frota quase nunca passa</Legenda>
    </Moldura>
  );
}

// 8. Prioridade geral: balanca entre "rapido" e "certeza".
export function DiagramaPrioridade() {
  return (
    <Moldura>
      <line x1={170} y1={35} x2={170} y2={62} stroke="var(--text-dim)" strokeWidth={2} strokeLinecap="round" />
      <circle cx={170} cy={32} r={3} fill="var(--text-dim)" />
      <line x1={95} y1={62} x2={245} y2={62} stroke="var(--text-dim)" strokeWidth={2} strokeLinecap="round" />
      <line x1={95} y1={62} x2={95} y2={85} stroke="var(--text-dim)" strokeWidth={1.4} />
      <line x1={245} y1={62} x2={245} y2={85} stroke="var(--text-dim)" strokeWidth={1.4} />
      <path d="M73 85 A22 12 0 0 0 117 85 Z" fill="var(--vermelho)" opacity={0.22} stroke="var(--vermelho)" strokeWidth={1.6} />
      <path d="M223 85 A22 12 0 0 0 267 85 Z" fill="var(--verde)" opacity={0.22} stroke="var(--verde)" strokeWidth={1.6} />
      <Rotulo x={95} y={112} cor="var(--vermelho)" peso={700}>rápido</Rotulo>
      <Rotulo x={95} y={124} cor="var(--text-dim)" tamanho={8.5} peso={400}>mais alerta bobo</Rotulo>
      <Rotulo x={245} y={112} cor="var(--verde)" peso={700}>devagar</Rotulo>
      <Rotulo x={245} y={124} cor="var(--text-dim)" tamanho={8.5} peso={400}>mais certeza</Rotulo>
      <Legenda>Qual lado o sistema deveria pesar mais?</Legenda>
    </Moldura>
  );
}

// 9. Parada fora do esperado vs desvio de movimento: mesmo rotulo na tela.
export function DiagramaParadaFora() {
  const { setaAccent, defs } = useMarcadores();
  return (
    <Moldura>
      {defs}
      <g transform="translate(105 78)">
        <Caminhao x={0} y={0} apagado />
        <g transform="translate(0 26)">
          <circle r={10} fill="var(--amarelo)" opacity={0.18} />
          <circle r={10} fill="none" stroke="var(--amarelo)" strokeWidth={1.8} />
          <text y={3.5} fontSize={11} fill="var(--amarelo)" textAnchor="middle" fontWeight={800}>P</text>
        </g>
        <Rotulo x={0} y={-25} cor="var(--text-muted)" tamanho={9}>fica parado no lugar errado</Rotulo>
      </g>
      <line x1={170} y1={45} x2={170} y2={125} stroke="var(--border)" strokeWidth={1.2} strokeDasharray="3 4" />
      <g transform="translate(235 78)">
        <Caminhao x={0} y={0} rot={18} />
        <path d="M-16 26 L14 26" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" markerEnd={setaAccent} />
        <Rotulo x={0} y={-25} cor="var(--text-muted)" tamanho={9}>se afasta em movimento</Rotulo>
      </g>
      <Legenda>As duas aparecem na tela como “Desvio de rota”</Legenda>
    </Moldura>
  );
}

// 10. Zona de folga da base: circulo de 1200m -- dentro nao avalia, fora avalia.
export function DiagramaBase() {
  return (
    <Moldura>
      <circle cx={120} cy={82} r={52} fill="var(--accent-dim)" opacity={0.55} />
      <circle cx={120} cy={82} r={52} fill="none" stroke="var(--accent)" strokeWidth={1.4} strokeDasharray="5 4" />
      <Rotulo x={120} y={38} cor="var(--accent)" tamanho={8.5} peso={600}>1.200 m</Rotulo>
      <g transform="translate(120 82)">
        <rect x={-14} y={-11} width={28} height={22} rx={2.5} fill="var(--accent)" opacity={0.9} />
        <rect x={-8} y={-6} width={7} height={7} fill="var(--bg)" opacity={0.85} />
        <rect x={2} y={-6} width={7} height={7} fill="var(--bg)" opacity={0.85} />
        <rect x={-8} y={4} width={17} height={4} fill="var(--bg)" opacity={0.5} />
      </g>
      <Caminhao x={120} y={40} escala={0.85} cor="var(--text-muted)" apagado />
      <Rotulo x={120} y={16} cor="var(--text-muted)" tamanho={9}>dentro: não avalia</Rotulo>
      <Caminhao x={270} y={95} cor="var(--vermelho)" />
      <Rotulo x={270} y={128} cor="var(--vermelho)" peso={700}>fora: avalia normal</Rotulo>
      <Legenda>Raio de folga ao redor da base</Legenda>
    </Moldura>
  );
}
