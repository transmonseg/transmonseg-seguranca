# Modo teste do romaneio, Design

**Data:** 2026-07-16
**Status:** aprovado pelo usuário, indo para plano

## Problema

O romaneio (spec `docs/superpowers/specs/2026-07-15-romaneio-pontos-entrega-design.md`)
está no ar, mas a única validação feita até agora foi via scripts internos que o
usuário não viu rodar — ele quer uma forma de testar o pipeline inteiro (upload →
parse → geocode → cruzamento com status da Unitrac) pelo próprio painel, com prova
visual de que funcionou, **sem risco de misturar dado de teste com dado real** que
alimenta a detecção ao vivo.

## Decisões (tomadas com o usuário nesta sessão)

1. **Isolamento por trava no motor, não por promessa.** Uma coluna `modo_teste` marca
   a origem do dado; o motor filtra explicitamente esse campo antes de usar qualquer
   `romaneio_pontos` pra detecção — mesmo que o teste use uma placa REAL de verdade
   (necessário pra testar o cruzamento com o status real da Unitrac), o motor nunca
   enxerga esses pontos.
2. **Toggle na tela de upload**, desmarcado por padrão (produção) — testar exige ação
   explícita, nunca é o caminho默认.
3. **Gerador de romaneio de teste reutilizável** — monta um PDF no formato real
   descoberto (spec anterior), com uma placa real da frota (CV de verdade, pra
   exercitar o cruzamento com a Unitrac) mas NF/cliente/endereço fictícios.
4. **Resumo do upload mostra os pontos de verdade** (NF, cliente, endereço,
   coordenada, status do geocode) — não só contagem — pra o usuário conferir
   visualmente, não só confiar num número.

## Escopo

1. Migration: `romaneio_pontos.modo_teste boolean NOT NULL DEFAULT false`.
2. Rota de upload (`/api/romaneio/upload`): aceita `modoTeste` no form, grava em cada
   linha inserida.
3. Tela (`/romaneio`): checkbox "Modo teste (não afeta o motor)", resumo passa a
   listar os pontos processados (não só contagem).
4. Motor (`route.ts`): query de `romaneioPontosPorPlaca` ganha `AND modo_teste =
   false` — dado de teste nunca chega em `montarPontosDeRomaneio`.
5. Script gerador: `scripts/dev/gerar-romaneio-teste.mjs` — produz um PDF de teste
   reutilizável (não é parte do app, é ferramenta de desenvolvimento/validação).

Fora de escopo: apagar/purgar dado de teste automaticamente (fica no banco como
qualquer romaneio, só marcado — o usuário pode limpar manualmente se quiser);
qualquer UI de "histórico de testes" dedicada (o resumo do upload já mostra o
suficiente pra validar na hora).

## 1. Migration

```sql
ALTER TABLE romaneio_pontos ADD COLUMN modo_teste boolean NOT NULL DEFAULT false;
```

## 2. Rota de upload

`formData.get("modoTeste")` (string `"true"`/`"false"` do checkbox) vira
`modoTeste: boolean`, incluído em cada linha de `linhasParaInserir`. Sem mudança na
lógica de parse/geocode — só um campo a mais gravado.

Resposta do upload ganha `pontos: { nf, clienteNome, enderecoBruto, lat, lng,
geocodeStatus }[]` (todas as linhas processadas, não só contagem) além do resumo que
já existe.

## 3. Tela

Checkbox acima do botão "Processar romaneio", enviado junto no `FormData`. Resumo
existente (linhas/geocodados/sem coordenada/placas não encontradas) continua, mais
uma tabela simples listando cada ponto (NF, cliente, endereço, coordenada, status).

## 4. Motor

Único ponto de mudança: a query em `route.ts` que popula `romaneioPontosPorPlaca`
ganha `.eq("modo_teste", false)` (mesmo padrão dos outros filtros `.eq()`/`.not()` já
existentes ali). Nada mais muda — `montarPontosDeRomaneio` e o resto do fluxo
continuam iguais, simplesmente nunca recebem uma linha de teste.

## 5. Gerador de romaneio de teste

Script standalone que monta o texto no formato exato descoberto (spec anterior:
`PLACA/MOTORISTA: <placa> / <motorista><TAB>CARGA/DESTINO: <codigo> / <nome>`, linhas
`NF/CLIENTE` + endereço) e gera um PDF de verdade (lib de geração de PDF simples, ex.
`pdf-lib`, já que só precisamos ESCREVER texto num formato que o `pdf-parse` já sabe
ler — não precisa replicar o layout visual original, só o texto que o parser
extrai). Usa uma placa real (parâmetro do script, ex. uma da Nutry Max) + 3-5 NFs
fictícias com endereços reais de Natividade/Varre-Sai (mesma região, pra geocode ter
chance real de funcionar) mas nomes de cliente claramente marcados como teste (ex.
"TESTE — Mercado Fictício 1").

## Testes

- Migration aplicada e coluna confirmada.
- `montarPontosDeRomaneio`/parser não mudam — sem teste novo ali.
- Teste manual: gerar o PDF de teste, subir com "Modo teste" marcado, confirmar no
  banco que as linhas têm `modo_teste = true`, confirmar que a query do motor (rodada
  isolada, sem tocar no motor de produção — mesma cautela de sempre) não retorna essas
  linhas.
- Suite completa + `tsc`/`eslint`/`build` limpos nos dois repos antes do push.
