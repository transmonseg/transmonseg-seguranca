import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Trava do redesign de 26/09: nenhum texto abaixo de 12px e so os raios do
// sistema nos arquivos do monitor. Varre o codigo-fonte porque o repo nao tem
// RTL/jsdom pra medir o DOM.
const ARQUIVOS = [
  "src/app/(app)/central-v2/MonitorV2.tsx",
  "src/app/(app)/central-v2/EscopoMapaSwitcher.tsx",
  "src/app/(app)/central-v2/AvisoDesvioTopo.tsx",
  "src/app/(app)/central-v2/PopoverMapa.tsx",
  "src/app/(app)/components/MenuMotivoFalso.tsx",
  "src/app/(app)/components/AlertaSonoro.tsx",
];
const RAIOS_OK = new Set(["0", "8", "14", "999", "\"50%\"", "'50%'", "RAIO.control", "RAIO.panel", "RAIO.capsule"]);

describe("guarda do design", () => {
  for (const f of ARQUIVOS) {
    const src = readFileSync(f, "utf8");
    it(`${f}: fontSize numerico >= 12`, () => {
      const ruins = [...src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)\b/g)].map(m => Number(m[1])).filter(n => n < 12);
      expect(ruins).toEqual([]);
    });
    it(`${f}: fontSize clamp/string/expressao sem numero < 12px`, () => {
      // Cobre string/template literals (clamp(...), "12px" etc) E qualquer numero
      // 9/10/10.5/11 escondido em expressoes/ternarios depois de "fontSize:"
      // ate a proxima virgula/chave/fim de linha (ex: `fontSize: compacto ? 10 : 12`).
      const trechos = [...src.matchAll(/fontSize:\s*([^,}\n]*(?:`[^`]*`)?[^,}\n]*)/g)].map(m => m[1]);
      const ruins = trechos.filter(v => [...v.matchAll(/(\d+(?:\.\d+)?)(?:px)?\b/g)]
        .some(x => Number(x[1]) < 12 && Number(x[1]) > 0));
      expect(ruins).toEqual([]);
    });
    it(`${f}: borderRadius so 0/8/14/999/50%`, () => {
      const ruins = [...src.matchAll(/borderRadius:\s*([^,}\n]+)/g)].map(m => m[1].trim())
        .filter(v => !RAIOS_OK.has(v) && !/^(?:RAIO\.|`|["']\d+px \d+px)/.test(v));
      expect(ruins).toEqual([]);
    });
  }
});
