import { describe, it, expect } from "vitest";
import { CANDIDATOS } from "./candidatos";

describe("candidatos de regra de afastamento", () => {
  it("all: precisa que TODOS cresçam (comportamento identico ao afastouDeTudo atual)", () => {
    const all = CANDIDATOS.get("all")!;
    expect(all([6000, 8000], [5000, 7000])).toBe(true);
    expect(all([6300, 7200], [6000, 8000])).toBe(false);
  });

  it("topK com K >= N se comporta como ALL (N pequeno, protege contra o incidente de 06/07)", () => {
    for (const chave of ["top3", "top5", "top8"]) {
      const regra = CANDIDATOS.get(chave)!;
      // 2 destinos: 1 cresce, 1 encolhe -- ALL seria false, top-K com K>=2
      // tem que ser false tambem (K efetivo vira min(K, N) = N = ALL).
      expect(regra([6300, 7200], [6000, 8000])).toBe(false);
    }
  });

  it("percentual com N pequeno arredonda pra CIMA (Math.ceil), nao reintroduz o incidente de 06/07", () => {
    for (const chave of ["pct60", "pct80"]) {
      const regra = CANDIDATOS.get(chave)!;
      // 2 destinos, so 1 cresce (o mais proximo) -- se o percentual
      // arredondasse pra baixo (Math.floor(0.6*2)=1), isso dispararia
      // (exatamente o padrao do incidente de 06/07: entrega normal pro
      // cliente nao-mais-proximo). Com Math.ceil, precisa dos 2.
      expect(regra([6300, 7200], [6000, 8000])).toBe(false);
    }
  });

  it("topK: com N grande, so os K mais proximos (na leitura ANTERIOR) precisam crescer", () => {
    const top3 = CANDIDATOS.get("top3")!;
    // 5 destinos; os 3 mais proximos na leitura anterior sao os de indice
    // 0,1,2 (1000,2000,3000) -- todos crescem alem da margem de 50m. Os
    // outros dois (indice 3,4) encolhem, mas nao entram no top-3, entao
    // nao impedem o disparo.
    const anterior = [1000, 2000, 3000, 50000, 60000];
    const atual    = [1100, 2100, 3100, 40000, 55000];
    expect(top3(atual, anterior)).toBe(true);
  });

  it("percentual: >=60% de N grande precisa de maioria, nao de 1 so", () => {
    const pct60 = CANDIDATOS.get("pct60")!;
    // 5 destinos, so 2 crescem (40%) -- abaixo de 60%, nao dispara.
    const anterior = [1000, 2000, 3000, 4000, 5000];
    const atual    = [1100, 2100, 2900, 3900, 4900];
    expect(pct60(atual, anterior)).toBe(false);
  });

  it("todos os candidatos: false com arrays vazios ou de tamanhos diferentes", () => {
    for (const regra of CANDIDATOS.values()) {
      expect(regra([], [])).toBe(false);
      expect(regra([5000], [])).toBe(false);
    }
  });
});
