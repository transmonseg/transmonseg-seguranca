# OSRM self-hosted no Contabo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** eliminar o throttle de 1 req/s (política do OSRM público) na
verificação de corredor, hospedando OSRM no Contabo — permite testar
TODOS os destinos pendentes por verificação, não só 3-5, resolvendo a
causa raiz do padrão "desvio falso chegando no cliente / voltando pra
base".

**Architecture:** motor OSRM (`osrm-backend`, algoritmo MLD, extrato do
Brasil inteiro) rodando via Docker no VPS `transmonseg-vps`, porta 5001.
`verificarCorredor` ganha uma nova Camada 0 (self-hosted, sem throttle,
testa todos os destinos) que roda ANTES da cadeia existente
(OSRM público → Valhalla, ambas intocadas, preservadas como fallback).

**Tech Stack:** Docker, OSRM (osrm-backend, MLD), TypeScript/Node.

## Global Constraints

- A cadeia de fallback ATUAL (OSRM público → Valhalla) nunca é removida —
  só ganha uma camada nova ANTES dela. Se o self-hosted cair por qualquer
  motivo, o comportamento é idêntico ao de hoje, nunca pior.
- Fail-open preservado: nenhuma camada (nova ou antiga) pode travar/atrasar
  um alerta esperando API — timeout curto (1s) na chamada local.
- Porta do OSRM local: **5001** (5000 já é usado pelo Storage-API do KPI
  no mesmo VPS, confirmado no Caddyfile).
- Extrato: **Brasil inteiro** (Geofabrik `brazil-latest.osm.pbf`) — decisão
  do usuário, cobre o range real observado nas posições dos últimos 30
  dias (RJ, SP, MG, ES e além), não só Rio de Janeiro.
- Toda mudança de código replicada pro repo espelho `MONITORAMENTO
  transmonseg` e deployada nos 2 processos PM2 antes de considerar o
  plano encerrado.
- Spec completa: `docs/superpowers/specs/2026-08-09-osrm-self-hosted-design.md`.

---

### Task 1: Infraestrutura — OSRM rodando no Contabo

**Files:** nenhum (trabalho de infraestrutura via SSH, não código do repo).

**Interfaces:**
- Produces: serviço HTTP compatível com a API do OSRM (`GET /route/v1/driving/{lng},{lat};{lng},{lat}?geometries=geojson&overview=full`) respondendo em `http://127.0.0.1:5001` no VPS `transmonseg-vps` — consumido pela Task 2.

- [ ] **Step 1: Instalar Docker**

```bash
ssh transmonseg-vps "which docker || curl -fsSL https://get.docker.com | sh"
```

Expected: `docker --version` funciona depois.

- [ ] **Step 2: Baixar o extrato do Brasil**

```bash
ssh transmonseg-vps "mkdir -p /srv/osrm && cd /srv/osrm && wget -q https://download.geofabrik.de/south-america/brazil-latest.osm.pbf && ls -lh brazil-latest.osm.pbf"
```

Expected: arquivo baixado, tipicamente 1-2GB — confirme com `ls -lh` que
não está truncado/vazio (falha de rede pode deixar um arquivo parcial).

- [ ] **Step 3: Pré-processar (extract → partition → customize)**

```bash
ssh transmonseg-vps "cd /srv/osrm && docker run -t -v \"\$(pwd):/data\" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/brazil-latest.osm.pbf"
ssh transmonseg-vps "cd /srv/osrm && docker run -t -v \"\$(pwd):/data\" ghcr.io/project-osrm/osrm-backend osrm-partition /data/brazil-latest.osrm"
ssh transmonseg-vps "cd /srv/osrm && docker run -t -v \"\$(pwd):/data\" ghcr.io/project-osrm/osrm-backend osrm-customize /data/brazil-latest.osrm"
```

Expected: os 3 comandos rodam sem erro (podem demorar — extract de um
extrato do tamanho do Brasil pode levar de alguns minutos a ~1h dependendo
da CPU; a VPS tem 6 CPUs/11GB RAM, deve ir bem dentro disso — não é sinal
de erro estar demorando, só não interrompa antes de terminar). Ao final,
`ls /srv/osrm/` deve ter `brazil-latest.osrm.*` (múltiplos arquivos
auxiliares do MLD).

- [ ] **Step 4: Subir o serviço**

