// RAS-01 (auditoria 03/11): o watchdog olhava max(updated_at) da tabela
// inteira -- se um cliente para de gravar e o outro continua, ninguém era
// avisado. Agora confere também por cliente ativo. DRY=1 só imprime.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./watchdog-motor.sh", import.meta.url));
const rodar = (env) => execFileSync("bash", [SCRIPT], { env: { ...process.env, DRY: "1", ...env }, encoding: "utf8" });

describe("watchdog-motor por cliente", () => {
  it("Rio Quality sem gravar há 12 min com a Nutry gravando => alerta citando o cliente", () => {
    const out = rodar({ WATCHDOG_MIN: "0|0|0", WATCHDOG_CLIENTES: "Nutry Max=0;Rio Quality=12" });
    expect(out).toMatch(/ALERTA: .*Rio Quality sem posicao gravada ha 12 min/);
    expect(out).not.toMatch(/Nutry Max sem posicao/);
  });
  it("todos os clientes gravando => motor ok", () => {
    const out = rodar({ WATCHDOG_MIN: "0|0|0", WATCHDOG_CLIENTES: "Nutry Max=1;Rio Quality=2" });
    expect(out).toMatch(/motor ok/);
  });
  it("cliente sem nenhuma posição (x) não alerta e não quebra", () => {
    const out = rodar({ WATCHDOG_MIN: "0|0|0", WATCHDOG_CLIENTES: "Nutry Max=1;Novo=x" });
    expect(out).toMatch(/motor ok/);
  });
});
