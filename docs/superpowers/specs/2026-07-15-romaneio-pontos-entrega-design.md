# Romaneio como fonte dos pontos de entrega, Design

**Data:** 2026-07-15
**Status:** aprovado pelo usuário, indo para plano

## Problema

Hoje os pontos de entrega (`PontoEntrega`, usados por TODA a detecção de desvio —
Camada 1, cerca virtual, bypass de entrega) vêm 100% ao vivo da API da Unitrac
(`POST /mapa_servicos/alvos`), a cada ciclo do motor. As coordenadas (`pontolatitude`/
`pontolongitude`) às vezes estão erradas na Unitrac — o usuário tem, todo dia, o
romaneio de entrega real da Nutry Max (PDF, ~100+ páginas, um por veículo) com o
endereço textual de cada cliente, que é mais confiável.

O romaneio tem esta estrutura (confirmada lendo `Romaneio 15-07.pdf`, 103 páginas):

```
CARGA/DESTINO: 93587 / NATIVIDADE          PLACA/MOTORISTA: TUL1C38 / LUCAS DOS SANTOS FERREIRA
AJUDANTE(S): JEFFERSON LUIZ CASTRO COSTA ,

NF / CLIENTE: 2272484 / 137039 - SUPERMERCADO SANSAO
RUA MONS MIGUEL REIS MELLO, 33 - LIBERDADE, NATIVIDADE - *
--------------------------------------------------------
NF / CLIENTE: 2272485 / 137744 - SURPERMERCADO SANSAO
AV AMARAL PEIXOTO, 37 - CENTRO, NATIVIDADE - LOJA B
--------------------------------------------------------
...
            Total de 22 clientes
```

Uma seção por veículo (placa sem hífen, ex. `TUL1C38`), pode ocupar várias páginas
(o cabeçalho `CARGA/DESTINO`/`PLACA/MOTORISTA` se repete no topo de cada página de
continuação). Não existe ordem de entrega (confirmado em 11/07, ver
`docs/superpowers/specs/2026-07-11-desvio-redesenho-fundamentado-design.md`) — o
romaneio também não traz uma.

**Validação técnica feita antes deste design:** testei a API `/mapa_servicos/alvos` ao
vivo pro veículo `TUL-1C38` (cv `18594`) e confirmei que `alvodocumento` (ex.:
`"2272491"`) bate exatamente com o número da NF do romaneio, `pontoidentificador`
(ex.: `"158027"`) bate com o código do cliente, e `alvorota` (ex.: `"93587"`) bate com
o código de CARGA/DESTINO. Isso significa que dá pra cruzar cada linha do romaneio com
o status ao vivo da Unitrac (`alvosituacaoservico`: 0=pendente, 1=feito, 98=confirmado)
usando `alvodocumento` como chave, sem precisar confiar na Unitrac pra coordenada nem
pra saber QUAIS entregas existem no dia.

## Decisões (tomadas com o usuário nesta sessão)

1. **Ingestão:** upload manual do PDF numa tela nova do painel (não email, não script
   avulso) — feito todo dia pela operação.
2. **Papel do romaneio:** substitui completamente a Unitrac como fonte da LISTA de
   pontos (endereço, coordenada, quais NFs existem no dia). A Unitrac continua sendo
   consultada a cada ciclo do motor como hoje, mas só pra saber se uma NF já foi
   marcada como feita — nunca mais pra coordenada ou pra decidir quais pontos existem.
3. **Geocodificação:** Google Geocoding primeiro (mesmo padrão já usado no projeto pra
   geocode reverso), Nominatim de fallback gratuito. Cache agressivo por endereço
   normalizado (a maioria dos clientes se repete entre dias) pra manter o custo baixo
   com o tempo.
4. **Ciclo diário:** "apagar o arquivo, salvar só os pontos" — o PDF em si nunca é
   persistido em disco/storage, só processado em memória durante o upload. Os pontos
   extraídos ficam no banco, escopados por veículo + data. Romaneios de dias
   anteriores não são apagados (ficam como histórico/auditoria, útil pra calibração
   futura), só deixam de ser usados pelo motor assim que existe um romaneio mais
   recente pro mesmo veículo.
5. **Rede de segurança:** se não existe romaneio de HOJE pra um veículo (ex.: antes do
   upload da manhã, ou operação esqueceu de subir), o motor cai de volta no
   comportamento atual (100% Unitrac, `agruparPontosPorPlaca`) só pra esse veículo —
   nada quebra, o sistema não fica sem pontos.

## Escopo

Cinco peças novas, nenhuma mudança nos detectores em si (Camada 1, cerca virtual,
bypass) — eles continuam recebendo `PontoEntrega[]` no mesmo formato de sempre, só a
ORIGEM desses pontos muda:

