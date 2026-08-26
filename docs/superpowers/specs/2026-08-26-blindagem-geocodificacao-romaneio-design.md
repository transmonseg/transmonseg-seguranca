# Blindagem da geocodificação do romaneio — análise e plano

**Contexto (26/08):** o grupo DESVIO DE ROTA reportou vários casos de "o
sistema criou uma marcação que nem tinha", parada suspeita/desvio falso
perto de um endereço, mesmo com romaneio confirmado no sistema. Investigado
com dado real: placa RBJ-2J67, romaneio de hoje, 23 pontos de entrega.

## O que foi confirmado com dado real

Dois dos 23 pontos dessa placa estavam geocodificados a **100-200km** da
região real da rota (Miracema/Santo Antônio de Pádua/Aperibé, RJ):

1. **"AVENIDA GETULIO VARGAS, 60 - SAO FELIX, SANTO ANTONIO D - LOJA 04"**
   → geocodificado no Rio de Janeiro capital (lat -22.90, lng -43.12), a
   +200km da rota real. Cidade **truncada** na origem ("SANTO ANTONIO D"
   em vez de "SANTO ANTONIO DE PADUA").
2. **"RUA MELCHIADES PICANCO, 643 - HOSPITAL, MIRACEMA - *"** →
   geocodificado a ~100km da região real. Cidade não truncada, rua não
   encontrada em nenhuma variação de grafia testada manualmente.

Reproduzido ao vivo via `POST /api/romaneio/geocode` (mesmo endpoint que o
KPI Nutry Max usa) — não é dado histórico corrompido, é a cascata
devolvendo esse resultado **hoje, de novo, na hora**. Os dois vieram com
`fonte='local'` no cache (`romaneio_geocode_cache`).

Corrigido manualmente por ora: cache + `romaneio_pontos` de hoje ajustados
(coordenada certa pro caso 1, sem coordenada pro caso 2 — nunca inventa
dado quando não dá pra confirmar).

## Causas raiz identificadas em `src/lib/romaneio-geocode.ts`

**1. `escolherCandidatoMaisProximo` confia cego sem `pontoCidade` (linha 38):**
```ts
if (!pontoCidade) return candidatos[0];
```
Quando o ponto de referência da cidade não resolve (Nominatim fora do ar,
nome de cidade não reconhecido, etc.), QUALQUER candidato textualmente
parecido passa direto, sem checagem de distância nenhuma — mesmo a
centenas de km. Esse é o "portão aberto" real da cascata.

**2. `expandirCidadeTruncada` falhou pra "SANTO ANTONIO D" → "Santo Antônio
de Pádua" neste caso real** (`romaneio-geocode-local.ts`). Confirmado
empiricamente: o MESMO endereço, com o nome da cidade completo, geocodifica
certo pela mesma cascata; truncado, erra por +200km. Não deu tempo de
rastrear se é o prefixo-match da função em si ou algo antes dela (extração
do campo cidade) — precisa de um teste dedicado com truncamentos REAIS do
romaneio da Nutry Max, não só os inventados no teste existente.

**3. Tier "local" (OSM/`vias_nomes`) devolvendo candidato pra rua que não
existe no dataset**, em vez de `null` (caso 2 acima) — pode ser só
consequência do Achado 1 (sem `pontoCidade` bom, aceita o que aparecer) ou
um problema à parte no matching de `vias_nomes`. Não isolado ainda.

**4. Operacional, não é bug de geocodificação:** existe reprocessamento
automático de `romaneio_pontos` com `geocode_status='pendente'` a cada
~15-30s. Confirmado ao vivo: um fix manual (zerar coordenada, status
`pendente`) durou menos de 30 segundos antes do mesmo erro voltar. Qualquer
correção de dado sem correção de código é temporária.

## Plano, em ordem de risco/impacto

1. **[Baixo risco, alto impacto] Blindar `escolherCandidatoMaisProximo`**:
   sem `pontoCidade` E com mais de 1 candidato ambíguo, devolver `null` em
   vez de `candidatos[0]` — hoje não há NENHUMA validação nesse caminho.
   Candidato único sem `pontoCidade` pode continuar sendo aceito (risco
   menor, já é o comportamento atual). Isso sozinho já teria bloqueado o
   caso 1 (viria `null` em vez de Rio de Janeiro).
2. **[Médio risco] Auditar `expandirCidadeTruncada` com truncamentos reais**:
   extrair de `romaneio_pontos.endereco_bruto` dos últimos 30 dias os
   nomes de cidade que aparecem truncados de verdade (não os hipotéticos),
   comparar contra a expansão que a função devolve hoje, e criar teste
   automatizado cobrindo os casos reais encontrados.
3. **[Médio risco, depende do item 2] Investigar o tier "local"**: se após
   o fix do item 1 o caso 2 (rua não encontrada) ainda devolver coordenada
   errada em vez de `null`, é um problema à parte no matching de
   `vias_nomes` — precisa de investigação dedicada.
4. **[Sem risco de regressão] Logar quando geocodificação "local"/"cnefe"
   acontece sem `pontoCidade`** — hoje é silencioso; um alerta/contador
   dá visibilidade pra pegar o próximo caso antes do time reclamar no
   WhatsApp.
5. **[Baixo esforço, resolve o "fix dura 20 segundos"] Job de
   reprocessamento de `pendente` parar de retentar infinitamente**: depois
   de N tentativas sem sucesso (ou sem mudança de resultado), marcar como
   "sem coordenada confirmada" e parar de reprocessar automaticamente até
   alguém revisar manualmente.

## Não incluído neste plano

Reescrever a cascata inteira (CNEFE→OSM→Google→Nominatim) ou trocar de
provedor — a arquitetura em si é sólida e já tem anos de ajuste documentado
(disambiguação por cidade/bairro, filtro de município no CNEFE). O problema
é pontual: falta de validação quando a etapa de referência (`pontoCidade`)
falha, não a cascata como um todo.