```bash
ssh transmonseg-vps "docker run -d --name osrm-transmonseg --restart unless-stopped -p 5001:5000 -v /srv/osrm:/data ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/brazil-latest.osrm"
```

- [ ] **Step 5: Validar com uma consulta real**

```bash
ssh transmonseg-vps "curl -s 'http://127.0.0.1:5001/route/v1/driving/-43.2078,-22.9068;-43.1729,-22.9068?overview=false' | head -c 300"
```

Expected: JSON com `"code":"Ok"` e uma rota real entre 2 pontos do Rio de
Janeiro (coordenadas de teste: Copacabana → Flamengo, só pra confirmar que
o motor está respondendo com dado real, não um erro).

- [ ] **Step 6: Confirmar restart automático**

```bash
ssh transmonseg-vps "docker inspect osrm-transmonseg --format '{{.HostConfig.RestartPolicy.Name}}'"
```

Expected: `unless-stopped` — garante que sobrevive a reboot da VPS.

---

### Task 2: `corredor-verificacao.ts` — Camada 0 self-hosted

**Files:**
- Modify: `src/lib/corredor-verificacao.ts`
- Test: `src/lib/corredor-verificacao.test.ts` (criar se não existir)

**Interfaces:**
- Consumes: serviço OSRM local da Task 1 (`http://127.0.0.1:5001`, ou
  `process.env.OSRM_LOCAL_URL` se definida).
- Produces: `verificarCorredor` mantém a MESMA assinatura pública
  (`(origem, posAtual, destinos) => Promise<{veredito, corredor}>`) — quem
  chama (route.ts, Task 3) não muda a forma de chamar, só o que passa como
  `destinos`.

- [ ] **Step 1: Escrever os testes**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verificarCorredor } from "./corredor-verificacao";