1. Migration: tabelas `romaneio_pontos` e `romaneio_geocode_cache`.
2. Parser puro do romaneio (texto → estrutura), testável sem PDF real.
3. Módulo de geocodificação com cache + fallback (Google → Nominatim → coordenada da
   Unitrac pra aquela NF, se existir).
4. Rota de upload (`POST /api/romaneio/upload`) + tela (`/romaneio`).
5. Motor: função que monta `PontoEntrega[]` a partir de `romaneio_pontos` de hoje
   (cruzando status com a Unitrac por `alvodocumento`), com fallback pro caminho atual
   quando não há romaneio de hoje pro veículo.

Fora de escopo: qualquer mudança em como "feito" é definido (continua 100% Unitrac,
decisão já tomada nesta sessão); qualquer mudança nos detectores de desvio em si;
suporte a formatos de romaneio de outros clientes além da Nutry Max (o formato é
específico dela — se a Benassi tiver um formato diferente, é extensão futura).

## 1. Migration — `romaneio_pontos` e `romaneio_geocode_cache`

```sql
CREATE TABLE romaneio_pontos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  veiculo_id uuid REFERENCES veiculos(id),
  placa text NOT NULL,               -- normalizada com hifen, ex. "TUL-1C38"
  romaneio_data date NOT NULL,       -- data do romaneio (do cabecalho do PDF)
  nf text NOT NULL,                  -- bate com alvodocumento da Unitrac
  cliente_codigo text,
  cliente_nome text NOT NULL,
  endereco_bruto text NOT NULL,      -- linha exata do PDF
  carga_destino_codigo text,
  carga_destino_nome text,
  lat double precision,
  lng double precision,
  geocode_status text NOT NULL DEFAULT 'pendente',  -- ok | fallback_unitrac | falhou
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX romaneio_pontos_veiculo_data_idx ON romaneio_pontos (veiculo_id, romaneio_data);

CREATE TABLE romaneio_geocode_cache (
  endereco_normalizado text PRIMARY KEY,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  fonte text NOT NULL,               -- google | nominatim
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
```

Sem `pontoCodigo` própria (o conceito de "vários NFs no mesmo endereço" já existe nos
dados brutos — várias linhas de `romaneio_pontos` podem ter o mesmo `endereco_bruto`
pro mesmo veículo/data; não precisa de uma FK extra pra isso, o motor agrupa por
endereço geocodificado igual quando precisar, do mesmo jeito que já lida com
`pontoCodigo` repetido vindo da Unitrac hoje).

`veiculo_id` fica nullable de propósito: se a placa do romaneio não bater com nenhum
veículo cadastrado, a linha ainda é salva (pro resumo do upload mostrar o aviso e pra
não perder o dado), só não entra na lista de pontos que o motor usa.

## 2. Parser (`src/lib/romaneio.ts`, função pura)

```ts
export type LinhaRomaneio = {
  placaBruta: string;          // ex. "TUL1C38", sem hifen
  motorista: string;
  cargaDestinoCodigo: string;  // ex. "93587"
  cargaDestinoNome: string;    // ex. "NATIVIDADE"
  nf: string;
  clienteCodigo: string;
  clienteNome: string;
  enderecoBruto: string;
};

export function normalizarPlaca(placaBruta: string): string {
  const limpa = placaBruta.trim().toUpperCase();
  if (limpa.includes("-") || limpa.length !== 7) return limpa;
  return `${limpa.slice(0, 3)}-${limpa.slice(3)}`;
}

// Data do romaneio vem do cabecalho de cada pagina (ex. "15/07/2026 06:17",
// canto superior direito), NUNCA da hora do upload -- evita problema se o
// upload acontecer tarde da noite ou de madrugada pro dia seguinte. Pega a
// PRIMEIRA data encontrada no texto (todas as paginas do mesmo romaneio tem
// a mesma data impressa).
export function extrairDataRomaneio(textoCompleto: string): string | null {
  const m = textoCompleto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`; // YYYY-MM-DD, formato de `date` do Postgres
}

