# Motor de geolocalização universal para romaneios — design

**Data:** 2026-09-05
**Estado:** parcialmente implementado (06/09) -- ver "Progresso" abaixo. O
desenho formal (motor.ts/entrada.ts/rota geocode-v2) não foi construído;
grande parte do objetivo foi alcançada por um caminho mais direto.

## Progresso (06/09)

A Rio Quality passou a mandar um arquivo de entregas com Razão Social,
Cidade, UF, Destino, Motorista, Placa, Endereço e Bairro (antes: só placa+
rua, sem cidade). Com cidade em mãos, não faz sentido continuar usando a
coerência de grupo pra ela -- o KPI (`kpi-rioquality/pipeline.ts`) passou a
chamar **a mesma função que a Nutry Max já usa**
(`geocodificarEnderecos` → `/api/romaneio/geocode` →
`geocodificarEndereco`/cascata CNEFE+OSM+Google+Nominatim) quando o arquivo
tem cidade. Ou seja: o "motor único" do objetivo original já existe **na
prática** pro caso comum -- os dois clientes correm o mesmo código, não
motores paralelos -- só não foi formalizado como uma API/tipo novo
(`resolverEnderecos`/`EnderecoResolvido` da seção "Desenho" abaixo).

Três correções feitas nesse processo, todas na cascata COMPARTILHADA
(`romaneio-geocode.ts` e a rota-ponte `geocode/route.ts`) -- beneficiam
Nutry Max e Rio Quality ao mesmo tempo, sem precisar de nenhuma migração:
- **Raio do ponto de bairro maior pro Rio de Janeiro capital** (70km em vez
  de 25km): município gigante (~1200km², ~60km de ponta a ponta) fazia
  bairro correto da Zona Oeste (Campo Grande, Guaratiba) ser descartado por
  "estar longe da cidade" -- na prática enderecos genuinos, so' municipio
  grande demais pro teto pensado pra cidade do interior.
- **Skip de Nominatim quando ninguém precisa do ponto de referência**:
  pré-checagem só no Postgres (CNEFE/OSM local, sem rede) decide se vale a
  pena resolver cidade/bairro via Nominatim antes de gastar a chamada.
- **Cache de endereço em lote** (`.in()` em vez de 1 SELECT por chave).

Medido no romaneio real de 05/09 da Rio Quality (682 entregas, 387
endereços únicos): geocodificação 93,3%→**99,4%** (46→4 sem candidato),
confirmado GPS 73,8%→**79,3%**, tempo de geração 285s→**52s**.

O que falta do desenho original, ainda não feito:
- **Passo 7 (coerência de grupo como reposicionamento universal)**: hoje
  `resolverGrupoPorCoerencia` só roda pro formato ANTIGO da Rio Quality
  (2 planilhas, sem cidade) -- não é aplicado a resultado de baixa
  confiança/sem-candidato de QUALQUER cliente, como o desenho original
  propunha. Continua sendo o próximo ganho real disponível.
- Rota única `/api/romaneio/geocode-v2` e módulo `geocode/` formal --
  adiado: sem ele os dois clientes já convergem pro mesmo código hoje, e
  criar a camada nova sem um motivo concreto (ex.: um 3º cliente com
  formato diferente) seria refatoração por conta própria.

## Problema

Hoje existem **dois motores separados** para transformar endereço de romaneio em coordenada, e nenhum dos dois é reutilizável por um cliente novo sem trabalho de programação:

| | Cascata (`geocodificarEndereco`) | Coerência de grupo (`resolverGrupoPorCoerencia`) |
|---|---|---|
| Cliente | Nutry Max | Rio Quality |
| Entrada | rua + número + bairro + cidade | só o nome da rua |
| Como resolve | cache → CNEFE (rua+nº, rua, similaridade) → OSM local → Google → Nominatim | candidatos CNEFE de todos os municípios + âncoras do próprio caminhão + zona da rota |
| Devolve | coordenada ou null | coordenada + **confiança** + nº de candidatos |
| Onde mora | `monitoramento/src/lib/romaneio-geocode.ts` | `monitoramento/src/lib/romaneio-geocode-coerencia.ts` |

Consequências medidas:

- **Sem confiança na cascata.** A Nutry Max não sabe distinguir "achei o número exato" de "chutei o meio da rua". Foi por isso que 226 pendentes de 03/09 tinham coordenada a ~14km do caminhão sem nenhum aviso.
- **Sem coerência de grupo na cascata.** O sinal mais forte que existe (as outras paradas do mesmo caminhão) só é usado pela Rio Quality.
- **Cliente novo = código novo.** Não há uma entrada única que aceite "o que o romaneio tiver".

## Objetivo

Um motor único, `resolverEnderecos`, que recebe o que existir no romaneio e devolve sempre coordenada + confiança + fonte. Usado pelo KPI (todos os clientes) e pelo monitoramento.

