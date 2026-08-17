// Diagramas SVG explicando visualmente cada regra do questionario --
// pedido direto do usuario 17/08 ("explique melhor as regras dando
// exemplos ate visuais dos carros"). Mesma linguagem de icone em traco do
// resto do app (ver o escudo no header/login: stroke 1.5, rounded caps),
// paleta reaproveitada das CSS vars (--accent/--vermelho/--amarelo/--verde).
// Cada diagrama e um mini "radar" escuro, viewBox fixo 300x130.

function Moldura({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 300 130" className="w-full h-auto" style={{ maxHeight: 150 }} aria-hidden="true">
      <rect x={0.5} y={0.5} width={299} height={129} rx={10} fill="var(--bg)" stroke="var(--border)" />
      {children}
    </svg>
  );
}

// Caminhao visto de cima -- retangulo com cabine, le como "veiculo" em
// qualquer escala pequena sem virar mancha ilegivel.
function Caminhao({
  x, y, rot = 0, cor = "var(--accent)",
}: { x: number; y: number; rot?: number; cor?: string }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`} stroke={cor} strokeWidth={2} fill="none" strokeLinejoin="round">
      <rect x={-9} y={-5} width={18} height={10} rx={2} />
      <rect x={5} y={-3.5} width={6} height={7} rx={1} fill={cor} />
      <circle cx={-5} cy={5.5} r={1.6} fill={cor} stroke="none" />
      <circle cx={5} cy={5.5} r={1.6} fill={cor} stroke="none" />
    </g>
  );
}

function PinCliente({ x, y, cor = "var(--text-muted)", ativo = false }: { x: number; y: number; cor?: string; ativo?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        d="M0 -10 C5.5 -10 9 -6.2 9 -1.8 C9 3 0 12 0 12 C0 12 -9 3 -9 -1.8 C-9 -6.2 -5.5 -10 0 -10 Z"
        fill={ativo ? cor : "none"}
        stroke={cor}
        strokeWidth={1.6}
      />
      <circle cx={0} cy={-1.8} r={2.6} fill={ativo ? "var(--bg)" : cor} />
    </g>
  );
}

function Rotulo({ x, y, children, cor = "var(--text-muted)", tamanho = 8.5 }: { x: number; y: number; children: React.ReactNode; cor?: string; tamanho?: number }) {
  return (
    <text x={x} y={y} fontSize={tamanho} fill={cor} fontFamily="var(--font-geist), sans-serif" textAnchor="middle">
      {children}
    </text>
  );
}

// 1. Sinal principal: caminhao no centro, 3 clientes ao redor, setas
// tracejadas de TODOS crescendo ao mesmo tempo -- a leitura e literal:
// afastou de todo mundo junto.
export function DiagramaAfastandoTudo() {
  return (
    <Moldura>
      <Caminhao x={150} y={65} />
      {[[60, 25], [240, 30], [230, 100]].map(([px, py], i) => (
        <g key={i}>
          <line x1={150} y1={65} x2={px} y2={py} stroke="var(--vermelho)" strokeWidth={1.3} strokeDasharray="3 3" opacity={0.75} />
          <PinCliente x={px} y={py} cor="var(--text-muted)" />
        </g>
      ))}
      <Rotulo x={150} y={118}>Distância aumenta pra TODOS ao mesmo tempo</Rotulo>
    </Moldura>
  );
}

// 2. Velocidade de disparo: 2 leituras de GPS na linha do tempo, ~30s de
// intervalo, virando alerta vermelho na 2a.
export function DiagramaVelocidade() {
  return (
    <Moldura>
      <line x1={40} y1={65} x2={260} y2={65} stroke="var(--border)" strokeWidth={1.5} />
      <circle cx={90} cy={65} r={5} fill="var(--text-muted)" />
      <Rotulo x={90} y={45} cor="var(--text-muted)">leitura 1</Rotulo>
      <circle cx={210} cy={65} r={6} fill="var(--vermelho)" />
      <circle cx={210} cy={65} r={11} fill="none" stroke="var(--vermelho)" strokeWidth={1.2} opacity={0.5} />
      <Rotulo x={210} y={45} cor="var(--vermelho)">leitura 2 → crítico</Rotulo>
      <Rotulo x={150} y={95} cor="var(--text-dim)">~30 segundos entre leituras</Rotulo>
      <Rotulo x={150} y={118}>2 leituras seguidas afastando = dispara</Rotulo>
    </Moldura>
  );
}

// 3. Nivel do alerta: antes (amarelo/atencao, riscado) vs agora (direto
// vermelho/critico).
export function DiagramaNivel() {
  return (
    <Moldura>
      <g transform="translate(90 55)">
        <circle r={16} fill="none" stroke="var(--amarelo)" strokeWidth={2} opacity={0.4} />
        <line x1={-11} y1={-11} x2={11} y2={11} stroke="var(--amarelo)" strokeWidth={1.6} opacity={0.6} />
        <line x1={-11} y1={11} x2={11} y2={-11} stroke="var(--amarelo)" strokeWidth={1.6} opacity={0.6} />
        <Rotulo x={0} y={34} cor="var(--text-dim)">“atenção” não existe mais</Rotulo>
      </g>
      <path d="M135 55 L165 55" stroke="var(--text-dim)" strokeWidth={1.5} markerEnd="url(#seta)" />
      <g transform="translate(210 55)">
        <circle r={16} fill="var(--vermelho)" opacity={0.15} />
        <circle r={9} fill="var(--vermelho)" />
        <Rotulo x={0} y={34} cor="var(--vermelho)">nasce crítico</Rotulo>
      </g>
      <defs>
        <marker id="seta" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0 0 L6 3 L0 6 Z" fill="var(--text-dim)" />
        </marker>
      </defs>
      <Rotulo x={150} y={118}>Todo desvio já dispara vermelho, direto</Rotulo>
    </Moldura>
  );
}

// 4. Viagem longa: rodovia comprida, caminhao no meio, cliente pendente
// bem distante -- ainda assim avaliado (teto so' entra acima de 300km).
export function DiagramaViagemLonga() {
  return (
    <Moldura>
      <line x1={25} y1={65} x2={275} y2={65} stroke="var(--border)" strokeWidth={3} strokeDasharray="8 6" />
      <Caminhao x={90} y={65} />
      <PinCliente x={255} y={65} ativo cor="var(--accent)" />
      <Rotulo x={172} y={50} cor="var(--text-muted)">até 300 km — ainda avalia desvio</Rotulo>
      <Rotulo x={150} y={118}>Só para de avaliar acima de 300 km</Rotulo>
    </Moldura>
  );
}

// 5. Rua estreita: via principal (larga) -> rua estreita, dentro de uma
// janela de 10min (relogio), reforca o alerta.
export function DiagramaRuaEstreita() {
  return (
    <Moldura>
      <rect x={30} y={58} width={90} height={14} fill="var(--border-subtle)" />
      <rect x={120} y={62} width={70} height={6} fill="var(--border-subtle)" />
      <Caminhao x={150} y={65} />
      <g transform="translate(235 65)">
        <circle r={18} fill="none" stroke="var(--amarelo)" strokeWidth={1.8} />
        <line x1={0} y1={0} x2={0} y2={-11} stroke="var(--amarelo)" strokeWidth={1.6} strokeLinecap="round" />
        <line x1={0} y1={0} x2={7} y2={3} stroke="var(--amarelo)" strokeWidth={1.6} strokeLinecap="round" />
      </g>
      <Rotulo x={235 as number} y={95} cor="var(--amarelo)">até 10 min depois</Rotulo>
      <Rotulo x={75} y={95} cor="var(--text-muted)">via principal</Rotulo>
      <Rotulo x={150} y={118}>Via principal → rua estreita reforça o alerta</Rotulo>
    </Moldura>
  );
}

// 6. Corredor real: rota conhecida (linha continua) vs posicao real do
// caminhao fora dela (linha tracejada vermelha ate a rota).
export function DiagramaCorredor() {
  return (
    <Moldura>
      <path d="M40 90 C 100 40, 200 40, 260 90" fill="none" stroke="var(--verde)" strokeWidth={2} opacity={0.55} />
      <Caminhao x={165} y={65} />
      <line x1={165} y1={65} x2={158} y2={78} stroke="var(--vermelho)" strokeWidth={1.4} strokeDasharray="2 2" />
      <Rotulo x={90} y={100} cor="var(--verde)">rota real conhecida</Rotulo>
      <Rotulo x={150} y={118}>Fora de qualquer rota real = reforça</Rotulo>
    </Moldura>
  );
}

// 7. Rua rara: grade de ruas, a maioria "quente" (muito passada pela
// frota), uma fraca/rara com <=2 visitas -- regra hoje desligada.
export function DiagramaRuaRara() {
  const ruas = [
    [40, 40, 90, 40, 6], [110, 40, 190, 40, 6], [210, 40, 260, 40, 5],
    [40, 70, 130, 70, 6], [150, 70, 260, 70, 1],
    [40, 95, 200, 95, 5],
  ];
  return (
    <Moldura>
      {ruas.map(([x1, y1, x2, y2, peso], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={peso <= 1 ? "var(--vermelho)" : "var(--accent)"} strokeWidth={peso <= 1 ? 2 : 4} opacity={peso <= 1 ? 0.9 : 0.35} />
      ))}
      <Rotulo x={205} y={82} cor="var(--vermelho)">rara (≤2 visitas) — regra desligada</Rotulo>
      <Rotulo x={150} y={118}>Rua que a frota quase nunca passa</Rotulo>
    </Moldura>
  );
}

// 8. Prioridade geral: balanca entre "rapido" e "certeza".
export function DiagramaPrioridade() {
  return (
    <Moldura>
      <line x1={150} y1={30} x2={150} y2={50} stroke="var(--text-dim)" strokeWidth={1.5} />
      <line x1={80} y1={50} x2={220} y2={50} stroke="var(--text-dim)" strokeWidth={1.5} />
      <line x1={80} y1={50} x2={80} y2={68} stroke="var(--text-dim)" strokeWidth={1.2} />
      <line x1={220} y1={50} x2={220} y2={68} stroke="var(--text-dim)" strokeWidth={1.2} />
      <path d="M62 68 A18 10 0 0 0 98 68 Z" fill="var(--vermelho)" opacity={0.3} stroke="var(--vermelho)" strokeWidth={1.2} />
      <path d="M202 68 A18 10 0 0 0 238 68 Z" fill="var(--verde)" opacity={0.3} stroke="var(--verde)" strokeWidth={1.2} />
      <Rotulo x={80} y={92} cor="var(--vermelho)">rápido, mais bobagem</Rotulo>
      <Rotulo x={220} y={92} cor="var(--verde)">devagar, mais certeza</Rotulo>
      <Rotulo x={150} y={118}>Qual lado o sistema deveria pesar mais?</Rotulo>
    </Moldura>
  );
}

// 9. Parada fora do esperado vs desvio de movimento: dois icones bem
// diferentes (um parado/"P", um andando/seta) sob o MESMO rotulo na tela.
export function DiagramaParadaFora() {
  return (
    <Moldura>
      <g transform="translate(95 60)">
        <Caminhao x={0} y={0} />
        <circle cx={0} cy={22} r={9} fill="none" stroke="var(--amarelo)" strokeWidth={1.6} />
        <text x={0} y={26} fontSize={10} fill="var(--amarelo)" textAnchor="middle" fontWeight={700}>P</text>
        <Rotulo x={0} y={-18} cor="var(--text-muted)">fica parado no lugar errado</Rotulo>
      </g>
      <line x1={150} y1={60} x2={150} y2={100} stroke="var(--border)" strokeWidth={1} strokeDasharray="2 3" />
      <g transform="translate(205 60)">
        <Caminhao x={0} y={0} rot={20} />
        <path d="M-9 20 L14 20" stroke="var(--accent)" strokeWidth={1.6} markerEnd="url(#seta2)" />
        <Rotulo x={0} y={-18} cor="var(--text-muted)">se afasta em movimento</Rotulo>
      </g>
      <defs>
        <marker id="seta2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0 0 L6 3 L0 6 Z" fill="var(--accent)" />
        </marker>
      </defs>
      <Rotulo x={150} y={118} cor="var(--text-dim)">As duas aparecem na tela como “Desvio de rota”</Rotulo>
    </Moldura>
  );
}

// 10. Zona de folga da base: circulo de 1200m ao redor da base -- dentro,
// nao avalia; fora, avalia normal.
export function DiagramaBase() {
  return (
    <Moldura>
      <circle cx={110} cy={65} r={42} fill="var(--accent-dim)" opacity={0.5} />
      <circle cx={110} cy={65} r={42} fill="none" stroke="var(--accent)" strokeWidth={1.2} strokeDasharray="4 3" />
      <rect x={102} y={57} width={16} height={16} rx={2} fill="var(--accent)" />
      <Caminhao x={110} y={40} cor="var(--text-muted)" />
      <Rotulo x={110} y={20} cor="var(--text-muted)">dentro: não avalia</Rotulo>
      <Caminhao x={225} y={65} cor="var(--vermelho)" />
      <Rotulo x={225} y={95} cor="var(--vermelho)">fora: avalia normal</Rotulo>
      <Rotulo x={150} y={118}>Raio de 1.200m ao redor da base</Rotulo>
    </Moldura>
  );
}
