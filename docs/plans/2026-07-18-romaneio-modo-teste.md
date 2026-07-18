# Modo teste do romaneio Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deixar o operador testar o pipeline completo do romaneio (upload → parse
→ geocode → cruzamento com Unitrac) pelo próprio painel, com prova visual de que
funcionou, sem risco de o dado de teste contaminar a detecção ao vivo.

**Architecture:** Uma coluna `modo_teste` em `romaneio_pontos` marca a origem da
linha. A rota de upload aceita um flag do formulário e grava esse valor em cada
linha inserida (nenhuma mudança na lógica de parse/geocode). O motor — único
consumidor de `romaneio_pontos` pra detecção — ganha um filtro adicional que
exclui linhas de teste, então elas nunca chegam em `montarPontosDeRomaneio`
mesmo que usem uma placa real. Um script standalone gera um PDF de teste
reutilizável no formato exato que `parseRomaneio` já sabe ler.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase (Postgres),
`pdf-lib` (novo, só pra gerar o PDF de teste — dev-only).

**Spec:** `docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md`

---

## Nota sobre testes

`parseRomaneio`/`montarPontosDeRomaneio` (lógica pura já testada em
`src/lib/romaneio.test.ts`) não mudam neste plano — zero teste novo ali. As
mudanças são: uma coluna de banco, um campo a mais gravado na rota de upload
(sem lógica nova), um filtro a mais na query do motor, e uma tela. Validação
segue o padrão desta sessão pra esse tipo de mudança: teste manual ponta-a-ponta
(Task 6) + `tsc`/`eslint`/`vitest`(suite existente)/`build` limpos, sem inventar
teste automatizado pra UI/glue code.

---

### Task 1: Migration — coluna `modo_teste`

**Files:**
- Create: `scripts/migrations/023_romaneio_modo_teste.sql`

**Step 1: Escrever a migration**

```sql
-- 023_romaneio_modo_teste.sql
-- Isola romaneio de teste (spec docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md):
-- uma linha com modo_teste=true nunca deve ser usada pelo motor pra detecção,
-- mesmo que use uma placa real (necessário pra testar o cruzamento com o
-- status real da Unitrac).
ALTER TABLE romaneio_pontos ADD COLUMN modo_teste boolean NOT NULL DEFAULT false;
```

