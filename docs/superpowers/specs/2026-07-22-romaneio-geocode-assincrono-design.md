# Geocodificação assíncrona do romaneio, Design

**Data:** 2026-07-22
**Status:** aprovado pelo usuário, indo para plano

## Problema

`/api/romaneio/upload` geocodifica endereço por endereço, sequencial,
dentro do mesmo request HTTP síncrono (`src/app/api/romaneio/upload/route.ts`,
linha ~58-88), sem paralelismo e sem feedback de progresso.

Investigação real (não repetir): rodei o parser (`parseRomaneio`,
`extrairDataRomaneio`) contra um romaneio real de 22/07 (115 páginas) — o
parsing funciona perfeitamente, 2041 linhas de entrega, 76 placas únicas.
A causa raiz do "não dá certo" não é o parser, é escala na geocodificação:
só 6 endereços em cache em todo o histórico do sistema, e sem
`GOOGLE_MAPS_API_KEY` server-side configurada (a única chave existente,
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, é restrita a referenciador HTTP + Maps
JavaScript API — não serve pra chamada servidor-a-servidor de Geocoding),
o fallback real é sempre o Nominatim público, que tem política real de 1
req/s. Com 2041 endereços quase todos cache-miss, o tempo total passa de
30-60 minutos — muito além de qualquer timeout de requisição HTTP, o
upload nunca completa a tempo.

Decisão explícita do usuário: resolver AGORA só com o que já existe
(Nominatim), sem depender de configurar uma chave nova do Google
Geocoding (isso fica pra depois, e a arquitetura abaixo já é compatível
com adicionar isso mais tarde sem redesenho).

## Decisão

Desacoplar a geocodificação do upload síncrono, reaproveitando o MESMO
padrão arquitetural já usado pelo motor de detecção: um job separado,
disparado por `pg_cron` + `net.http_post`, processando um orçamento
limitado por invocação, em vez de tudo de uma vez.

`romaneio_pontos.geocode_status` já tem `DEFAULT 'pendente'`
(`scripts/migrations/020_romaneio_pontos.sql`) — o schema já foi desenhado
pra isso, só nunca foi usado de verdade (o upload sempre resolvia tudo
antes de inserir). **Sem migration nova necessária.**

## Escopo

### 1. `/api/romaneio/upload` fica rápido (parse + insert, sem geocodificar)

Remove a chamada a `geocodificarEndereco` do loop de inserção. Cada linha
é inserida com `lat: null, lng: null, geocode_status: 'pendente'`. A
resposta ao navegador volta em segundos (parse + resolução de
veiculo_id/placa, nenhuma chamada de rede externa), com `totalLinhas`,
`placasNaoEncontradas`, e a `romaneioData` — sem `geocodadosOk`/
`semCoordenada` ainda (esses só existem depois do processamento).

### 2. Nova rota `/api/romaneio/processar-geocode`

Protegida pelo mesmo padrão de `x-motor-key`/`MOTOR_SECRET` já usado por
`/api/motor`. `export const maxDuration = 60;` (mesmo valor já usado pelo
motor — confirma que o plano da Vercel aceita).

A cada invocação:
1. `SELECT id, endereco_bruto FROM romaneio_pontos WHERE geocode_status = 'pendente' ORDER BY criado_em LIMIT 40`.
2. Se vier vazio, retorna na hora (checagem barata, não pesa no orçamento
   de CPU no dia a dia — a maior parte do tempo não há romaneio sendo
   processado).
3. Pra cada linha: checa `romaneio_geocode_cache` primeiro (sem throttle,
   é só leitura local); se cache-miss, chama `geocodificarEndereco`
   (Google se configurado no futuro, senão Nominatim) com uma espera
   sequencial simples de ~1,1s ANTES de cada chamada real ao Nominatim
   (não precisa da fila `esperarVaga()`/`filaThrottle` da cerca virtual —
   aquele mecanismo existe pra coordenar chamadas concorrentes de VÁRIOS
   pontos do motor no mesmo ciclo; aqui é um loop sequencial único all no
   mesmo lugar, throttle simples já basta).