// Recebe o texto extraido do PDF (uma string so, todas as paginas
// concatenadas na ordem) e retorna todas as linhas de entrega encontradas.
// Formato esperado por secao (repete por pagina de continuacao):
//   CARGA/DESTINO: <codigo> / <nome>          PLACA/MOTORISTA: <placa> / <motorista>
//   [AJUDANTE(S): ...]
//   NF / CLIENTE: <nf> / <codigo> - <nome>
//   <endereco>
//   -------- (repete)
//   Total de N clientes
export function parseRomaneio(textoCompleto: string): LinhaRomaneio[] {
  const linhas: LinhaRomaneio[] = [];
  let atual: { cargaDestinoCodigo: string; cargaDestinoNome: string; placaBruta: string; motorista: string } | null = null;

  const regexCabecalho = /CARGA\/DESTINO:\s*(\S+)\s*\/\s*(.+?)\s+PLACA\/MOTORISTA:\s*(\S+)\s*\/\s*(.+)/;
  const regexNfCliente = /NF\s*\/\s*CLIENTE:\s*(\S+)\s*\/\s*(\S+)\s*-\s*(.+)/;

  const brutas = textoCompleto.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < brutas.length; i++) {
    const cab = brutas[i].match(regexCabecalho);
    if (cab) {
      atual = {
        cargaDestinoCodigo: cab[1].trim(),
        cargaDestinoNome: cab[2].trim(),
        placaBruta: cab[3].trim(),
        motorista: cab[4].trim(),
      };
      continue;
    }
    const nfMatch = brutas[i].match(regexNfCliente);
    if (nfMatch && atual) {
      const enderecoBruto = brutas[i + 1] ?? "";
      linhas.push({
        placaBruta: atual.placaBruta,
        motorista: atual.motorista,
        cargaDestinoCodigo: atual.cargaDestinoCodigo,
        cargaDestinoNome: atual.cargaDestinoNome,
        nf: nfMatch[1].trim(),
        clienteCodigo: nfMatch[2].trim(),
        clienteNome: nfMatch[3].trim(),
        enderecoBruto,
      });
    }
  }
  return linhas;
}
```

Extração de texto do PDF em si usa uma lib padrão (`pdf-parse`, já amplamente usada em
projetos Next.js) na rota de upload — o parser acima só trabalha em cima do texto já
extraído, o que permite testar sem PDF de verdade (fixture de texto).

## 3. Geocodificação (`src/lib/romaneio-geocode.ts`)

```ts
export type ResultadoGeocode = { lat: number; lng: number; fonte: "google" | "nominatim" | "unitrac" } | null;

export function normalizarEndereco(enderecoBruto: string): string {
  return enderecoBruto.trim().toUpperCase().replace(/\s+/g, " ");
}

