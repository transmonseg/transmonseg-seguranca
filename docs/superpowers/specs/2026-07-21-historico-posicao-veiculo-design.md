# Histórico de posição do veículo, Design

**Data:** 2026-07-21
**Status:** aprovado pelo usuário, indo para plano

## Problema

Problema C da investigação de systematic-debugging de hoje: não existe
nenhum histórico de posição de veículo — só `posicoes_atuais`, sobrescrita a
cada ciclo do motor (~30s). Isso tornou impossível reconstruir
retroativamente o momento exato de 2 casos reais reportados pelo usuário
hoje (desvio real visível no print do Unitrac, sem alerta correspondente no
sistema) — só foi possível achar a causa raiz estrutural (Problema A, já
corrigido), não confirmar o instante exato em que aquele veículo específico
esteve fora do corredor.

Sem histórico, qualquer bug relatado depois do fato (horas ou dias depois)
não tem como ser investigado com precisão — só dá pra inferir padrão
estrutural, nunca reconstruir o que aconteceu literalmente.

## Decisão

Nova tabela `posicoes_historico`, gravando a posição de **todo veículo, todo
ciclo** (sem filtro) — decisão explícita do usuário nesta sessão de não
otimizar por custo/volume agora. Reaproveita 100% o array `posicoesCiclo` já
montado no motor (mesmos dados que já alimentam `posicoes_atuais`) — zero
query nova pra buscar dado, só um INSERT em lote a mais no mesmo ponto onde
`posicoes_atuais` já é atualizada.

**Retenção: 90 dias**, com limpeza automática seguindo o mesmo padrão já
existente no motor pra alertas resolvidos (`DELETE FROM alertas WHERE ...
< now() - interval '30 days'`).

## Escopo

1. **Migration** (`023` já existe — próximo número: `024`):

```sql
-- 024_posicoes_historico.sql
CREATE TABLE posicoes_historico (
  id bigint generated always as identity primary key,
  veiculo_id uuid NOT NULL REFERENCES veiculos(id),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  velocidade integer NOT NULL,
  ignicao boolean NOT NULL,
  atraso_min integer NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posicoes_historico_veiculo_tempo_idx ON posicoes_historico (veiculo_id, criado_em);
```

Sem RLS/geography — é tabela de auditoria/debug interna, consultada só via
script direto (mesmo padrão de `cerca_sombra`), nunca exposta a rota
pública/client.

2. **`src/app/api/motor/route.ts`**: logo após o bloco de upsert em lote de
   `posicoes_atuais` (linha ~2149, mesmo ponto onde `cercaSombraCiclo` já é
   gravado logo abaixo), adiciona um INSERT em lote em `posicoes_historico`
   reaproveitando o MESMO array `posicoesCiclo` (campos `veiculo_id, lat,
   lng, velocidade, ignicao, atraso_min` — subconjunto do que já existe nesse
   array, nenhum campo novo precisa ser calculado). Mesmo padrão defensivo de
   `cerca_sombra`: nunca derruba o motor (erro só vira `console.warn`, não
   `erros.push`).

3. **Limpeza automática**: no mesmo bloco de limpeza do motor que já roda
   `DELETE FROM alertas WHERE ... < now() - interval '30 days'` (linha
   ~2582-2587), adiciona:

```sql
DELETE FROM posicoes_historico WHERE criado_em < now() - interval '90 days'
```

## Fora de escopo

Nenhuma tela/API nova pra consultar esse histórico agora — é dado pra
consulta manual via script/psql quando um caso for reportado, mesmo padrão
já usado o dia inteiro nesta sessão pra investigar `cerca_sombra`,
`alertas`, etc. Se no futuro fizer sentido uma tela de "replay de rota" pro
operador, isso é um projeto à parte.

## Testes

Migration aplicada e coluna/índice confirmados. Validação isolada (nunca
rodar o motor de produção): script Node avulso simulando o INSERT em lote
contra a tabela real, confirmando que a linha aparece com os campos
corretos, depois removida. `tsc`/`eslint`/suite completa/`build` limpos nos
dois repos antes do push.