4. Atualiza `lat/lng/geocode_status` de cada linha processada (update
   individual — volume por invocação é pequeno, 40 linhas, não tem
   relação com o padrão de batch em lote do motor que existe pra evitar
   centenas de round-trips por CICLO inteiro de 456 veículos).

### 3. Cron job novo (script standalone, mesmo padrão de `scripts/dev/setup-cron-30s.mjs`)

`cron.schedule('romaneio-geocode', '* * * * *', ...)` — 1x por minuto, UM
`net.http_post` só (sem o truque de `pg_sleep` que o motor usa pra
conseguir cadência de 30s; essa feature não precisa de tanta frequência).
`pg_cron` na versão instalada (1.6.4, confirmado) aceita schedule em
segundos também, mas o motor evita esse recurso e usa só `'* * * * *'`
comprovado em produção — reaproveita o MESMO mecanismo já validado, sem
introduzir sintaxe nova/não testada neste projeto. Com até 40 endereços
por invocação a ~1,1s cada (~44s de trabalho real dentro da janela de
60s), o ritmo já fica perto do limite teórico do Nominatim (1/s) mesmo
rodando só 1x/minuto. Chama `/api/romaneio/processar-geocode` com o mesmo
`x-motor-key` já usado pelo motor. Domínio: o mesmo já ativo hoje em
`cron.job` (`https://transmonseg-seguranca-stopgap.vercel.app`).

### 4. Novo endpoint de status: `/api/romaneio/status`

`GET /api/romaneio/status?data=YYYY-MM-DD` — autenticado como rota normal
de app (mesmo padrão de sessão do upload, não `x-motor-key`). Retorna
contagens agregadas pra aquela `romaneio_data`:
`{ total, ok, falhou, pendente }` (via `SELECT geocode_status, count(*)
FROM romaneio_pontos WHERE romaneio_data = $1 GROUP BY geocode_status`).

### 5. `/romaneio` (página) passa a pollar progresso

Depois que o upload retorna (agora rápido, tudo `pendente`), a página
entra num estado de "processando", pollando `/api/romaneio/status` a
cada ~3-5s (mesmo espírito de polling já usado em `PainelCentral.tsx` pro
`/api/alertas`) até `pendente === 0`. Só então mostra a tabela final de
pontos processados (mesmo formato de hoje).

## Fora de escopo

- Configurar `GOOGLE_MAPS_API_KEY` agora — adiado por decisão explícita
  do usuário. A arquitetura acima já funciona com Google no futuro sem
  mudança nenhuma (é só `geocodificarEndereco` já ter essa cadeia de
  fallback pronta) — só muda a velocidade.
- Qualquer mudança em `parseRomaneio`/`extrairDataRomaneio` (já
  confirmados corretos contra um arquivo real).
- Mudança na tabela `romaneio_pontos`/`romaneio_geocode_cache` (schema já
  serve).
- Retry automático de linhas que falharam geocodificação (`geocode_status
  = 'falhou'`) — ficam assim, mesmo comportamento de hoje (motor ignora
  pontos sem lat/lng).

## Testes

Lógica pura isolável: nenhuma nova (é I/O — parse já testado, geocodificação
já é chamada externa não testada por unit test, mesmo padrão já
documentado em `romaneio-geocode.ts`). Validação: rodar o upload
isoladamente contra um romaneio de teste pequeno (não o de 2041 linhas)
confirmando que retorna rápido com tudo `pendente`; rodar
`/api/romaneio/processar-geocode` manualmente (com o header `x-motor-key`
certo) uma vez, confirmar que processa até 40 linhas e atualiza
status; confirmar cron job criado e ativo via `cron.job`.
`tsc`/`eslint`/suite completa (`vitest`)/`build` limpos nos dois repos
antes do push. Nunca rodar `/api/motor` (motor de veículos, sem relação
com esta feature).