**Step 2: Aplicar a migration**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
node --env-file=.env.local scripts/aplicar-migration.mjs 023_romaneio_modo_teste.sql
```

**Expected:** `OK — migration aplicada.` seguido da lista de tabelas.

**Step 3: Confirmar a coluna**

```bash
node --env-file=.env.local -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const r = await pool.query(\`select column_name, data_type, column_default from information_schema.columns where table_name='romaneio_pontos' and column_name='modo_teste'\`);
  console.log(JSON.stringify(r.rows, null, 2));
  await pool.end();
})();
"
```

**Expected:** uma linha — `{ column_name: 'modo_teste', data_type: 'boolean', column_default: 'false' }`.

**Step 4: Commit**

```bash
git add scripts/migrations/023_romaneio_modo_teste.sql
git commit -m "feat(romaneio): migration modo_teste em romaneio_pontos"
```

(A migration já rodou no banco compartilhado — este commit é só o histórico
versionado do arquivo `.sql`, mesmo padrão de 020/021/022. Não precisa rodar de
novo no repo definitivo, mas o arquivo `.sql` é replicado por histórico na Task 7.)

---

### Task 2: Rota de upload aceita `modoTeste`

**Files:**
- Modify: `src/app/api/romaneio/upload/route.ts`

**Step 1: Ler `modoTeste` do FormData e gravar em cada linha**

Em `src/app/api/romaneio/upload/route.ts:13-17`, logo depois de extrair
`arquivo`, adicione:

```ts
  const formData = await request.formData();
  const arquivo = formData.get("arquivo");
  if (!(arquivo instanceof File)) {
    return Response.json({ ok: false, erro: "Nenhum arquivo enviado." }, { status: 400 });
  }
  const modoTeste = formData.get("modoTeste") === "true";
```

No objeto empurrado em `linhasParaInserir` (linhas 72-85), adicione o campo:

```ts
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
      modo_teste: modoTeste,
    });
```

**Step 2: Resposta ganha a lista de pontos processados**

A resposta hoje (linhas 93-100) só devolve contagens. Troque por (mantendo os
campos existentes e acrescentando `pontos` e `modoTeste`):

```ts
  return Response.json({
    ok: true,
    romaneioData,
    totalLinhas: linhas.length,
    geocodadosOk,
    semCoordenada,
    placasNaoEncontradas,
    modoTeste,
    pontos: linhasParaInserir.map((l) => ({
      nf: l.nf,
      clienteNome: l.cliente_nome,
      enderecoBruto: l.endereco_bruto,
      lat: l.lat,
      lng: l.lng,
      geocodeStatus: l.geocode_status,
    })),
  });
```

**Step 3: Rodar `tsc`**

```bash
npx tsc --noEmit
```

**Expected:** sem erros.

**Step 4: Commit**

```bash
git add src/app/api/romaneio/upload/route.ts
git commit -m "feat(romaneio): rota de upload aceita modoTeste e retorna pontos processados"
```

---

### Task 3: Tela `/romaneio` — checkbox + tabela de pontos

**Files:**
- Modify: `src/app/(app)/romaneio/page.tsx`

**Step 1: Substituir o conteúdo inteiro do arquivo**

```tsx
"use client";

import { useState } from "react";

type PontoProcessado = {
  nf: string;
  clienteNome: string;
  enderecoBruto: string;
  lat: number | null;
  lng: number | null;
  geocodeStatus: string;
};

type ResultadoUpload = {
  ok: boolean;
  erro?: string;
  romaneioData?: string;
  totalLinhas?: number;
  geocodadosOk?: number;
  semCoordenada?: number;
  placasNaoEncontradas?: string[];
  modoTeste?: boolean;
  pontos?: PontoProcessado[];
};

export default function RomaneioPage() {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [modoTeste, setModoTeste] = useState(false);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoUpload | null>(null);

  const processar = async () => {
    if (!arquivo) return;
    setProcessando(true);
    setResultado(null);
    try {
      const formData = new FormData();
      formData.append("arquivo", arquivo);
      formData.append("modoTeste", modoTeste ? "true" : "false");
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
    <div className="p-6 max-w-3xl mx-auto">
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
        className="block mb-3 text-sm"
        style={{ color: "var(--text)" }}
      />

      <label className="flex items-center gap-2 mb-4 text-sm" style={{ color: "var(--text)" }}>
        <input
          type="checkbox"
          checked={modoTeste}
          onChange={(e) => setModoTeste(e.target.checked)}
        />
        Modo teste (não afeta o motor)
      </label>

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
                {resultado.modoTeste && (
                  <span className="ml-2" style={{ color: "var(--accent)" }}>
                    (MODO TESTE — não afeta a detecção)
                  </span>
                )}
              </p>
              <ul className="space-y-1 mb-4" style={{ color: "var(--text-dim)" }}>
                <li>{resultado.totalLinhas} linhas no total</li>
                <li>{resultado.geocodadosOk} geocodificadas com sucesso</li>
                <li>{resultado.semCoordenada} sem coordenada (endereço não geocodificou — não entram na lista de pendentes)</li>
              </ul>
              {resultado.placasNaoEncontradas && resultado.placasNaoEncontradas.length > 0 && (
                <p className="mb-4" style={{ color: "var(--danger, #e55)" }}>
                  Placas não encontradas no cadastro: {resultado.placasNaoEncontradas.join(", ")}
                </p>
              )}
              {resultado.pontos && resultado.pontos.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" style={{ color: "var(--text)" }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)" }}>
                        <th className="text-left pr-3 py-1">NF</th>
                        <th className="text-left pr-3 py-1">Cliente</th>
                        <th className="text-left pr-3 py-1">Endereço</th>
                        <th className="text-left pr-3 py-1">Coordenada</th>
                        <th className="text-left py-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resultado.pontos.map((p) => (
                        <tr key={p.nf} style={{ borderTop: "1px solid var(--border)" }}>
                          <td className="pr-3 py-1">{p.nf}</td>
                          <td className="pr-3 py-1">{p.clienteNome}</td>
                          <td className="pr-3 py-1">{p.enderecoBruto}</td>
                          <td className="pr-3 py-1">
                            {p.lat != null && p.lng != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "—"}
                          </td>
                          <td className="py-1">{p.geocodeStatus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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

**Step 2: Rodar `tsc`**

```bash
npx tsc --noEmit
```

**Expected:** sem erros.

**Step 3: Commit**

```bash
git add src/app/\(app\)/romaneio/page.tsx
git commit -m "feat(romaneio): checkbox de modo teste e tabela de pontos processados na tela"
```

---

### Task 4: Motor ignora linhas de teste

**Files:**
- Modify: `src/app/api/motor/route.ts:921-927`

**Step 1: Adicionar o filtro**

```ts
        const { data: linhasRomaneio } = await supabase
          .from("romaneio_pontos")
          .select("placa, nf, cliente_nome, lat, lng, presenca_confirmada_em")
          .eq("romaneio_data", dataHojeSP)
          .eq("modo_teste", false)
          .not("lat", "is", null)
          .not("lng", "is", null)
          .in("veiculo_id", veiculoIdsDoCliente);
```

(Só essa linha `.eq("modo_teste", false)` a mais — mesmo padrão dos outros
`.eq()`/`.not()` já encadeados ali. Nada mais no motor muda:
`montarPontosDeRomaneio` e o resto do fluxo de desvio continuam iguais, só
nunca recebem uma linha de teste.)

**Step 2: Rodar `tsc`**

```bash
npx tsc --noEmit
```

**Expected:** sem erros.

**Step 3: Validar a query isoladamente (SEM rodar o motor de produção)**

Mesma cautela de sempre nesta sessão — nunca testar mudança do motor rodando o
motor ao vivo. Insira uma linha de teste manualmente, confirme que a query com
`.eq("modo_teste", false)` não a retorna, depois apague:

```bash
node --env-file=.env.local -e "
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const { data: v } = await supabase.from('veiculos').select('id, placa').limit(1).single();
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const { data: inserted, error: e1 } = await supabase.from('romaneio_pontos').insert({
    veiculo_id: v.id, placa: v.placa, romaneio_data: hoje, nf: 'TESTE-VALIDACAO-023',
    cliente_nome: 'TESTE', endereco_bruto: 'TESTE', lat: -22.9, lng: -43.2,
    geocode_status: 'ok', modo_teste: true,
  }).select().single();
  if (e1) { console.error('erro insert:', e1.message); process.exit(1); }
  console.log('inserido:', inserted.id);

  const { data: comFiltro } = await supabase.from('romaneio_pontos')
    .select('nf').eq('romaneio_data', hoje).eq('modo_teste', false).not('lat', 'is', null).not('lng', 'is', null).in('veiculo_id', [v.id]);
  const apareceu = (comFiltro ?? []).some(r => r.nf === 'TESTE-VALIDACAO-023');
  console.log('linha de teste apareceu na query do motor (deve ser false):', apareceu);

  await supabase.from('romaneio_pontos').delete().eq('id', inserted.id);
  console.log('linha de teste removida.');
})();
"
```

**Expected:** `linha de teste apareceu na query do motor (deve ser false): false`,
seguido de `linha de teste removida.`.

**Step 4: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(romaneio): motor ignora linhas de romaneio em modo_teste"
```

