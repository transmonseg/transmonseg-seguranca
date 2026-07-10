# Design: desvio com histerese + verificação por corredor real sob suspeita

Data: 2026-07-09. Status: aprovado pelo cliente em conversa.
Pesquisa de base: `~/pesquisas/pesquisa-desvio-rota-sem-rota-planejada-2026-07-09.md`
(estado da arte validado com Phase Gate independente).

## As duas dores (confirmadas com dado real hoje)

1. **Detecção tardia:** a Camada 1 exige que a distância EM LINHA RETA a TODOS
   os destinos cresça +50m em TODA leitura. Em estrada de serra sinuosa a
   linha reta oscila (a estrada curva "aproxima" no mapa mesmo desviando) —
   cada oscilação ZERA o streak e o alerta só sai muito depois do desvio
   começar (vídeo real da operação: desvio pra Xerém só pontuou lá em cima).
2. **Falso positivo em via sinuosa:** o mesmo mecanismo dispara em entrega
   normal quando a estrada real se afasta em linha reta de todos os destinos
   por trechos longos (serra, contorno de vale).

A indústria inteira compara posição contra CAMINHO (corredor de rota ou
histórico), nunca contra distância euclidiana a destinos — ver pesquisa.

## Solução em 2 partes (aditivas, com feature flag)

### Parte 1 — Histerese no streak da Camada 1

Hoje: 1 leitura de aproximação zera `desvioStreak` na hora.
Novo: só zera com **2 leituras CONSECUTIVAS** de aproximação; 1 leitura
isolada de aproximação apenas CONGELA o streak (não incrementa, não zera).

- Detecta mais cedo: oscilação de curva não apaga mais a suspeita acumulada.
- Não dispara mais fácil à toa: o streak continua exigindo o mesmo número de
  leituras de afastamento; só para de ser apagado por ruído.
- Implementação: novo contador `aproximandoConsecutivas` em memória do ciclo
  (persistido em `posicoes_atuais.aproximando_streak`, que JÁ existe da
  migration 013 — é exatamente essa contagem).
- Regra: `afastouDeTudo=true` → streak+1, aproximandoStreak=0.
  `afastouDeTudo=false` → aproximandoStreak+1; se aproximandoStreak >= 2 →
  desvioStreak=0 e desvioInicio=null; senão MANTÉM desvioStreak (congelado).
- Consistência: a mesma regra de 2 leituras já é usada pra RESOLVER o alerta
  (foraDeRota, implementado hoje cedo) — disparo, permanência e resolução
  passam a usar a mesma régua.

### Parte 2 — Verificação por corredor real ANTES de alertar

Quando o gatilho da Camada 1 está prestes a disparar (desvioStreak atinge o
limiar), ANTES de criar o alerta o motor verifica contra a estrada real:

1. Traça rota OSRM da posição ATUAL até os **3 pendentes mais próximos**
   (ou até as bases, se 0 pendentes) — máx 3 chamadas.
2. **Buffer adaptativo** em volta de cada rota (pesquisa: buffer por
   contexto): 300m urbano / 600m rodovia-serra. Proxy de contexto sem mapa:
   velocidade do veículo >= 60 km/h nas últimas leituras → buffer largo
   (rodovia); senão buffer estreito (urbano).
3. Veículo DENTRO de algum corredor → **suprime o alerta** e **cacheia o
   corredor vencedor em memória** (polilinha + buffer). Nos ciclos
   seguintes, enquanto o veículo continuar dentro do corredor cacheado,
   nem chama OSRM de novo (zero chamadas) e o streak fica suprimido.
4. Veículo FORA de todos os corredores → **confirma o alerta na hora**, e o
   `desvio_inicio` vira o ponto onde ele SAIU do corredor (quando houver
   corredor cacheado) — conserta também o marcador de início errado
   reportado pela operação.
5. Corredor cacheado invalida quando: veículo sai dele (reverifica 1x),
   lista de pendentes muda, ou veículo para por 5+ min.

**Restrições de API (achado da pesquisa, obrigatório):**
- OSRM público = 1 req/s, não-comercial, sem garantia. Throttle GLOBAL de
  1 req/s no motor pra chamadas de corredor (fila simples em memória).
- Failover: OSRM falhou/timeout → tenta Valhalla FOSSGIS
  (valhalla1.openstreetmap.de, mesma política 1 req/s, header X-Client-Id).
- Ambos indisponíveis → comporta EXATAMENTE como hoje (dispara sem
  verificação). Nunca segura alerta esperando API.
- Orçamento esperado: verificação só acontece na TRANSIÇÃO pra suspeita
  (não todo ciclo); frota ~440 com ~10-30 suspeitas/hora → dezenas de
  chamadas/hora, ordens de grandeza dentro do fair-use.

**Feature flag:** `CAMADA_CORREDOR_ATIVA` em detectores.ts/motor — desligável
na hora (mesmo padrão do CAMADA3_TAPETE_ATIVA). A ressalva do verificador da
pesquisa: corredor multi-destino sem ordem conhecida não tem caso documentado
em produção — somos pioneiros, então flag + validação com dado real por 24-48h.

### Parte 3 (só coleta, sem detecção) — par origem-destino no tapete

Começar a gravar de qual "origem" (célula de cluster da última parada longa
ou base) pra qual "destino" (célula do pendente mais próximo no momento)
cada célula do tapete foi percorrida. NÃO muda nenhuma detecção agora — é
só pra acumular o dado que permite religar a Camada 3 no futuro no formato
iBOAT (por par O-D), que a pesquisa mostrou ser o correto.
Implementação mínima: colunas `origem_celula`/`destino_celula` em
`corredor_celulas` (migration), preenchidas no mesmo upsert já existente.
Retenção: mesma regra de 30 dias que já existe.

## O que NÃO muda

- Camada 1 continua com os mesmos limiares de disparo (streak >= 2 etc.).
- Nenhum alerta que dispara hoje deixa de existir sem verificação explícita
  (a supressão só acontece quando o OSRM/Valhalla CONFIRMA que o veículo
  está numa estrada que leva a um destino legítimo).
- Resolver por aproximação sustentada (migration 013) intacto.
- Camada 3 (tapete) continua desativada.
- Rastro/paradas/UI intactos.

## Testes

- `detectores.test.ts`: histerese — streak congela com 1 aproximação, zera
  com 2; cenário de serra (afasta, afasta, aproxima 1x, afasta) acumula.
- `desvio-cenarios.test.ts`: simulação multi-ciclo do caso Xerém (desvio
  sustentado com oscilações) dispara mais cedo que hoje.
- Novo `corredor-verificacao.test.ts`: função pura de ponto-dentro-de-buffer
  da polilinha; escolha de buffer por velocidade; invalidação de cache.
- Verificação OSRM mockada (fetch stub) — dentro do corredor suprime, fora
  confirma, API morta = comportamento atual.

## Riscos / rollback

- Flag desliga a Parte 2 na hora; Parte 1 é revertível por commit.
- Throttle 1 req/s pode atrasar verificações em rajada de suspeitas
  simultâneas — mitigação: fila com timeout de 5s; estourou = dispara sem
  verificação (fail-open pra segurança, nunca segura alerta).
- Migration da Parte 3 é aditiva (2 colunas nullable).
