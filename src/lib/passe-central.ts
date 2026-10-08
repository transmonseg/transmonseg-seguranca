import { createHmac, timingSafeEqual } from "node:crypto";

// Login unico com a Central (08/10, "to na conta da Erica e o monitoramento
// mostra Rio Quality"): o monitoramento dentro da Central usava a sessao que ja'
// estivesse aberta no navegador, de qualquer pessoa. O KPI agora abre o quadro
// com um passe curto assinado com PASSE_CENTRAL_SECRET (segredo SO' disso --
// nunca o MOTOR_SECRET, que esta' em arquivo de repo publico) com o email de
// quem esta' logado la'. Formato `<base64url(json {e,x,j})>.<base64url(hmac)>`,
// hmac sobre "entrar-central:<corpo>"; j = id aleatorio, o passe vale uma vez.
// Ver KPI src/lib/passe-central.ts.

/** Passe com validade maior que isso a frente e' recusado (o KPI emite 60 s). */
const VALIDADE_MAX_S = 90;

export type Passe = { email: string; jti: string; x: number };

export function verificarPasse(passe: string | null | undefined, segredo: string | undefined, agoraS: number): Passe | null {
  if (!passe || !segredo) return null;
  const partes = passe.split(".");
  if (partes.length !== 2) return null;
  const [corpo, sig] = partes;
  const esperado = createHmac("sha256", segredo).update(`entrar-central:${corpo}`).digest();
  const recebido = Buffer.from(sig, "base64url");
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null;
  let dados: { e?: unknown; x?: unknown; j?: unknown };
  try { dados = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")); } catch { return null; }
  if (typeof dados.e !== "string" || typeof dados.x !== "number" || typeof dados.j !== "string" || dados.j.length < 8) return null;
  if (dados.x < agoraS || dados.x > agoraS + VALIDADE_MAX_S) return null;
  const email = dados.e.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email, jti: dados.j, x: dados.x } : null;
}

// Passes ja' usados (jti -> validade). Um processo so' (pm2 fork); reiniciar
// zera, mas passe dura 60 s.
const usadosGlobal = new Map<string, number>();

/** true na primeira vez que o passe aparece; false se ja' foi usado. */
export function consumirPasse(p: { jti: string; x: number }, agoraS: number, usados: Map<string, number> = usadosGlobal): boolean {
  for (const [j, x] of usados) if (x < agoraS) usados.delete(j);
  if (usados.has(p.jti)) return false;
  usados.set(p.jti, p.x);
  return true;
}
