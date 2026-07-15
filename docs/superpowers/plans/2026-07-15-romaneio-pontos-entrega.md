# Romaneio como Fonte dos Pontos de Entrega — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o romaneio diário (PDF da Nutry Max) substituir a Unitrac como fonte
da LISTA e da COORDENADA dos pontos de entrega, mantendo a Unitrac como única fonte do
status (feito/pendente) por NF, com fallback automático pro comportamento atual quando
não há romaneio de hoje pra um veículo.

**Architecture:** Upload de PDF numa tela nova → parse em texto puro (funções
testáveis sem PDF real) → geocodifica cada endereço único (cache + Google + Nominatim
+ fallback pra coordenada da Unitrac) → grava em `romaneio_pontos` (nunca persiste o
PDF em si). No motor, uma função pura nova (`montarPontosDeRomaneio`) combina os
pontos de hoje (endereço/coordenada) com o status ao vivo que o motor JÁ busca da
Unitrac todo ciclo (`pontosPorPlaca`, casando por NF/`documento`) — sem chamada extra
à Unitrac.

**Tech Stack:** TypeScript, Next.js API routes + Server Components, `pdf-parse`,
Postgres (`pg`), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md`.
- O PDF nunca é escrito em disco/storage — só processado em memória durante o
  request de upload.
- `romaneio_data` vem do cabeçalho do PDF (`extrairDataRomaneio`), nunca da hora do
  upload.
- Se não existir `romaneio_pontos` de HOJE pra um veículo, o motor usa o caminho
  atual (100% Unitrac) pra esse veículo — nenhuma regressão de cobertura.
- **Achado durante o planejamento (importante, simplifica o design original):** o
  motor JÁ busca os alvos da Unitrac todo ciclo em `pontosPorPlaca` (`route.ts:857`),
  que já tem `documento` (NF) e `feito`/`situacao` por ponto. `montarPontosDeRomaneio`
  não precisa buscar a Unitrac de novo — só cruza com o que o motor já tem em mãos
  naquele ciclo. Isso muda a assinatura da função descrita na spec (lá ela recebia
  `AlvoUnitrac[]`; aqui recebe `PontoEntrega[]` já processado) — mais simples, zero
  chamada de rede a mais no motor.
- `GOOGLE_MAPS_API_KEY` (server-side, SEM `NEXT_PUBLIC_`) não está setada em
  `.env.local` hoje — só existe `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, que é restrita a
  referenciadores HTTP no console do Google e NÃO funciona em chamada server-side
  (sem referrer). Enquanto `GOOGLE_MAPS_API_KEY` não for adicionada (nova chave, sem
  restrição de referrer, ou restrita por IP), a geocodificação vai cair pro Nominatim
  sempre — o código funciona do mesmo jeito (fallback automático), só não usa Google
  até essa chave existir. Isso é uma decisão de configuração do usuário, não bloqueia
  este plano.
- Toda mudança precisa passar `npx tsc --noEmit`, `npx eslint <arquivo>` e
  `npx vitest run` (suite inteira) antes de commit.
- Regra do projeto: qualquer commit num dos dois repos (`MONITORAMENTO TEMP` e
  `MONITORAMENTO transmonseg`) precisa ser espelhado e pushado no outro no mesmo lote
  de trabalho (Task 8).
- Migrations não rodam automático — aplicar manualmente com
  `node --env-file=.env.local scripts/aplicar-migration.mjs 020_romaneio_pontos.sql`
  (padrão do projeto, ver `scripts/aplicar-migration.mjs`).

---

### Task 1: Migration `020_romaneio_pontos.sql` + dependência `pdf-parse`

**Files:**
- Create: `scripts/migrations/020_romaneio_pontos.sql`
- Modify: `package.json` (dependência `pdf-parse`)

**Interfaces:**
- Produces: tabelas `romaneio_pontos` e `romaneio_geocode_cache` no banco (usadas
  pelas Tasks 3, 5, 7); pacote `pdf-parse` disponível pra Task 5.

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- 020_romaneio_pontos.sql
-- Romaneio diario (Nutry Max) como fonte dos pontos de entrega -- ver
-- docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

CREATE TABLE romaneio_pontos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  veiculo_id uuid REFERENCES veiculos(id),
  placa text NOT NULL,
  romaneio_data date NOT NULL,
  nf text NOT NULL,
  cliente_codigo text,
  cliente_nome text NOT NULL,
  endereco_bruto text NOT NULL,
  carga_destino_codigo text,
  carga_destino_nome text,
  lat double precision,
  lng double precision,
  geocode_status text NOT NULL DEFAULT 'pendente',
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX romaneio_pontos_veiculo_data_idx ON romaneio_pontos (veiculo_id, romaneio_data);