---

### Task 5: Gerador de romaneio de teste

**Files:**
- Modify: `package.json` (nova dependência)
- Create: `scripts/dev/gerar-romaneio-teste.mjs`

**Step 1: Instalar `pdf-lib`**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
npm install pdf-lib
```

**Expected:** `pdf-lib` aparece em `dependencies` no `package.json` e no
`package-lock.json`.

**Step 2: Escrever o script gerador**

```js
// scripts/dev/gerar-romaneio-teste.mjs
// Gera um PDF de romaneio de TESTE reutilizavel, no formato exato que
// src/lib/romaneio.ts sabe parsear (regexes REGEX_CABECALHO/REGEX_NF_CLIENTE)
// -- ver docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md.
// So escreve o TEXTO que o pdf-parse extrai; nao replica o layout visual
// original do romaneio real.
//
// Uso: node scripts/dev/gerar-romaneio-teste.mjs <PLACA_REAL> [saida.pdf]
// Ex.: node scripts/dev/gerar-romaneio-teste.mjs TUL-1C38
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "node:fs";

const placa = process.argv[2];
if (!placa) {
  console.error("uso: node scripts/dev/gerar-romaneio-teste.mjs <PLACA_REAL> [saida.pdf]");
  process.exit(1);
}
const saida = process.argv[3] ?? "romaneio-teste.pdf";

