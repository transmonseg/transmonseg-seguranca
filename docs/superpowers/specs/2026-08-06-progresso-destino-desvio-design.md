# Monitoramento — Anotação de progresso ao destino em alertas de "afastando de tudo"

Data: 2026-08-06
Status: aprovado em conversa

## Contexto

Investigação com rastro GPS real de 46 alertas de desvio dos últimos 3 dias (cliente Nutry Max) confirmou 61% (11/18) dos alertas `afastando_de_tudo` ("Afastando-se de todos os X destinos") como falso positivo genuíno — o veículo estava legitimamente a caminho de uma base ou entrega, mas o gatilho de 2 minutos disparou por ruído normal de geometria de rua antes da chegada ser confirmada.

O sistema já se autocorrige: `deveAutoResolverAfastandoChegadaReal` (detectores.ts) fecha o alerta assim que o veículo realmente chega e para em qualquer destino/base conhecido (`chegouEmDestinoConhecido`). O problema não é falta de detecção de chegada — é que, **enquanto o alerta continua ativo aguardando essa chegada**, o operador não tem nenhum jeito rápido de saber se aquele alerta específico está "progredindo pra algum lugar conhecido" ou "genuinamente sem destino por perto", sem abrir o mapa manualmente pra cada um.

**Achado de segurança que descarta a solução óbvia:** `afastando_de_tudo` foi desenhado deliberadamente **sem piso de distância mínima** ("um desvio de 500m já pode ser um assalto em andamento — não dá pra esperar acumular quilômetros", comentário em detectores.ts). Rebaixar severidade ou atrasar escalonamento automaticamente com base em "parece estar progredindo" contraria essa decisão explícita — um sequestrador forçando o motorista numa direção que coincidentemente parece progredir reduziria a urgência exatamente quando mais importa. Esse mesmo tipo de mudança (auto-fechar/suprimir com base num sinal de proximidade) já causou uma regressão real neste código em julho (2 desvios reais perdidos, revertido em 31/07).

## Escopo

**Dentro:**
- Anotar, a cada ciclo do motor, no `contexto` de alertas `afastando_de_tudo` ativos, o valor já calculado `afastamentoAcumuladoM` (positivo = ainda se afastando do destino mais próximo desde que o alerta começou; negativo = já se aproximando de novo) — reaproveita o mesmo padrão já em produção pra `proximidade_atual`/`rota_concluida` (mesmo bloco em `motor/route.ts`, `update alertas set contexto = contexto || $2::jsonb`, só adiciona campo, nunca muda `nivel`/`status`, nunca fecha o alerta).
- Passar esse campo adiante em `page.tsx` (`enriquecer()`, hoje descarta `contexto` inteiro exceto o booleano `rotaConcluida`).
- Exibir no card do alerta (`MonitorV2.tsx`, logo abaixo do motivo) uma linha curta e visualmente diferenciada — ex: "aproximando de um destino (-120m)" vs "ainda se afastando (+340m)" — só informativa, o card continua com a mesma cor/prioridade de severidade de sempre.

**Fora:**
- Qualquer mudança em `nivel`, `status`, na lógica de disparo (`afastouDeTudo`), na janela de 2 ciclos, ou em qualquer forma de fechamento/supressão automática — nada disso muda.
- Estender o mesmo tratamento pra `classe_viaria`/`corredor` (achados separados da mesma investigação, decisão adiada — aquelas regras têm sinal mais ambíguo, precisam de mais dado antes de qualquer mudança, mesmo que só informativa).
- Mudar a ordenação/priorização da fila de alertas com base nesse sinal (isso teria o mesmo risco de "reduzir urgência automaticamente" que este spec evita).

## Arquitetura

```
motor/route.ts (a cada ciclo, ~30s)
  já calcula: afastamentoAcumuladoM (existe hoje, só usado no fechamento)
  NOVO: se alerta ativo com motivo iniciando "Afastando-se de todos"
        → update contexto || {"progresso_destino": {"delta_m": N, "atualizado_em": ts}}
        (mesmo bloco/padrão de "Anotação de proximidade em alertas de desvio ativos")

page.tsx (enriquecer())
  NOVO: extrai contexto.progresso_destino, passa pro componente
        (mesmo padrão de rotaConcluida)

MonitorV2.tsx (card do alerta)
  NOVO: se progresso_destino presente, linha curta abaixo do motivo
        delta_m < 0 → "aproximando de um destino (Xm)"
        delta_m >= 0 → "ainda se afastando (+Xm)"
```

## Riscos e mitigação

- **Confundir o operador achando que "aproximando" significa resolvido**: o texto não deve sugerir isso — é só um sinal a mais, o card continua exigindo ação humana igual a qualquer desvio. Redação da Task de implementação deve deixar isso claro (ex: nunca usar palavras como "ok"/"seguro"/cor verde-sucesso).
- **Zero risco de regressão de detecção**: nenhuma mudança em `afastouDeTudo`, `nivel`, streaks ou fechamento — só leitura de um valor já calculado, anotado do mesmo jeito que 2 mecanismos já em produção fazem.
- **Zero risco ao Monitoramento em geral**: mudança isolada a um campo de contexto + exibição, mesmo padrão replicado nos dois repos (TEMP/definitivo) + deploy manual PM2 de sempre.