describe("verificarCorredor (Camada 0 self-hosted + fallback público preservado)", () => {
  const origem = { lat: -22.9, lng: -43.2 };
  const posAtual = { lat: -22.9005, lng: -43.2005, velocidade: 30 };
  const destinos = Array.from({ length: 8 }, (_, i) => ({ lat: -22.9 + i * 0.01, lng: -43.2 + i * 0.01 }));

  const rotaGeoJSON = (coords: [number, number][]) => ({
    code: "Ok",
    routes: [{ geometry: { coordinates: coords }, distance: 1000 }],
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("self-hosted responde e posicao esta dentro do buffer: dentro, SEM chamar o fallback publico", async () => {
    const rotaPertoDaPos = [[-43.2005, -22.9005], [-43.19, -22.89]] as [number, number][];
    (fetch as any).mockImplementation((url: string) => {
      expect(url).toContain("127.0.0.1:5001");
      return Promise.resolve({ ok: true, json: async () => rotaGeoJSON(rotaPertoDaPos) });
    });
    const r = await verificarCorredor(origem, posAtual, destinos);
    expect(r.veredito).toBe("dentro");
    // so o self-hosted deveria ter sido chamado (1 destino ate achar match) --
    // nenhuma chamada pro dominio publico do osrm/valhalla.
    const chamadas = (fetch as any).mock.calls.map((c: any[]) => c[0]);
    expect(chamadas.every((u: string) => u.includes("127.0.0.1:5001"))).toBe(true);
  });

  it("self-hosted responde mas fora do buffer pra TODOS os destinos: fora, testa a lista inteira (nao so 3)", async () => {
    const rotaLonge = [[10, 10], [11, 11]] as [number, number][];
    (fetch as any).mockImplementation(() => Promise.resolve({ ok: true, json: async () => rotaGeoJSON(rotaLonge) }));
    const r = await verificarCorredor(origem, posAtual, destinos);
    expect(r.veredito).toBe("fora");
    expect((fetch as any).mock.calls.length).toBe(destinos.length); // todos os 8, nao 3
  });

  it("self-hosted indisponivel (fetch rejeita) pra todos, publico responde: cai pro fallback existente", async () => {
    (fetch as any).mockImplementation((url: string) => {
      if (url.includes("127.0.0.1:5001")) return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve({ ok: true, json: async () => rotaGeoJSON([[-43.2005, -22.9005], [-43.19, -22.89]]) });
    });
    const r = await verificarCorredor(origem, posAtual, destinos);
    expect(r.veredito).toBe("dentro");
    // fallback publico so deveria ter sido chamado com ate 3 candidatos
    const chamadasPublicas = (fetch as any).mock.calls.filter((c: any[]) => !c[0].includes("127.0.0.1:5001"));
    expect(chamadasPublicas.length).toBeLessThanOrEqual(3);
  });

  it("self-hosted E publico indisponiveis: indisponivel (fail-open preservado)", async () => {
    (fetch as any).mockImplementation(() => Promise.reject(new Error("network down")));
    const r = await verificarCorredor(origem, posAtual, destinos);
    expect(r.veredito).toBe("indisponivel");
  });

  it("destinos vazio: indisponivel, nenhuma chamada de rede", async () => {
    const r = await verificarCorredor(origem, posAtual, []);
    expect(r.veredito).toBe("indisponivel");
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: FAIL (função ainda não tem a Camada 0).

- [ ] **Step 3: Implementar `rotaOSRMLocal` e reescrever `verificarCorredor`**

Usar exatamente o código da seção "Mudanças de código" da spec
(`docs/superpowers/specs/2026-08-09-osrm-self-hosted-design.md`) — inclui
`rotaOSRMLocal`, a constante `MAX_CANDIDATOS_FALLBACK_PUBLICO = 3`, e a
função `verificarCorredor` reescrita com as 2 camadas.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/lib/corredor-verificacao.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo.

- [ ] **Step 6: Commit**

```bash
git add src/lib/corredor-verificacao.ts src/lib/corredor-verificacao.test.ts
git commit -m "feat(desvio): OSRM self-hosted como camada 0 da verificação de corredor, sem throttle"
```

---

### Task 3: `route.ts` — parar de cortar em 3 antes de chamar `verificarCorredor`

**Files:**
- Modify: `src/app/api/motor/route.ts`

**Interfaces:**
- Consumes: `verificarCorredor` da Task 2 (mesma assinatura pública).

**Contexto importante:** existem 3 call sites de `verificarCorredor` neste
arquivo. **Só 1 precisa mudar.** Os outros 2 (~linha 2453 e ~linha 2484,
mecanismo de "cerca virtual") já passam `todosPendentesPriorizados()` —
a lista COMPLETA, ordenada por `ordenarPendentesPorDistancia(pos,
destinosCerca, rumoMovimento)` — corrigido no achado real de 15/07, não
tem corte de 3 ali. Não toque nesses dois — já estão certos, e a nova
Camada 0 (Task 2) vai testar a lista inteira que eles já mandam.

- [ ] **Step 1: Corrigir o 3º call site (linha ~3045-3053 hoje)**

Este é o call site do detector comportamental principal (o que decide se
`afastando_de_tudo`/`rumo_diverge` é suprimido por "dentro do corredor" —
o mecanismo por trás do motivo "Fora da rota esperada"). Hoje monta
`candidatos` com um sort MANUAL por distância pura (não usa
`ordenarPendentesPorDistancia`) e corta em 3 ANTES de chamar:

```typescript
              const candidatos = [...destinos]
                .map((d) => ({ d, dist: haversineM(pos.lat, pos.lng, d.lat, d.lng) }))
                .sort((a, b) => a.dist - b.dist)
                .slice(0, 3)
                .map((x) => x.d);
              const r = await verificarCorredor(origem, { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade }, candidatos);
```

Trocar para passar `destinos` diretamente, ordenado por distância mas SEM
cortar (o `.slice(0, 3)` sai — a função agora decide internamente quanto
testar em cada camada, ver Task 2):

```typescript
              const candidatos = [...destinos].sort(
                (a, b) => haversineM(pos.lat, pos.lng, a.lat, a.lng) - haversineM(pos.lat, pos.lng, b.lat, b.lng)
              );
              const r = await verificarCorredor(origem, { lat: pos.lat, lng: pos.lng, velocidade: pos.velocidade }, candidatos);
```

(Mantém o sort por distância pura deste call site específico, só remove o
corte — trocar para `ordenarPendentesPorDistancia` com rumo aqui seria
uma mudança de comportamento a mais, fora do escopo desta task; se quiser
fazer depois, é uma mudança separada e pequena.)

- [ ] **Step 2: Typecheck e suite completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/motor/route.ts
git commit -m "feat(desvio): passar todos os destinos pendentes pra verificarCorredor, corte movido pra dentro da função"
```

---

### Task 4: Replicar pro repo espelho + deploy + validação em produção

**Files:**
- Nenhum arquivo novo — cópia exata dos diffs das Tasks 2-3 pro repo `MONITORAMENTO transmonseg`. Task 1 (infra) é compartilhada — não precisa repetir, os 2 processos (`transmonseg-temp`/`transmonseg-definitivo`) já rodam na MESMA VPS e vão falar com o MESMO OSRM local.

**Interfaces:**
- Consumes: commits das Tasks 2-3 (repo `MONITORAMENTO TEMP`), serviço OSRM da Task 1.
- Produces: mesma mudança de código rodando em produção real — encerra o plano.

- [ ] **Step 1: Confirmar que os repos não divergiram**

```bash
cd ~/Projects/Transmonseg/monitoramento
diff "MONITORAMENTO TEMP/src/lib/corredor-verificacao.ts" "MONITORAMENTO transmonseg/src/lib/corredor-verificacao.ts"
diff "MONITORAMENTO TEMP/src/app/api/motor/route.ts" "MONITORAMENTO transmonseg/src/app/api/motor/route.ts"
```

Se algum diff não estiver vazio fora as mudanças das Tasks 2-3, pare e reporte BLOCKED.

- [ ] **Step 2: Copiar os arquivos tocados + docs**

```bash
cp "MONITORAMENTO TEMP/src/lib/corredor-verificacao.ts" "MONITORAMENTO transmonseg/src/lib/corredor-verificacao.ts"
cp "MONITORAMENTO TEMP/src/lib/corredor-verificacao.test.ts" "MONITORAMENTO transmonseg/src/lib/corredor-verificacao.test.ts"
cp "MONITORAMENTO TEMP/src/app/api/motor/route.ts" "MONITORAMENTO transmonseg/src/app/api/motor/route.ts"
cp "MONITORAMENTO TEMP/docs/superpowers/specs/2026-08-09-osrm-self-hosted-design.md" "MONITORAMENTO transmonseg/docs/superpowers/specs/"
cp "MONITORAMENTO TEMP/docs/superpowers/plans/2026-08-09-osrm-self-hosted.md" "MONITORAMENTO transmonseg/docs/superpowers/plans/"
```

- [ ] **Step 3: Testes e typecheck no repo espelho**

```bash
cd "MONITORAMENTO transmonseg"
npx tsc --noEmit
npx vitest run
```

- [ ] **Step 4: Commit e push dos dois repos**

```bash
git add -A
git commit -m "feat(desvio): OSRM self-hosted na verificação de corredor (replica de MONITORAMENTO TEMP)"
git push origin main
cd "../MONITORAMENTO TEMP"
git push origin master
```

- [ ] **Step 5: Deploy manual no Contabo**

```bash
ssh transmonseg-vps "cd /srv/transmonseg/temp && git pull && npm ci && npm run build && pm2 restart transmonseg-temp --update-env"
ssh transmonseg-vps "cd /srv/transmonseg/definitivo && git pull && npm ci && npm run build && pm2 restart transmonseg-definitivo --update-env"
```

- [ ] **Step 6: Confirmar não regressão**

```bash
ssh transmonseg-vps "pm2 jlist | node -e 'let d=\"\"; process.stdin.on(\"data\",c=>d+=c); process.stdin.on(\"end\",()=>{JSON.parse(d).forEach(p=>console.log(p.name, p.pid, p.pm2_env.status, p.pm2_env.restart_time))})'"
ssh transmonseg-vps "pm2 logs transmonseg-definitivo --lines 40 --nostream"
```

Expected: ambos os processos online, sem erro novo relacionado a
"corredor"/"osrm"/"5001".

- [ ] **Step 7: Validação real em produção**

Confirmar que a Camada 0 está sendo usada de verdade (não só que não
quebrou nada):

```bash
ssh transmonseg-vps "docker logs osrm-transmonseg --tail 50"
```

Expected: linhas de log de requisições reais chegando (confirma que o
motor está recebendo tráfego do app, não só respondendo ao curl de teste
da Task 1).

Comparação de taxa de falso positivo do segmento `corredor_veredito:fora`
fica como acompanhamento pra depois (precisa de volume real acumulado,
não dá pra confirmar no mesmo dia do deploy) — anotar no ledger como
verificação pendente de dados, não bloqueante pro encerramento do plano.