const hoje = new Date();
const dataFormatada = `${String(hoje.getDate()).padStart(2, "0")}/${String(hoje.getMonth() + 1).padStart(2, "0")}/${hoje.getFullYear()} 06:00`;

// Enderecos reais de Natividade/Varre-Sai (RJ) -- mesma regiao da frota, pra
// geocode ter chance real de funcionar. Nomes de cliente marcados como TESTE
// de proposito, pra nunca serem confundidos com cliente de verdade numa
// consulta manual ao banco.
const PONTOS_TESTE = [
  { nf: "TESTE-90001", clienteCodigo: "T001", clienteNome: "TESTE — Mercado Fictício 1", endereco: "Rua Coronel Bittencourt, 120, Centro, Natividade - RJ" },
  { nf: "TESTE-90002", clienteCodigo: "T002", clienteNome: "TESTE — Mercado Fictício 2", endereco: "Avenida Governador Portela, 250, Centro, Natividade - RJ" },
  { nf: "TESTE-90003", clienteCodigo: "T003", clienteNome: "TESTE — Mercado Fictício 3", endereco: "Rua Presidente Vargas, 88, Centro, Varre-Sai - RJ" },
];

const linhas = [];
linhas.push(`PLACA/MOTORISTA: ${placa} / TESTE MOTORISTA    CARGA/DESTINO: T000 / TESTE ROTA`);
linhas.push("AJUDANTE(S): ");
for (const p of PONTOS_TESTE) {
  linhas.push(`${p.nf} / ${p.clienteCodigo} - ${p.clienteNome}`);
  linhas.push(p.endereco);
}
linhas.push(`Total de ${PONTOS_TESTE.length} clientes`);
// Data no cabecalho -- extrairDataRomaneio pega a PRIMEIRA ocorrencia de
// dd/mm/aaaa hh:mm no texto inteiro, entao basta aparecer uma vez.
linhas.unshift(dataFormatada);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const pagina = doc.addPage([595, 842]); // A4
const tamanhoFonte = 10;
let y = 800;
for (const linha of linhas) {
  pagina.drawText(linha, { x: 40, y, size: tamanhoFonte, font });
  y -= tamanhoFonte + 6;
}

