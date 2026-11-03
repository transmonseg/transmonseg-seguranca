// Watchdog do motor (DSV-02, auditoria 03/11): alem dos relogios de lease, o
// motor-romaneio precisa estar PROCESSANDO carro (romaneio_desvio_estado
// atualizado) quando ha romaneio do dia -- o lease pode ser pego e o ciclo
// morrer logo depois, e o adquirido_em continua "fresco".
// Roda o script de verdade com DRY=1 e WATCHDOG_MIN (pula o banco).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./watchdog-motor.sh", import.meta.url));
function rodar(min: string): string {
  return execFileSync("bash", [SCRIPT], { env: { ...process.env, DRY: "1", WATCHDOG_MIN: min }, encoding: "utf8" });
}

describe("watchdog-motor.sh", () => {
  it("tudo em dia: motor ok", () => {
    expect(rodar("1|1|1|2")).toMatch(/motor ok/);
  });
  it("motor-romaneio pega o lease mas nao processa carro ha 20 min com romaneio do dia: alerta", () => {
    const out = rodar("1|1|1|20");
    expect(out).toMatch(/ALERTA/);
    expect(out).toMatch(/motor-romaneio sem avaliar nenhum carro ha 20 min/);
  });
  it("limite do processamento e' 15 min", () => {
    expect(rodar("1|1|1|15")).toMatch(/motor ok/);
  });
  it("formato antigo de 3 campos continua valendo", () => {
    expect(rodar("1|1|1")).toMatch(/motor ok/);
    expect(rodar("1|1|9")).toMatch(/motor-romaneio sem iniciar ciclo ha 9 min/);
  });
});