export async function geocodificarEndereco(
  enderecoBruto: string,
  buscarCache: (chave: string) => Promise<{ lat: number; lng: number; fonte: string } | null>,
  salvarCache: (chave: string, r: { lat: number; lng: number; fonte: string }) => Promise<void>,
  coordenadaUnitracFallback: { lat: number; lng: number } | null
): Promise<ResultadoGeocode> {
  const chave = normalizarEndereco(enderecoBruto);
  const doCache = await buscarCache(chave);
  if (doCache) return { lat: doCache.lat, lng: doCache.lng, fonte: doCache.fonte as "google" | "nominatim" };

  const google = await geocodificarGoogle(enderecoBruto);
  if (google) {
    await salvarCache(chave, { ...google, fonte: "google" });
    return { ...google, fonte: "google" };
  }
  const nominatim = await geocodificarNominatim(enderecoBruto);
  if (nominatim) {
    await salvarCache(chave, { ...nominatim, fonte: "nominatim" });
    return { ...nominatim, fonte: "nominatim" };
  }
  if (coordenadaUnitracFallback) {
    return { ...coordenadaUnitracFallback, fonte: "unitrac" };
  }
  return null;
}
```

`geocodificarGoogle`/`geocodificarNominatim` são as mesmas chamadas HTTP que
`lib/roubocarga.ts`/geocode reverso já fazem hoje pro padrão inverso — reaproveita a
mesma chave (`GOOGLE_MAPS_API_KEY`) e o mesmo endpoint público do Nominatim, só que
`geocode` (endereço→coordenada) em vez de `reverse` (coordenada→endereço).

O `coordenadaUnitracFallback` é resolvido pela rota de upload ANTES de chamar essa
função: busca os alvos ao vivo da Unitrac pro veículo (já precisa fazer isso mesmo,
pra cruzar NF/status — ver seção 5) e, se achar um alvo com o mesmo `alvodocumento`
(NF), usa `pontolatitude`/`pontolongitude` dele como último recurso.

## 4. Rota de upload e tela

`POST /api/romaneio/upload` (multipart, campo `arquivo`):
1. Extrai texto do PDF em memória (`pdf-parse`), nunca escreve o arquivo em disco.
2. `extrairDataRomaneio(texto)` — se não achar nenhuma data no cabeçalho, aborta com
   erro claro pro usuário ("não consegui achar a data no PDF, confirma que é o
   romaneio certo") em vez de assumir a data de hoje silenciosamente.
3. `parseRomaneio(texto)`.
5. Pra cada `placaBruta` única, resolve `veiculo_id` (join com `veiculos.placa`
   normalizada) — placa sem match vira aviso no resumo, não interrompe o upload.
6. Busca os alvos ao vivo da Unitrac por CV dos veículos envolvidos (mesma função
   `buscarAlvos` que o motor já usa) — usa pra (a) fallback de coordenada quando o
   geocode falha, (b) status inicial no `INSERT`.
7. Geocodifica cada endereço único (cache primeiro).
8. `INSERT` em `romaneio_pontos` (uma linha por linha do romaneio, `romaneio_data`
   vinda do Passo 2).
9. Responde com resumo: N linhas processadas, M geocodificadas ok, K em fallback
   Unitrac, J sem coordenada nenhuma, placas não encontradas.

Tela `/romaneio` (dentro do route group `(app)`, autenticada como o resto do painel):
input de arquivo + botão "Processar" + exibição do resumo depois de processar. Sem
preview de progresso granular na v1 (KISS) — a chamada pode levar de alguns segundos
a ~1-2min dependendo de quantos endereços são novos (não estão no cache), aceitável
pra uma ação manual de uma vez por dia.

## 5. Motor — nova fonte de `pendentes`

Nova função em `src/lib/romaneio.ts`:

```ts
export function montarPontosDeRomaneio(
  linhasDoVeiculoHoje: { nf: string; clienteNome: string; lat: number | null; lng: number | null }[],
  alvosUnitracDoVeiculo: AlvoUnitrac[]  // resposta ja buscada de buscarAlvos, filtrada pela placa
): PontoEntrega[] {
  const statusPorNf = new Map(alvosUnitracDoVeiculo.map((a) => [a.alvodocumento, a]));
  return linhasDoVeiculoHoje
    .filter((l) => l.lat !== null && l.lng !== null)
    .map((l) => {
      const alvo = statusPorNf.get(l.nf);
      return {
        lat: l.lat!,
        lng: l.lng!,
        raio: alvo?.pontoraio ?? 50,
        ordem: 0,
        nome: l.clienteNome,
        feito: alvo ? alvo.alvosituacaoservico !== 0 : false,
        situacao: alvo?.alvosituacaoservico ?? 0,
        codigo: alvo?.alvocodigo ?? null,
        pontoCodigo: alvo?.pontocodigo ?? null,
        documento: l.nf,
        identificador: alvo?.pontoidentificador ?? null,
        dataInicio: alvo?.alvodatainicio ?? null,
        dataRealizado: alvo?.alvodatarealizado ?? null,
        observacoes: alvo?.alvoobservacoes ?? null,
        rota: alvo?.alvorota ?? null,
      } satisfies PontoEntrega;
    });
}
```

Em `route.ts`, onde hoje `pontosPorPlaca = alvosResultado.value.pontos` (linha ~857):
antes de montar `pontosVeiculo` pra cada placa (linha ~1020), checa se existe
`romaneio_pontos` de HOJE pra aquele `veiculo_id` (uma query por cliente, cacheada
igual o resto do motor já faz com bases/frota, não por veículo — busca todos de uma
vez com `WHERE romaneio_data = current_date AND veiculo_id = ANY($1)`). Se existir,
usa `montarPontosDeRomaneio`; se não, usa `pontosPorPlaca.get(pos.placa)` como hoje
(rede de segurança da decisão 5).

## Testes

- `parseRomaneio`: fixture de texto com 2 seções (incluindo uma que atravessa "página"
  — cabeçalho repetido), confirma que agrupa certo por veículo, pega NF+cliente+
  endereço corretamente, ignora o "Total de N clientes".
- `extrairDataRomaneio`: texto com "15/07/2026 06:17" no cabeçalho retorna
  `"2026-07-15"`; texto sem nenhuma data no formato esperado retorna `null`.
- `normalizarPlaca`: com e sem hífen, tamanho errado (não mexe).
- `geocodificarEndereco`: cache hit não chama nenhuma API; cache miss tenta Google,
  cai pro Nominatim se Google falhar, cai pro fallback Unitrac se os dois falharem,
  retorna `null` se não há fallback nenhum.
- `montarPontosDeRomaneio`: NF com alvo correspondente pega o status certo; NF sem
  alvo correspondente (ainda não sincronizou na Unitrac) vira pendente por padrão;
  linha sem lat/lng (geocode falhou sem fallback) é excluída da lista.
- Suite completa (`npx vitest run`) + `tsc`/`eslint`/`build` limpos nos dois repos
  antes do push, mesma disciplina de sempre.

## Próximos passos (não neste plano)

- Formato de romaneio de outros clientes (Benassi), se for diferente do da Nutry Max.
- Tela de histórico de romaneios processados (hoje só mostra o resumo do upload atual).
- Alertar a operação se ninguém subiu o romaneio do dia até um certo horário (hoje é
  silencioso — o motor só cai pro fallback Unitrac, sem avisar ninguém disso).