CREATE TABLE romaneio_geocode_cache (
  endereco_normalizado text PRIMARY KEY,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  fonte text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Aplicar a migration**

Run: `cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP" && node --env-file=.env.local scripts/aplicar-migration.mjs 020_romaneio_pontos.sql`
Expected: `OK — migration aplicada.` e a lista de tabelas impressa inclui
`romaneio_pontos` e `romaneio_geocode_cache`.

- [ ] **Step 3: Instalar `pdf-parse`**

Run: `npm install pdf-parse`
Expected: `package.json`/`package-lock.json` atualizados, sem erro.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/020_romaneio_pontos.sql package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(romaneio): migration das tabelas de pontos e cache de geocode

romaneio_pontos (por veiculo+data, NF, endereco, coordenada) e
romaneio_geocode_cache (endereco normalizado -> coordenada, reuso entre
dias). Aplicada em producao. Adiciona pdf-parse como dependencia pro
parser da Task 2.

Ver docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Parser do romaneio (`src/lib/romaneio.ts`) — CONCLUÍDA

**Achado real ao executar o Step 1 (importante):** o texto que o `pdf-parse` v2
extrai NÃO bate com a ordem visual do PDF renderizado, nem com o formato assumido na
spec original. Confirmado com o texto real do romaneio de 15/07:

1. **`pdf-parse` v2 mudou de API** — não é mais `require("pdf-parse")(buffer)` (v1),
   é `new (require("pdf-parse").PDFParse)({ data: buffer })` seguido de
   `await parser.getText()`.
2. **Cabeçalho vem na ordem PLACA primeiro**, separado de CARGA/DESTINO por um
   caractere de TAB, não na ordem/separador assumidos:
   `PLACA/MOTORISTA: TUL1C38 / LUCAS DOS SANTOS FERREIRA<TAB>CARGA/DESTINO: 93587 / NATIVIDADE`
3. **O rótulo "NF / CLIENTE:" sai como linha própria, DEPOIS dos dados da entrega
   anterior** (sobra de como o PDF pagina o layout) — nunca colado na linha de dados
   como a renderização visual sugere. A linha de dados é só
   `<nf> / <codigoCliente> - <nomeCliente>`, sem prefixo.
4. Esse rótulo solto, mais as linhas `Total de N clientes` e `-- N of M --`
   (marcador de página do próprio `pdf-parse`), nunca batem em `REGEX_CABECALHO` nem
   em `REGEX_NF_CLIENTE` — são ignoradas naturalmente pelo loop, sem precisar de
   filtro explícito.

**Files:**
- Create: `src/lib/romaneio.ts`
- Create: `src/lib/romaneio.test.ts`

**Interfaces:**
- Produces:
  - `normalizarPlaca(placaBruta: string): string`
  - `extrairDataRomaneio(textoCompleto: string): string | null`
  - `type LinhaRomaneio = { placaBruta: string; motorista: string; cargaDestinoCodigo: string; cargaDestinoNome: string; nf: string; clienteCodigo: string; clienteNome: string; enderecoBruto: string }`
  - `parseRomaneio(textoCompleto: string): LinhaRomaneio[]`

- [x] **Step 1: Extrair o texto real do PDF de amostra e conferir o formato**

```bash
node -e '
const fs = require("fs");
const { PDFParse } = require("pdf-parse");
(async () => {
  const parser = new PDFParse({ data: fs.readFileSync("/Users/joaquimsalles/Downloads/Romaneio 15-07.pdf") });
  const result = await parser.getText();
  console.log(JSON.stringify(result.text.split("\n").slice(0, 40)));
})();
'
```
Resultado real (ver achado acima) — motivou a reescrita dos regexes abaixo antes de
qualquer teste ser escrito.

- [x] **Step 2-5: Testes + implementação (regexes corrigidos pro formato real)**

```ts
// src/lib/romaneio.ts
export type LinhaRomaneio = {
  placaBruta: string;
  motorista: string;
  cargaDestinoCodigo: string;
  cargaDestinoNome: string;
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

export function extrairDataRomaneio(textoCompleto: string): string | null {
  const m = textoCompleto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Formato real (ver achado acima): PLACA/MOTORISTA antes de CARGA/DESTINO,
// separados por TAB (\s+ ja cobre); linha de dados da entrega SEM o rotulo
// "NF / CLIENTE:" colado (ele sai como linha solta, ignorada por nao bater
// em nenhum dos 2 regexes).
const REGEX_CABECALHO = /PLACA\/MOTORISTA:\s*(\S+)\s*\/\s*(.+?)\s+CARGA\/DESTINO:\s*(\S+)\s*\/\s*(.+)/;
const REGEX_NF_CLIENTE = /^(\S+)\s*\/\s*(\S+)\s*-\s*(.+)$/;

export function parseRomaneio(textoCompleto: string): LinhaRomaneio[] {
  const linhas: LinhaRomaneio[] = [];
  let atual: { cargaDestinoCodigo: string; cargaDestinoNome: string; placaBruta: string; motorista: string } | null = null;

  const brutas = textoCompleto.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < brutas.length; i++) {
    const cab = brutas[i].match(REGEX_CABECALHO);
    if (cab) {
      atual = {
        placaBruta: cab[1].trim(),
        motorista: cab[2].trim(),
        cargaDestinoCodigo: cab[3].trim(),
        cargaDestinoNome: cab[4].trim(),
      };
      continue;
    }
    const nfMatch = brutas[i].match(REGEX_NF_CLIENTE);
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

Testes completos (9 `it`, incluindo o caso de endereço com "S/N" pra confirmar que
não é confundido com uma nova linha de NF) em `src/lib/romaneio.test.ts` no repo —
todos passando.

- [x] **Step 6: Validado contra o PDF real completo (103 páginas)**

`linhas parseadas: 1826` == `soma dos totais declarados no PDF: 1826` (70 seções, 70
placas distintas) — bate exato, confirma que o parser não perde nem duplica nenhuma
seção ao longo do arquivo inteiro.

- [x] **Step 7: Commit**

```bash
git add src/lib/romaneio.ts src/lib/romaneio.test.ts
git commit -m "$(cat <<'EOF'
feat(romaneio): parser puro do romaneio diario (texto -> estrutura)

normalizarPlaca (hifen na 3a posicao), extrairDataRomaneio (do cabecalho
impresso, nunca da hora do upload) e parseRomaneio (extrai NF, cliente,
endereco e placa/carga por secao, atravessando paginas de continuacao).
Regexes corrigidos apos investigar o texto REAL extraido pelo pdf-parse
v2, que difere da ordem visual do PDF (placa antes de carga/destino,
separados por tab; rotulo "NF / CLIENTE:" sai como linha solta e fora de
ordem, nunca colado na linha de dados). Validado contra as 103 paginas do
romaneio real de 15/07 -- 1826 linhas parseadas bate exato com a soma dos
"Total de N clientes" declarados (70 secoes).

Ver docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Geocodificação (`src/lib/romaneio-geocode.ts`)

**Files:**
- Create: `src/lib/romaneio-geocode.ts`
- Create: `src/lib/romaneio-geocode.test.ts`

**Interfaces:**
- Produces:
  - `normalizarEndereco(enderecoBruto: string): string`
  - `type ResultadoGeocode = { lat: number; lng: number; fonte: "google" | "nominatim" | "unitrac" } | null`
  - `geocodificarEndereco(enderecoBruto: string, deps: { buscarCache, salvarCache, geocodificarGoogle, geocodificarNominatim }, coordenadaUnitracFallback: { lat: number; lng: number } | null): Promise<ResultadoGeocode>`
  - `geocodificarGoogle(enderecoBruto: string): Promise<{ lat: number; lng: number } | null>` (chamada HTTP real, usa `process.env.GOOGLE_MAPS_API_KEY`)
  - `geocodificarNominatim(enderecoBruto: string): Promise<{ lat: number; lng: number } | null>` (chamada HTTP real)
- Consumes: nada de outras tasks — função `geocodificarEndereco` recebe as
  implementações de cache/API via parâmetro (injeção de dependência), o que permite
  testar a lógica de fallback com mocks, sem mockar `fetch` global nem banco.

- [ ] **Step 1: Escrever os testes que falham**

```ts
import { describe, it, expect, vi } from "vitest";
import { normalizarEndereco, geocodificarEndereco } from "./romaneio-geocode";

describe("normalizarEndereco", () => {
  it("maiuscula, sem espacos duplicados, sem espaco nas pontas", () => {
    expect(normalizarEndereco("  rua  teste,  10 - centro  ")).toBe("RUA TESTE, 10 - CENTRO");
  });
});

describe("geocodificarEndereco (fallback: cache -> google -> nominatim -> unitrac)", () => {
  const mockDeps = (overrides: Partial<{
    buscarCache: () => Promise<{ lat: number; lng: number; fonte: string } | null>;
    salvarCache: () => Promise<void>;
    geocodificarGoogle: () => Promise<{ lat: number; lng: number } | null>;
    geocodificarNominatim: () => Promise<{ lat: number; lng: number } | null>;
  }> = {}) => ({
    buscarCache: vi.fn(overrides.buscarCache ?? (async () => null)),
    salvarCache: vi.fn(overrides.salvarCache ?? (async () => {})),
    geocodificarGoogle: vi.fn(overrides.geocodificarGoogle ?? (async () => null)),
    geocodificarNominatim: vi.fn(overrides.geocodificarNominatim ?? (async () => null)),
  });

  it("cache hit: nao chama nenhuma API", async () => {
    const deps = mockDeps({ buscarCache: async () => ({ lat: 1, lng: 2, fonte: "google" }) });
    const r = await geocodificarEndereco("Rua X, 1", deps, null);
    expect(r).toEqual({ lat: 1, lng: 2, fonte: "google" });
    expect(deps.geocodificarGoogle).not.toHaveBeenCalled();
    expect(deps.geocodificarNominatim).not.toHaveBeenCalled();
  });

  it("cache miss, Google funciona: usa Google e salva no cache", async () => {
    const deps = mockDeps({ geocodificarGoogle: async () => ({ lat: 3, lng: 4 }) });
    const r = await geocodificarEndereco("Rua X, 1", deps, null);
    expect(r).toEqual({ lat: 3, lng: 4, fonte: "google" });
    expect(deps.salvarCache).toHaveBeenCalledWith(expect.any(String), { lat: 3, lng: 4, fonte: "google" });
    expect(deps.geocodificarNominatim).not.toHaveBeenCalled();
  });

  it("Google falha, Nominatim funciona: usa Nominatim e salva no cache", async () => {
    const deps = mockDeps({ geocodificarNominatim: async () => ({ lat: 5, lng: 6 }) });
    const r = await geocodificarEndereco("Rua X, 1", deps, null);
    expect(r).toEqual({ lat: 5, lng: 6, fonte: "nominatim" });
  });

  it("Google e Nominatim falham, com fallback Unitrac: usa a coordenada da Unitrac", async () => {
    const deps = mockDeps();
    const r = await geocodificarEndereco("Rua X, 1", deps, { lat: 7, lng: 8 });
    expect(r).toEqual({ lat: 7, lng: 8, fonte: "unitrac" });
  });

  it("Google, Nominatim e fallback Unitrac indisponiveis: null", async () => {
    const deps = mockDeps();
    const r = await geocodificarEndereco("Rua X, 1", deps, null);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx vitest run src/lib/romaneio-geocode.test.ts`
Expected: FAIL — `romaneio-geocode.ts` ainda não existe.

- [ ] **Step 3: Implementar**

```ts
// src/lib/romaneio-geocode.ts
// Geocodificacao de enderecos do romaneio (endereco -> coordenada), com
// cache e cadeia de fallback. Espelha o padrao ja usado no motor pro
// geocode REVERSO (coordenada -> endereco, ver geocodeReverso em
// api/motor/route.ts) -- mesma chave do Google, mesmo User-Agent do
// Nominatim -- so na direcao contraria.

export function normalizarEndereco(enderecoBruto: string): string {
  return enderecoBruto.trim().toUpperCase().replace(/\s+/g, " ");
}

export type ResultadoGeocode = { lat: number; lng: number; fonte: "google" | "nominatim" | "unitrac" } | null;

type Deps = {
  buscarCache: (chave: string) => Promise<{ lat: number; lng: number; fonte: string } | null>;
  salvarCache: (chave: string, r: { lat: number; lng: number; fonte: string }) => Promise<void>;
  geocodificarGoogle: (enderecoBruto: string) => Promise<{ lat: number; lng: number } | null>;
  geocodificarNominatim: (enderecoBruto: string) => Promise<{ lat: number; lng: number } | null>;
};

export async function geocodificarEndereco(
  enderecoBruto: string,
  deps: Deps,
  coordenadaUnitracFallback: { lat: number; lng: number } | null
): Promise<ResultadoGeocode> {
  const chave = normalizarEndereco(enderecoBruto);
  const doCache = await deps.buscarCache(chave);
  if (doCache) return { lat: doCache.lat, lng: doCache.lng, fonte: doCache.fonte as "google" | "nominatim" };

  const google = await deps.geocodificarGoogle(enderecoBruto);
  if (google) {
    await deps.salvarCache(chave, { ...google, fonte: "google" });
    return { ...google, fonte: "google" };
  }
  const nominatim = await deps.geocodificarNominatim(enderecoBruto);
  if (nominatim) {
    await deps.salvarCache(chave, { ...nominatim, fonte: "nominatim" });
    return { ...nominatim, fonte: "nominatim" };
  }
  if (coordenadaUnitracFallback) {
    return { ...coordenadaUnitracFallback, fonte: "unitrac" };
  }
  return null;
}

// Chamadas HTTP reais -- SEM cache/fallback, isso fica por conta de
// geocodificarEndereco acima. Nao testadas por teste automatizado (chamada
// de rede real); validadas manualmente na Task 5 contra enderecos reais do
// romaneio.
export async function geocodificarGoogle(enderecoBruto: string): Promise<{ lat: number; lng: number } | null> {
  const chave = process.env.GOOGLE_MAPS_API_KEY;
  if (!chave) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(enderecoBruto)}&language=pt-BR&region=br&key=${chave}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { geometry?: { location?: { lat: number; lng: number } } }[] };
    const loc = data.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch {
    return null;
  }
}

export async function geocodificarNominatim(enderecoBruto: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(enderecoBruto)}&format=json&limit=1&countrycodes=br`;
    const res = await fetch(url, {
      headers: { "User-Agent": "TransmonsegCentral/1.0" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { lat?: string; lon?: string }[];
    const primeiro = data[0];
    if (!primeiro?.lat || !primeiro?.lon) return null;
    return { lat: parseFloat(primeiro.lat), lng: parseFloat(primeiro.lon) };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/romaneio-geocode.test.ts && npx vitest run && npx tsc --noEmit && npx eslint src/lib/romaneio-geocode.ts`
Expected: todos os `it` de `romaneio-geocode.test.ts` passando; suite inteira verde;
`tsc`/`eslint` sem output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/romaneio-geocode.ts src/lib/romaneio-geocode.test.ts
git commit -m "$(cat <<'EOF'
feat(romaneio): geocodificacao com cache e fallback Google->Nominatim->Unitrac

geocodificarEndereco orquestra a cadeia (injecao de dependencia, testavel
sem mockar fetch/banco); geocodificarGoogle/geocodificarNominatim fazem as
chamadas reais, espelhando o padrao ja usado no geocode REVERSO do motor
(so que endereco->coordenada em vez de coordenada->endereco).

Ver docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `montarPontosDeRomaneio` — combina romaneio + status ao vivo

**Files:**
- Modify: `src/lib/romaneio.ts` (adicionar ao final do arquivo)
- Modify: `src/lib/romaneio.test.ts` (adicionar testes)

**Interfaces:**
- Consumes: `PontoEntrega` (tipo já existe em `src/lib/unitrac.ts`, importado).
- Produces: `type LinhaRomaneioGeocodificada = { nf: string; clienteNome: string; lat: number; lng: number }` e
  `montarPontosDeRomaneio(pontosRomaneio: LinhaRomaneioGeocodificada[], pontosUnitrac: PontoEntrega[]): PontoEntrega[]`
  — usado pela Task 7 (motor).

- [ ] **Step 1: Escrever os testes que falham**

Adicionar ao final de `src/lib/romaneio.test.ts`:

```ts
import type { PontoEntrega } from "./unitrac";
import { montarPontosDeRomaneio } from "./romaneio";

function pontoUnitrac(overrides: Partial<PontoEntrega> = {}): PontoEntrega {
  return {
    lat: -21, lng: -41, raio: 50, ordem: 0, nome: "x", feito: false, situacao: 0,
    codigo: 1, pontoCodigo: 1, documento: "2272484", identificador: null,
    dataInicio: null, dataRealizado: null, observacoes: null, rota: null,
    ...overrides,
  };
}

describe("montarPontosDeRomaneio", () => {
  it("NF com alvo correspondente na Unitrac: pega o status (feito/situacao) de la", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "SUPERMERCADO SANSAO", lat: -21.04, lng: -41.98 }];
    const unitrac = [pontoUnitrac({ documento: "2272484", feito: true, situacao: 1, pontoraio: undefined as never, raio: 50 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado).toHaveLength(1);
    expect(resultado[0]).toMatchObject({ lat: -21.04, lng: -41.98, feito: true, situacao: 1, documento: "2272484", nome: "SUPERMERCADO SANSAO" });
  });

  it("NF sem alvo correspondente ainda (nao sincronizou): vira pendente por padrao", () => {
    const romaneio = [{ nf: "9999999", clienteNome: "CLIENTE NOVO", lat: -21, lng: -41 }];
    const resultado = montarPontosDeRomaneio(romaneio, []);
    expect(resultado[0]).toMatchObject({ feito: false, situacao: 0, codigo: null, pontoCodigo: null });
  });

  it("usa raio/codigo/pontoCodigo do alvo da Unitrac quando existe (mantem compatibilidade com o resto do motor)", () => {
    const romaneio = [{ nf: "2272484", clienteNome: "X", lat: -21, lng: -41 }];
    const unitrac = [pontoUnitrac({ documento: "2272484", raio: 80, codigo: 555, pontoCodigo: 777 })];
    const resultado = montarPontosDeRomaneio(romaneio, unitrac);
    expect(resultado[0]).toMatchObject({ raio: 80, codigo: 555, pontoCodigo: 777 });
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx vitest run src/lib/romaneio.test.ts`
Expected: FAIL — `montarPontosDeRomaneio` ainda não existe.

- [ ] **Step 3: Implementar**

Adicionar ao final de `src/lib/romaneio.ts`:

```ts
import type { PontoEntrega } from "./unitrac";

export type LinhaRomaneioGeocodificada = {
  nf: string;
  clienteNome: string;
  lat: number;
  lng: number;
};

// Combina os pontos de HOJE vindos do romaneio (endereco/coordenada) com o
// status ao vivo que o motor JA busca da Unitrac todo ciclo (pontosUnitrac,
// ver route.ts:857 `pontosPorPlaca`) -- casando por NF (`documento` ==
// `alvodocumento` da Unitrac, confirmado ao vivo em 15/07/2026 contra a API
// real). Zero chamada de rede extra: reusa o que o motor ja tem em maos
// naquele ciclo. NF sem alvo correspondente ainda (romaneio subiu antes da
// Unitrac sincronizar aquela entrega) fica pendente por padrao -- nunca
// assume "feito" sem confirmacao explicita da Unitrac.
export function montarPontosDeRomaneio(
  pontosRomaneio: LinhaRomaneioGeocodificada[],
  pontosUnitrac: PontoEntrega[]
): PontoEntrega[] {
  const porNf = new Map(pontosUnitrac.filter((p) => p.documento).map((p) => [p.documento as string, p]));
  return pontosRomaneio.map((l) => {
    const alvo = porNf.get(l.nf);
    return {
      lat: l.lat,
      lng: l.lng,
      raio: alvo?.raio ?? 50,
      ordem: 0,
      nome: l.clienteNome,
      feito: alvo?.feito ?? false,
      situacao: alvo?.situacao ?? 0,
      codigo: alvo?.codigo ?? null,
      pontoCodigo: alvo?.pontoCodigo ?? null,
      documento: l.nf,
      identificador: alvo?.identificador ?? null,
      dataInicio: alvo?.dataInicio ?? null,
      dataRealizado: alvo?.dataRealizado ?? null,
      observacoes: alvo?.observacoes ?? null,
      rota: alvo?.rota ?? null,
    } satisfies PontoEntrega;
  });
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/lib/romaneio.test.ts && npx vitest run && npx tsc --noEmit && npx eslint src/lib/romaneio.ts`
Expected: tudo verde.

- [ ] **Step 5: Commit**

```bash
git add src/lib/romaneio.ts src/lib/romaneio.test.ts
git commit -m "$(cat <<'EOF'
feat(romaneio): monta PontoEntrega combinando romaneio + status ao vivo da Unitrac

montarPontosDeRomaneio casa cada linha do romaneio (endereco/coordenada) com
o status (feito/pendente) que o motor JA tem em maos no ciclo, via
documento/alvodocumento (NF) -- sem chamada de rede extra a Unitrac. NF
ainda nao sincronizada fica pendente por padrao.

Ver docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Rota de upload (`POST /api/romaneio/upload`)

**Files:**
- Create: `src/app/api/romaneio/upload/route.ts`

**Interfaces:**
- Consumes: `parseRomaneio`, `extrairDataRomaneio`, `normalizarPlaca` (Task 2);
  `geocodificarEndereco`, `geocodificarGoogle`, `geocodificarNominatim`,
  `normalizarEndereco` (Task 3); `buscarAlvos` (já existe em `src/lib/unitrac.ts`);
  `createAdminClient` (já existe em `src/lib/supabase/admin.ts`).
- Produces: endpoint HTTP consumido pela Task 6 (tela de upload). Resposta JSON:
  `{ ok: true, romaneioData: string, totalLinhas: number, geocodadosOk: number, geocodadosFallbackUnitrac: number, semCoordenada: number, placasNaoEncontradas: string[] }`
  ou `{ ok: false, erro: string }`.

- [ ] **Step 1: Implementar**

**Achado real (importante):** `proxy.ts` só protege PÁGINAS (`matcher` exclui
`/api`, ver `src/proxy.ts`) — rotas de API validam sessão internamente, mesmo padrão
que `/api/mapa` já usa. Sem isso, o upload ficaria aberto a qualquer requisição sem
login.

```ts
// src/app/api/romaneio/upload/route.ts
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseRomaneio, extrairDataRomaneio, normalizarPlaca } from "@/lib/romaneio";
import { geocodificarEndereco, geocodificarGoogle, geocodificarNominatim, normalizarEndereco } from "@/lib/romaneio-geocode";
import { buscarAlvos } from "@/lib/unitrac";

export async function POST(request: Request) {
  // Rotas de API nao passam pelo proxy.ts (so protege paginas) -- validar
  // sessao aqui, mesmo padrao que /api/mapa ja usa.
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return Response.json({ ok: false, erro: "nao autorizado" }, { status: 401 });

  const formData = await request.formData();
  const arquivo = formData.get("arquivo");
  if (!(arquivo instanceof File)) {
    return Response.json({ ok: false, erro: "Nenhum arquivo enviado." }, { status: 400 });
  }

  // pdf-parse v2: classe PDFParse, nao funcao direta (API mudou da v1 --
  // confirmado na Task 2). Import dinamico mantido isolado aqui.
  const { PDFParse } = await import("pdf-parse");
  const buffer = Buffer.from(await arquivo.arrayBuffer());
  const parser = new PDFParse({ data: buffer }); // buffer nunca escrito em disco
  const { text } = await parser.getText();

  const romaneioData = extrairDataRomaneio(text);
  if (!romaneioData) {
    return Response.json({ ok: false, erro: "Não consegui achar a data no cabeçalho do PDF. Confirma que é o romaneio certo." }, { status: 422 });
  }

  const linhas = parseRomaneio(text);
  if (linhas.length === 0) {
    return Response.json({ ok: false, erro: "PDF processado, mas nenhuma linha de entrega foi encontrada -- formato pode ter mudado." }, { status: 422 });
  }

  const admin = createAdminClient();

  // Resolve veiculo_id por placa normalizada.
  const placasUnicas = [...new Set(linhas.map((l) => normalizarPlaca(l.placaBruta)))];
  const { data: veiculos } = await admin.from("veiculos").select("id, placa, cv").in("placa", placasUnicas);
  const veiculoPorPlaca = new Map((veiculos ?? []).map((v) => [v.placa, v]));
  const placasNaoEncontradas = placasUnicas.filter((p) => !veiculoPorPlaca.has(p));

  // Alvos ao vivo da Unitrac pros veiculos envolvidos -- so pra fallback de
  // coordenada quando o geocode falha (o STATUS ao vivo usado pelo motor
  // vem de novo a cada ciclo, ver Task 4 -- aqui e so um snapshot pontual).
  const cvs = [...veiculoPorPlaca.values()].map((v) => v.cv).filter(Boolean);
  const alvos = cvs.length > 0 ? await buscarAlvos(cvs) : [];
  const alvoPorNf = new Map(alvos.map((a) => [a.alvodocumento, a]));

  let geocodadosOk = 0;
  let geocodadosFallbackUnitrac = 0;
  let semCoordenada = 0;

  const buscarCache = async (chave: string) => {
    const { data } = await admin.from("romaneio_geocode_cache").select("lat, lng, fonte").eq("endereco_normalizado", chave).maybeSingle();
    return data ?? null;
  };
  const salvarCache = async (chave: string, r: { lat: number; lng: number; fonte: string }) => {
    await admin.from("romaneio_geocode_cache").upsert({ endereco_normalizado: chave, lat: r.lat, lng: r.lng, fonte: r.fonte, atualizado_em: new Date().toISOString() });
  };

  const linhasParaInserir = [];
  for (const l of linhas) {
    const placaNormalizada = normalizarPlaca(l.placaBruta);
    const veiculo = veiculoPorPlaca.get(placaNormalizada);
    const alvo = alvoPorNf.get(l.nf);
    const fallbackUnitrac = alvo?.pontolatitude && alvo?.pontolongitude
      ? { lat: alvo.pontolatitude, lng: alvo.pontolongitude }
      : null;

    const geocode = await geocodificarEndereco(
      l.enderecoBruto,
      { buscarCache, salvarCache, geocodificarGoogle, geocodificarNominatim },
      fallbackUnitrac
    );

    let geocodeStatus: string;
    if (geocode?.fonte === "unitrac") { geocodadosFallbackUnitrac++; geocodeStatus = "fallback_unitrac"; }
    else if (geocode) { geocodadosOk++; geocodeStatus = "ok"; }
    else { semCoordenada++; geocodeStatus = "falhou"; }

    linhasParaInserir.push({
      veiculo_id: veiculo?.id ?? null,
      placa: placaNormalizada,
      romaneio_data: romaneioData,
      nf: l.nf,
      cliente_codigo: l.clienteCodigo,
      cliente_nome: l.clienteNome,
      endereco_bruto: l.enderecoBruto,
      carga_destino_codigo: l.cargaDestinoCodigo,
      carga_destino_nome: l.cargaDestinoNome,
      lat: geocode?.lat ?? null,
      lng: geocode?.lng ?? null,
      geocode_status: geocodeStatus,
    });
  }

  const { error: erroInsert } = await admin.from("romaneio_pontos").insert(linhasParaInserir);
  if (erroInsert) {
    return Response.json({ ok: false, erro: `Erro ao salvar: ${erroInsert.message}` }, { status: 500 });
  }

  return Response.json({
    ok: true,
    romaneioData,
    totalLinhas: linhas.length,
    geocodadosOk,
    geocodadosFallbackUnitrac,
    semCoordenada,
    placasNaoEncontradas,
  });
}
```

- [ ] **Step 2: Rodar tsc, eslint e a suite inteira**

Run: `npx tsc --noEmit && npx eslint src/app/api/romaneio/upload/route.ts && npx vitest run`
Expected: sem erro. **Nota:** essa rota não tem teste automatizado de integração
neste plano (upload real de PDF + chamadas de rede reais pra geocode/Unitrac) — a
validação é manual no Step 3, via a tela da Task 6.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/romaneio/upload/route.ts
git commit -m "$(cat <<'EOF'
feat(romaneio): rota de upload (POST /api/romaneio/upload)

Extrai texto do PDF em memoria (nunca escreve em disco), acha a data no
cabecalho, faz parse das linhas, resolve veiculo por placa, busca alvos ao
vivo da Unitrac so pra fallback de coordenada, geocodifica cada endereco
(cache -> Google -> Nominatim -> fallback Unitrac) e grava em
romaneio_pontos. Retorna resumo (quantos ok/fallback/sem coordenada,
placas nao encontradas).

Ver docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Tela de upload (`/romaneio`)

**Files:**
- Create: `src/app/(app)/romaneio/page.tsx`
- Modify: `src/app/(app)/layout.tsx` (link de navegação, ao lado dos outros links do
  header)

**Interfaces:**
- Consumes: `POST /api/romaneio/upload` (Task 5), rodando client-side via `fetch`
  num Client Component (precisa de estado local pro resultado do upload — não dá pra
  ser Server Component puro).

- [ ] **Step 1: Implementar a página**

```tsx
// src/app/(app)/romaneio/page.tsx
"use client";

import { useState } from "react";

type ResultadoUpload = {
  ok: boolean;
  erro?: string;
  romaneioData?: string;
  totalLinhas?: number;
  geocodadosOk?: number;
  geocodadosFallbackUnitrac?: number;
  semCoordenada?: number;
  placasNaoEncontradas?: string[];
};

export default function RomaneioPage() {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoUpload | null>(null);

  const processar = async () => {
    if (!arquivo) return;
    setProcessando(true);
    setResultado(null);
    try {
      const formData = new FormData();
      formData.append("arquivo", arquivo);
      const res = await fetch("/api/romaneio/upload", { method: "POST", body: formData });
      const data = (await res.json()) as ResultadoUpload;
      setResultado(data);
    } catch (e) {
      setResultado({ ok: false, erro: `Falha de rede: ${String(e)}` });
    } finally {
      setProcessando(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-4" style={{ color: "var(--text)" }}>
        Romaneio de entrega
      </h1>
      <p className="text-sm mb-4" style={{ color: "var(--text-dim)" }}>
        Sobe o romaneio do dia (PDF) — os pontos de entrega (endereço, coordenada) de
        cada veículo passam a vir daqui em vez da Unitrac. O arquivo não fica salvo,
        só os pontos extraídos.
      </p>

      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
        className="block mb-4 text-sm"
        style={{ color: "var(--text)" }}
      />

      <button
        onClick={processar}
        disabled={!arquivo || processando}
        className="px-4 py-2 rounded text-sm font-medium disabled:opacity-50"
        style={{ backgroundColor: "var(--accent)", color: "var(--bg)" }}
      >
        {processando ? "Processando..." : "Processar romaneio"}
      </button>

      {resultado && (
        <div
          className="mt-6 p-4 rounded text-sm"
          style={{ border: "1px solid var(--border)", color: "var(--text)" }}
        >
          {resultado.ok ? (
            <>
              <p className="font-medium mb-2">
                Romaneio de {resultado.romaneioData} processado.
              </p>
              <ul className="space-y-1" style={{ color: "var(--text-dim)" }}>
                <li>{resultado.totalLinhas} linhas no total</li>
                <li>{resultado.geocodadosOk} geocodificadas com sucesso</li>
                <li>{resultado.geocodadosFallbackUnitrac} usando coordenada da Unitrac (endereço não geocodificou)</li>
                <li>{resultado.semCoordenada} sem coordenada nenhuma</li>
              </ul>
              {resultado.placasNaoEncontradas && resultado.placasNaoEncontradas.length > 0 && (
                <p className="mt-2" style={{ color: "var(--danger, #e55)" }}>
                  Placas não encontradas no cadastro: {resultado.placasNaoEncontradas.join(", ")}
                </p>
              )}
            </>
          ) : (
            <p style={{ color: "var(--danger, #e55)" }}>{resultado.erro}</p>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Adicionar link de navegação no header**

Em `src/app/(app)/layout.tsx`, adicionar um `<Link href="/romaneio">` próximo aos
outros links de navegação existentes no header (mesma seção onde já tem os outros
itens de menu — seguir o padrão visual já usado ali, sem reinventar estilo).

- [ ] **Step 3: Rodar tsc, eslint, suite e build**

Run: `npx tsc --noEmit && npx eslint src/app/\(app\)/romaneio/page.tsx src/app/\(app\)/layout.tsx && npx vitest run && npx next build`
Expected: tudo limpo, `/romaneio` aparece na lista de rotas do build.

- [x] **Step 4: Teste manual end-to-end**

**Achado real:** `proxy.ts` não protege rotas de API — a rota de upload não tinha
checagem de sessão nenhuma até este step, o que deixaria `/api/romaneio/upload`
aberto pra qualquer requisição sem login. Corrigido (mesmo padrão de
`/api/mapa`: `createClient()` + `auth.getUser()` + 401 se `!user`) — ver diff no
código da Task 5 acima.

**Também real:** a automação de navegador (chrome-devtools MCP) estava com o
profile do Chrome travado por outra sessão (`--isolated` não exposto por esse
tool) — em vez de forçar/matar o processo alheio, validação foi feita chamando o
MESMO caminho de código da rota (parser real + geocodificação real + insert real,
sem mock) contra o veículo `TUL1C38` do romaneio real de 15/07 (script temporário,
não commitado, apagado depois): 22 linhas parseadas, veículo resolvido via placa,
22 alvos buscados ao vivo da Unitrac, geocodificação com resultado real (3
Nominatim ok, 18 fallback pra coordenada da Unitrac — a maioria das ruas de
cidade pequena do interior não está no OpenStreetMap, confirma a necessidade do
fallback — 1 sem coordenada nenhuma), 22 linhas gravadas em `romaneio_pontos`.
Confirmado com `curl` que a rota sem sessão retorna 401. Dados de teste
removidos de `romaneio_pontos` depois de validar (não é dado de produção real
completo, só 1 de 70 veículos).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/romaneio/page.tsx" "src/app/(app)/layout.tsx"
git commit -m "$(cat <<'EOF'
feat(romaneio): tela de upload do romaneio diario (/romaneio)

Upload de PDF, mostra resumo depois de processar (linhas, geocodificados
ok/fallback/sem coordenada, placas nao encontradas). Link no header do
painel. Validado manualmente end-to-end contra o romaneio real de 15/07.

Ver docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 7: Motor usa `romaneio_pontos` quando existir (`route.ts`)

**Files:**
- Modify: `src/app/api/motor/route.ts` (novo cache por cliente, próximo ao padrão de
  `cacheFrotaPorCliente`/`CACHE_FROTA_MS` em `route.ts:65-67`; e o ponto onde
  `pontosVeiculo` é montado, `route.ts:1020-1022`).

**Interfaces:**
- Consumes: `montarPontosDeRomaneio` (Task 4).
- Produces: nada consumido por tasks depois — ponto final de integração.

- [ ] **Step 1: Adicionar o cache por cliente (próximo à declaração de `cacheFrotaPorCliente`, `route.ts:65-67`)**

```ts
// Pontos de entrega vindos do romaneio de HOJE, por cliente -- ver
// docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md.
// Mesmo padrao de cache do resto do motor (frota, bases): renova a cada 3
// min, nao precisa reconsultar todo ciclo de 30s.
type RomaneioCache = { pontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number }[]>; expiraEm: number };
const CACHE_ROMANEIO_MS = 3 * 60_000;
const cacheRomaneioPorCliente = new Map<string, RomaneioCache>();
```

- [ ] **Step 2: Buscar os pontos do romaneio de hoje, uma vez por cliente por ciclo**

Próximo de onde `pontosPorPlaca` é resolvido pro cliente (depois de
`route.ts:865`, mesmo escopo do loop `for (const cliente of clientes)`), adicionar:

```ts
      // Pontos do romaneio de HOJE pro cliente -- ver
      // docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md.
      // Cache de 3min (mesmo padrao de bases/frota); so consulta o banco de
      // novo quando expira.
      const cacheRomaneio = cacheRomaneioPorCliente.get(cliente.id);
      let romaneioPontosPorPlaca: Map<string, { nf: string; clienteNome: string; lat: number; lng: number }[]>;
      if (cacheRomaneio && cacheRomaneio.expiraEm > Date.now()) {
        romaneioPontosPorPlaca = cacheRomaneio.pontosPorPlaca;
      } else {
        romaneioPontosPorPlaca = new Map();
        // veiculo_id do cliente: mapaCv e global (todos os clientes),
        // filtra pelo mesmo padrao ja usado acima nesse loop pra cvsCliente
        // (route.ts:810-811) -- nao existe uma lista "veiculos" local nesse
        // escopo (essa so existe no loop de cima, route.ts:479-505, que so
        // preenche cacheFrotaPorCliente/mapaCv).
        const veiculoIdsDoCliente = [...mapaCv.values()]
          .filter((v) => v.cliente_id === cliente.id)
          .map((v) => v.veiculo_id);
        const { data: linhasRomaneio } = await supabase
          .from("romaneio_pontos")
          .select("placa, nf, cliente_nome, lat, lng")
          .eq("romaneio_data", dataHojeSP)
          .not("lat", "is", null)
          .not("lng", "is", null)
          .in("veiculo_id", veiculoIdsDoCliente);
        for (const l of linhasRomaneio ?? []) {
          const lista = romaneioPontosPorPlaca.get(l.placa) ?? [];
          lista.push({ nf: l.nf, clienteNome: l.cliente_nome, lat: l.lat, lng: l.lng });
          romaneioPontosPorPlaca.set(l.placa, lista);
        }
        cacheRomaneioPorCliente.set(cliente.id, { pontosPorPlaca: romaneioPontosPorPlaca, expiraEm: Date.now() + CACHE_ROMANEIO_MS });
      }
```

`dataHojeSP` já existe em `route.ts:448` (`Intl.DateTimeFormat("en-CA", { timeZone:
"America/Sao_Paulo" })`, formato `YYYY-MM-DD`) — reusar essa variável em vez de
`new Date().toISOString()` (que daria a data em UTC, errada perto da meia-noite de
Brasília).

- [ ] **Step 3: Usar o romaneio quando existir, senão o caminho atual (`route.ts:1020-1022`)**

Trecho atual:
```ts
          const pontosVeiculo = pontosPorPlaca.get(pos.placa);
          veiculoIdToAlvos.set(veiculo_id, pontosVeiculo ?? []);
          const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito);
```

Substituir por:

```ts
          // Rede de seguranca (decisao tomada na spec): se existe romaneio de
          // HOJE pra esse veiculo, ele vira a fonte da lista/coordenada; o
          // status (feito/pendente) continua vindo da Unitrac (pontosPorPlaca
          // deste mesmo ciclo -- ver montarPontosDeRomaneio). Sem romaneio de
          // hoje pro veiculo, cai no caminho 100% Unitrac de sempre.
          const romaneioDoVeiculo = romaneioPontosPorPlaca.get(pos.placa);
          const pontosVeiculo = romaneioDoVeiculo && romaneioDoVeiculo.length > 0
            ? montarPontosDeRomaneio(romaneioDoVeiculo, pontosPorPlaca.get(pos.placa) ?? [])
            : pontosPorPlaca.get(pos.placa);
          veiculoIdToAlvos.set(veiculo_id, pontosVeiculo ?? []);
          const pendentes = (pontosVeiculo ?? []).filter((pt) => !pt.feito);
```

E adicionar o import no topo do arquivo (próximo aos outros imports de `@/lib/...`):

```ts
import { montarPontosDeRomaneio } from "@/lib/romaneio";
```

- [ ] **Step 4: Rodar tsc, eslint, suite e build**

Run: `npx tsc --noEmit && npx eslint src/app/api/motor/route.ts && npx vitest run && npx next build`
Expected: tudo limpo.

- [x] **Step 5: Validação (ajustada — não rodar o motor de verdade)**

**Mudança de plano, deliberada:** rodar o motor de produção de verdade com dado de
romaneio injetado escreveria em `alertas`/`posicoes_atuais` REAIS — para qualquer
veículo cuja coordenada geocodificada pelo romaneio difira o bastante da que a
Unitrac já tinha, isso pode gerar um alerta de desvio real, visível pro operador
monitorando aquele caminhão AGORA. Não vale o risco só pra validar uma fiação de
~6 linhas já coberta por tipo (`tsc`) e por teste unitário
(`montarPontosDeRomaneio`, Task 4).

Validação feita em vez disso, sem tocar no motor ao vivo:
1. A query exata usada em `route.ts` (`.from("romaneio_pontos").select(...).eq("romaneio_data", ...).not("lat", "is", null).not("lng", "is", null).in("veiculo_id", ...)`) foi testada isoladamente contra o banco real (script temporário, apagado depois): inseriu 2 linhas de teste (uma com coordenada, uma sem) pro veículo TUL-1C38, a query retornou só a linha COM coordenada — confirma que o filtro `not(...is null)` funciona como esperado antes de chegar em `montarPontosDeRomaneio`. Dados de teste removidos depois.
2. `npx tsc --noEmit`, `npx eslint src/app/api/motor/route.ts`, `npx vitest run` (288 testes, nenhum quebrado pela mudança) e `npx next build` — todos limpos.
3. A lógica de combinação em si (`montarPontosDeRomaneio`) já tem cobertura de teste dedicada (Task 4) cobrindo os 3 casos que importam (NF com alvo, NF sem alvo, campos preservados do alvo).

- [ ] **Step 6: Commit e push**

```bash
git add src/app/api/motor/route.ts
git commit -m "$(cat <<'EOF'
feat(romaneio): motor usa romaneio_pontos de hoje quando existir

Cache por cliente (3min, mesmo padrao de bases/frota) busca os pontos do
romaneio de hoje; quando existem pro veiculo, montarPontosDeRomaneio
combina endereco/coordenada do romaneio com o status ao vivo que o motor
ja busca da Unitrac (sem chamada de rede extra). Sem romaneio de hoje pro
veiculo, cai no caminho 100% Unitrac de sempre -- zero regressao de
cobertura.

tsc/eslint/vitest/build limpos. Validado manualmente end-to-end.

Ver docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 8: Replicar no repo definitivo e push nos dois

**Files:**
- Modify (no repo `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`,
  branch `main`): todos os arquivos criados/modificados nas Tasks 1-7.

**Interfaces:**
- Consumes: os diffs exatos das Tasks 1-7.
- Produces: nada — task final.

- [ ] **Step 1: Confirmar que o definitivo ainda está sincronizado com o TEMP antes da Task 1**

Run:
```bash
diff -rq "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src" \
         "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/src" \
  | grep -v "romaneio\|corredor-verificacao\|motor/route.ts"
```
Expected: sem output (fora dos arquivos já tratados nesta e na sessão anterior, os
dois repos continuam idênticos). Se houver diferença inesperada, PARE e reconcilie
antes de continuar.

- [ ] **Step 2: Aplicar a mesma migration no banco do definitivo**

**Atenção:** TEMP e definitivo usam o MESMO projeto Supabase
(`cbnzhcmsqcfradaklndu`, ver memória `project_monitoramento_transmonseg`) — a
migration da Task 1 já está aplicada no banco (é o mesmo banco pros dois repos). Não
rodar `aplicar-migration.mjs` de novo aqui. Só copiar o arquivo `.sql` pro repo
definitivo por completude do histórico:

```bash
cp "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/scripts/migrations/020_romaneio_pontos.sql" \
   "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/scripts/migrations/"
```

- [ ] **Step 3: Copiar os arquivos de código novos/modificados**

```bash
TEMP="/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
DEF="/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"

mkdir -p "$DEF/src/app/api/romaneio/upload" "$DEF/src/app/(app)/romaneio"
cp "$TEMP/src/lib/romaneio.ts" "$DEF/src/lib/romaneio.ts"
cp "$TEMP/src/lib/romaneio.test.ts" "$DEF/src/lib/romaneio.test.ts"
cp "$TEMP/src/lib/romaneio-geocode.ts" "$DEF/src/lib/romaneio-geocode.ts"
cp "$TEMP/src/lib/romaneio-geocode.test.ts" "$DEF/src/lib/romaneio-geocode.test.ts"
cp "$TEMP/src/app/api/romaneio/upload/route.ts" "$DEF/src/app/api/romaneio/upload/route.ts"
cp "$TEMP/src/app/(app)/romaneio/page.tsx" "$DEF/src/app/(app)/romaneio/page.tsx"
cp "$TEMP/src/app/(app)/layout.tsx" "$DEF/src/app/(app)/layout.tsx"
cp "$TEMP/src/app/api/motor/route.ts" "$DEF/src/app/api/motor/route.ts"
cp "$TEMP/package.json" "$DEF/package.json"
cp "$TEMP/package-lock.json" "$DEF/package-lock.json"
cp "$TEMP/docs/superpowers/plans/2026-07-15-romaneio-pontos-entrega.md" "$DEF/docs/superpowers/plans/"
```

- [ ] **Step 4: Instalar dependências e rodar tsc, eslint, suite e build**

Run (dentro de `/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg`):
```bash
npm install
npx tsc --noEmit
npx eslint src/lib/romaneio.ts src/lib/romaneio-geocode.ts src/app/api/romaneio/upload/route.ts "src/app/(app)/romaneio/page.tsx" "src/app/(app)/layout.tsx" src/app/api/motor/route.ts
npx vitest run
npx next build
```
Expected: mesmo resultado limpo da Task 7, Step 4.

- [ ] **Step 5: Commit e push**

```bash
git add src/lib/romaneio.ts src/lib/romaneio.test.ts src/lib/romaneio-geocode.ts src/lib/romaneio-geocode.test.ts \
  src/app/api/romaneio/upload/route.ts "src/app/(app)/romaneio/page.tsx" "src/app/(app)/layout.tsx" \
  src/app/api/motor/route.ts package.json package-lock.json scripts/migrations/020_romaneio_pontos.sql \
  docs/superpowers/plans/2026-07-15-romaneio-pontos-entrega.md
git commit -m "$(cat <<'EOF'
feat(romaneio): romaneio diario como fonte dos pontos de entrega

Espelha no definitivo os commits do TEMP (parser, geocodificacao, upload,
integracao no motor) -- ver
docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md.
Migration ja aplicada (mesmo banco Supabase dos dois repos).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Step 6: Confirmar os dois repos sincronizados**

Run:
```bash
diff -rq "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src" \
         "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/src"
```
Expected: sem output.