const bytes = await doc.save();
writeFileSync(saida, bytes);
console.log(`PDF de teste gerado: ${saida} (placa ${placa}, ${PONTOS_TESTE.length} pontos fictícios)`);
```

**Step 3: Rodar e verificar que o texto extraído bate com o parser**

```bash
node scripts/dev/gerar-romaneio-teste.mjs TUL-1C38 /tmp/romaneio-teste.pdf
node -e "
(async () => {
  const { PDFParse } = await import('pdf-parse');
  const { readFileSync } = await import('node:fs');
  const parser = new PDFParse({ data: readFileSync('/tmp/romaneio-teste.pdf') });
  const { text } = await parser.getText();
  console.log(text);
})();
"
```

**Expected:** o texto extraído mostra a linha `PLACA/MOTORISTA: TUL-1C38 / TESTE
MOTORISTA ... CARGA/DESTINO: T000 / TESTE ROTA`, seguida das 3 linhas
`TESTE-9000N / T00N - TESTE — Mercado Fictício N` cada uma seguida do endereço.

**Step 4: Confirmar que `parseRomaneio` (o parser real) entende o texto gerado**

```bash
node --env-file=.env.local -e "
(async () => {
  const { PDFParse } = await import('pdf-parse');
  const { readFileSync } = await import('node:fs');
  const parser = new PDFParse({ data: readFileSync('/tmp/romaneio-teste.pdf') });
  const { text } = await parser.getText();
  // parseRomaneio e src/lib/romaneio.ts (TS) -- registra um loader rapido via tsx
  const { register } = await import('node:module');
  register('tsx/esm', import.meta.url);
  const { parseRomaneio } = await import('./src/lib/romaneio.ts');
  const linhas = parseRomaneio(text);
  console.log(JSON.stringify(linhas, null, 2));
  console.log('total de linhas parseadas:', linhas.length, '(esperado: 3)');
})();
" 2>&1 || echo "(se 'tsx' nao estiver instalado, pule este step -- a Task 6 valida via upload real, que e o caminho ponta-a-ponta de verdade)"
```

**Expected:** 3 linhas parseadas, cada uma com `placaBruta: "TUL-1C38"`, `nf`
batendo com `TESTE-90001`/`90002`/`90003`, e `enderecoBruto` batendo com os
endereços de Natividade/Varre-Sai. Se `tsx` não estiver disponível no projeto,
não instale só pra isso — a Task 6 (upload real) já é a validação ponta-a-ponta
que importa de verdade.

**Step 5: Commit**

```bash
git add package.json package-lock.json scripts/dev/gerar-romaneio-teste.mjs
git commit -m "feat(romaneio): script gerador de romaneio de teste reutilizável"
```

---

### Task 6: Validação manual ponta-a-ponta

**Files:** nenhum (só validação).

**Step 1: Gerar um PDF de teste com uma placa real da frota**

```bash
node --env-file=.env.local scripts/dev/gerar-romaneio-teste.mjs <PLACA_REAL_DA_FROTA> /tmp/romaneio-teste.pdf
```

(Escolha uma placa real consultando `select placa from veiculos where ativo =
true limit 5` — qualquer uma serve, o teste não afeta a detecção dela.)

**Step 2: Subir pelo painel com "Modo teste" marcado**

```bash
npm run dev
```

Abra `/romaneio` no navegador, logado, selecione o PDF gerado, marque "Modo
teste", clique "Processar romaneio". Confirme visualmente: resumo mostra "(MODO
TESTE — não afeta a detecção)", tabela lista as 3 linhas com NF/cliente/endereço/
coordenada/status.

**Step 3: Confirmar no banco que as linhas têm `modo_teste = true`**

```bash
node --env-file=.env.local -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const r = await pool.query(\`select nf, modo_teste, lat, lng from romaneio_pontos where nf like 'TESTE-9%' order by nf\`);
  console.log(JSON.stringify(r.rows, null, 2));
  await pool.end();
})();
"
```

**Expected:** 3 linhas, todas com `modo_teste: true`.

**Step 4: Confirmar que a query do motor (isolada) não retorna essas linhas**

Mesmo script de validação da Task 4 Step 3, ou:

```bash
node --env-file=.env.local -e "
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const { data } = await supabase.from('romaneio_pontos')
    .select('nf').eq('romaneio_data', hoje).eq('modo_teste', false).not('lat', 'is', null).not('lng', 'is', null);
  const vazou = (data ?? []).some(r => r.nf?.startsWith('TESTE-9'));
  console.log('linha de teste vazou pra query do motor (deve ser false):', vazou);
})();
"
```

**Expected:** `false`.

**Step 5: Limpar as linhas de teste do banco**

```bash
node --env-file=.env.local -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const r = await pool.query(\`delete from romaneio_pontos where nf like 'TESTE-9%' returning nf\`);
  console.log('removidas:', r.rows.map(x => x.nf));
  await pool.end();
})();
"
```

(Fora de escopo da spec fazer isso automaticamente — aqui é só higiene pra não
deixar lixo de validação no banco de produção.)

**Step 6: Parar o dev server**

---

### Task 7: Suite completa, build, replicar pro definitivo, push

**Files:**
- Replicar pro repo definitivo: `scripts/migrations/023_romaneio_modo_teste.sql`,
  `src/app/api/romaneio/upload/route.ts`, `src/app/(app)/romaneio/page.tsx`,
  `src/app/api/motor/route.ts`, `package.json`, `package-lock.json`,
  `scripts/dev/gerar-romaneio-teste.mjs`,
  `docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md`

**Step 1: Suite completa + build no repo TEMP**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP"
npx vitest run
npx tsc --noEmit
npx eslint .
npm run build
```

**Expected:** 291 testes passando (nenhum novo — ver "Nota sobre testes" no
topo do plano), `tsc`/`build` limpos, `eslint` sem NOVOS erros/warnings além dos
6 erros + 4 warnings pré-existentes já confirmados nesta sessão (não
relacionados a este plano).

**Step 2: Aplicar a migration no banco (se ainda não aplicada na Task 1)**

Já foi aplicada na Task 1 — o banco é compartilhado entre os dois repos, não
rodar de novo.

**Step 3: Gerar o patch cumulativo e aplicar no repo definitivo**

```bash
git log --oneline -6
```

Identifique o commit ANTES da Task 1 (chame de `<antes>`).

```bash
git diff <antes> HEAD -- src/app/api/romaneio/upload/route.ts src/app/\(app\)/romaneio/page.tsx src/app/api/motor/route.ts package.json package-lock.json > /tmp/romaneio-modo-teste.patch

cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg"
git status --short
git apply --check /tmp/romaneio-modo-teste.patch && echo "PATCH OK"
git apply /tmp/romaneio-modo-teste.patch
mkdir -p scripts/dev
cp "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/scripts/dev/gerar-romaneio-teste.mjs" scripts/dev/gerar-romaneio-teste.mjs
cp "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/scripts/migrations/023_romaneio_modo_teste.sql" scripts/migrations/023_romaneio_modo_teste.sql
cp "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md" docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md
```

**Step 4: Validar no repo definitivo**

```bash
npm install
npx tsc --noEmit
npx eslint .
npx vitest run
npm run build
```

**Expected:** mesmos resultados do repo TEMP.

**Step 5: Commit no definitivo**

```bash
git add scripts/migrations/023_romaneio_modo_teste.sql src/app/api/romaneio/upload/route.ts src/app/\(app\)/romaneio/page.tsx src/app/api/motor/route.ts package.json package-lock.json scripts/dev/gerar-romaneio-teste.mjs docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md
git commit -m "$(cat <<'EOF'
feat(romaneio): modo teste isola upload de validação da detecção ao vivo

Replica as mudancas equivalentes do repo TEMP. Coluna modo_teste em
romaneio_pontos + checkbox na tela de upload + filtro no motor +
script gerador de romaneio de teste reutilizavel.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

**Step 6: Push dos dois repos**

```bash
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP" && git push
cd "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg" && git push
```

**Step 7: Verificar sincronia**

```bash
diff -rq "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/src" "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/src"
diff -rq "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO TEMP/scripts" "/Users/joaquimsalles/Projects/Transmonseg/monitoramento/MONITORAMENTO transmonseg/scripts"
```

**Expected:** nenhuma saída relevante (`scripts/` pode ter arquivos históricos
diferentes entre os repos de trabalhos anteriores — só confirme que
`023_romaneio_modo_teste.sql` e `gerar-romaneio-teste.mjs` existem em ambos e
são idênticos).
