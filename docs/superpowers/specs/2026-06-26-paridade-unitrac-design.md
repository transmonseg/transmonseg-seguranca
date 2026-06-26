# Paridade Unitrac na tela unificada — Design

**Data:** 2026-06-26
**Status:** aprovado (abordagem A)

## Problema

A unificação anterior escondeu a barra operacional estilo Unitrac (`mostrarSidebar={false}`
no `MapaMonitor`), tirando do operador a árvore de veículos, o seletor de período e o
controle de rastro. O cliente reclamou: quer a experiência operacional do Unitrac de volta,
sem perder a inteligência de alertas (o diferencial do produto). Além disso, o painel do
veículo e o popup do ponto de entrega têm menos informação que os do Unitrac.

## Referência (prints do portal Unitrac)

1. **Tela normal:** barra esquerda com busca de placa, período, filtros de comunicação,
   "Visualizar Rota / Limpar Rota", árvore de veículos com checkbox, áreas e pontos de
   interesse; mapa com todos os veículos individuais.
2. **Popup do veículo:** Veículo, Empresa, Grupo, Tecnologia, Placa, Modelo, Cor, Evento,
   Data GPS, Data Comunicação, Velocidade GPS, Coordenadas, "Offline por", Alertas pendentes,
   Comandos pendentes, Rota, ENTRADAS/SAÍDAS (sensores) e botões pânico/sirene/bloqueio/mensagem.
3. **Popup do ponto de entrega:** Identificação, Placa, Data, Hora Prevista, Hora Realizada,
   Observação, Situação.

## O que já existe (confirmado na varredura)

- A **barra operacional completa** já está no `MapaMonitor` (busca, período 1h-48h, filtro de
  comunicação, toggles Rastro/Paradas/Telemetria, Centralizar/Limpar, árvore de grupos com
  checkbox por veículo). Está apenas desligada por `mostrarSidebar={false}`.
- O mapa já desenha: marcadores individuais por status, rastro (linha ciano), paradas, pontos
  de entrega numerados com a linha da rota, bases (polígono), camadas de risco (favelas,
  tiroteios, roubo de carga, calor) e a posição ao vivo do selecionado.
- O `PainelVeiculoAlerta` já mostra velocidade, ignição, comunicação, último evento, sensores
  E/S, rota do dia (progresso + próximos pontos), alertas e sirene/bloqueio.

## Abordagem escolhida (A): tela única com toggle Operação | Alertas

A coluna esquerda alterna entre dois modos por um **toggle flutuante no topo do mapa**:

- **Modo Operação:** o `PainelCentral` esconde a coluna de alertas e passa
  `mostrarSidebar={true}` ao `MapaMonitor` — a barra Unitrac que já existe reaparece inteira.
- **Modo Alertas:** o `PainelCentral` mostra a coluna de alertas (segmented Tudo/Críticos/
  Atenção + grupos por tipo) e passa `mostrarSidebar={false}`.

O mapa é o mesmo nos dois modos, ocupando o restante da largura. Clicar num veículo (na árvore
ou no marcador) seleciona, desenha o rastro/pontos e abre o painel rico do veículo nos dois
modos.

**Por que assim:** reusa a barra operacional pronta sem reescrever o `MapaMonitor` (1900 linhas),
mantém tudo numa tela e tem baixo risco de regressão. O toggle flutuante é o único elemento
sempre visível, independente de qual barra está embaixo.

### Componentes e responsabilidades

| Componente | Mudança |
|---|---|
| `PainelCentral` | Novo estado `modoBarra: "operacao" \| "alertas"`. Renderiza o toggle flutuante. Mostra a coluna de alertas só no modo alertas. Passa `mostrarSidebar={modoBarra === "operacao"}`. |
| `MapaMonitor` | Sem reescrita. Ajustar o link do seletor de cliente da sidebar de `/monitoramento?cliente=` para `?cliente=` (a rota nova). |
| `PainelVeiculoAlerta` | Enriquecer com os campos do Unitrac disponíveis: coordenadas, Data GPS (`datagps`), "Offline por" (`atraso`), grupo (de `/api/grupos`), empresa (nome do cliente). Campos sem fonte confiável (Modelo, Cor) ficam de fora — não inventar. |
| Popup do ponto de entrega (`MapaMonitor`) | Enriquecer com Hora Prevista / Hora Realizada / Situação / Observação se a API de alvos trouxer esses campos (inspecionar o retorno bruto de `/mapa_servicos/alvos`). |

### Estados de UI

- Toggle: dois botões segmentados, modo ativo destacado. Persiste em estado local (não na URL).
- Modo Operação sem veículo selecionado: barra Unitrac com a árvore; mapa com toda a frota.
- Modo Alertas: comportamento atual (grupos colapsáveis).
- Loading do popup de alvo enriquecido: enquanto busca, mostra os campos já conhecidos.

## Fora de escopo

- Áreas/Pontos de interesse editáveis (o Unitrac tem; aqui as bases já aparecem como polígono).
- Botões de pânico/mensagem do popup do Unitrac (sirene/bloqueio já existem; pânico é entrada,
  não comando).
- Recalibrar o detector de ignição noturna (assunto separado, já discutido com o cliente).

## Verificação

- `npx tsc --noEmit` limpo e `npx vitest run` 100% antes e depois de cada task.
- Validação visual via Chrome headless logado (toggle alterna as barras; rastro/pontos
  aparecem; popups enriquecidos).
- Sem travessão em texto de UI; português com acentos; zero dependência nova; nenhum secret
  no repo.