**Não é objetivo:** trocar as fontes de dados (CNEFE, OSM, Nominatim continuam), nem mexer na detecção de desvio, nem usar os pontos/geofences que a Unitrac já tem cadastrados — a marcação continua saindo do romaneio.

## Desenho

### Entrada

```ts
type EnderecoEntrada = {
  id: string                  // NF, ou chave do chamador
  grupo: string               // placa+dia: define quem são os "vizinhos"
  bruto: string               // linha como veio do romaneio
  zona?: string | null        // opcional: CAPITAL, BAIXADA, SERRANA...
}
```

O motor **extrai** rua/número/bairro/cidade do `bruto` (funções que já existem em `romaneio-geocode-local.ts`) e trabalha com o que conseguir. Cliente que manda endereço completo cai no caminho preciso; cliente que manda só a rua cai no caminho por coerência. Ninguém escolhe caminho na mão.

### Saída

```ts
type EnderecoResolvido = {
  id: string
  lat: number | null
  lng: number | null
  confianca: 'exata' | 'alta' | 'media' | 'baixa' | 'sem_candidato'
  fonte: 'cache' | 'cnefe_numero' | 'cnefe_rua' | 'cnefe_similaridade'
        | 'osm' | 'google' | 'nominatim' | 'coerencia'
  candidatos: number
  municipioCodigo: string | null
}
```

Confiança deixa de ser exclusividade da Rio Quality. Regra:
- `exata` — CNEFE com o número do romaneio
- `alta` — rua única no município certo, ou âncora de coerência
- `media` — desempate por número em via longa, ou similaridade de nome
- `baixa` — escolhido por coerência longe das âncoras, ou candidato único sem validação de cidade
- `sem_candidato` — não achou

### Ordem de resolução (uma só, para todos)

1. **Cache** (chave = endereço normalizado).
2. **Município resolvido?** Se o romaneio traz cidade, resolve o código IBGE e o ponto de referência (com a validação de bairro de hoje: bairro só vale a ≤25km da cidade).
3. **CNEFE rua+número** dentro do município → `exata`.
4. **CNEFE só-rua**, desempatando pelo número mais próximo (migration 074) → `media`.
5. **CNEFE similaridade** dentro do município → `media`.
6. **OSM local / Google / Nominatim** (variantes com e sem bairro) → `media`.
7. **Coerência de grupo** para o que sobrou: candidatos de todos os municípios da zona, âncoras = ruas resolvidas nos passos 3-6 **do mesmo grupo** (hoje as âncoras são só ruas de candidato único) → `alta`/`baixa`.

O passo 7 é a mudança de fundo: hoje a coerência só existe quando não há cidade. No motor único, **toda** entrega que não resolveu direito é reposicionada pelas irmãs do mesmo caminhão que resolveram. Isso deve pegar boa parte dos 37 casos "alta confiança mas >2km" medidos na Rio Quality (concentrados em rotas da Baixada, onde a zona tem 13 municípios).

### Onde mora

`monitoramento/src/lib/geocode/` — `entrada.ts` (extração), `cascata.ts`, `coerencia.ts` (já existe, movida), `motor.ts` (orquestra), `tipos.ts`. Exposto por **uma** rota: `POST /api/romaneio/geocode-v2`, que substitui `geocode` e `geocode-coerencia` (as duas ficam no ar até o KPI migrar).

### Erro e limites

- Nunca inventa coordenada: sem candidato → `null` + `sem_candidato`.
- Prazo interno por lote (o de hoje, 280s) com resposta parcial.
- Falha de fonte externa não derruba o lote (comportamento atual).

## Testes

- Unidade, sem rede: extração; escolha por número; validação bairro×cidade; coerência (âncora, vizinhança, âncora isolada); atribuição de confiança.
- Regressão com os casos reais já documentados: "AV LUCIO COSTA 2900/5700/16580", "CENTRO, CAMBUCI" → São Paulo, "RAIMUNDO CORREIA" → Caxias, "RUA NOVE" → Maré vs Leblon.
- Validação de ponta a ponta: reprocessar 03/09 (Nutry Max) e 04/09 (Rio Quality) e comparar contra o GPS do dia — a métrica é % de entregas com parada da própria placa a ≤500m, hoje 86% na Rio Quality.

## Migração

1. Motor novo + rota v2, sem tocar nas rotas atuais.
2. KPI Rio Quality passa para a v2; medir.
3. KPI Nutry Max passa para a v2; medir contra 03/09.
4. Monitoramento (`processar-geocode`) passa para a v2.
5. Rotas antigas saem.

## Risco

O passo 7 aplicado à Nutry Max muda coordenada de entrega que hoje resolve pela cascata. Mitigação: só reposiciona quem está `baixa`/`sem_candidato`, nunca quem saiu `exata`; e a medição contra o GPS de 03/09 é o critério de aceite — se piorar, não migra.
