import { createHmac, timingSafeEqual } from "node:crypto";

// Login unico com a Central (08/10, "to na conta da Erica e o monitoramento
// mostra Rio Quality"): o monitoramento dentro da Central usava a sessao que ja'
// estivesse aberta no navegador, de qualquer pessoa. O KPI agora abre o quadro
// com um passe curto assinado (MOTOR_SECRET, o mesmo das rotas da ponte) com o
// email de quem esta' logado la' -- formato `<base64url(json {e,x})>.<base64url(hmac)>`,
// hmac sobre "entrar-central:<corpo>". Ver KPI src/lib/passe-central.ts.

/** Passe com validade maior que isso a frente e' recusado (o KPI emite 60 s). */
const VALIDADE_MAX_S = 300;

export function verificarPasse(passe: string | null | undefined, segredo: string | undefined, agoraS: number): { email: string } | null {
  if (!passe || !segredo) return null;
  const partes = passe.split(".");
  if (partes.length !== 2) return null;
  const [corpo, sig] = partes;
  const esperado = createHmac("sha256", segredo).update(`entrar-central:${corpo}`).digest();
  const recebido = Buffer.from(sig, "base64url");
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null;
  let dados: { e?: unknown; x?: unknown };
  try { dados = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")); } catch { return null; }
  if (typeof dados.e !== "string" || typeof dados.x !== "number") return null;
  if (dados.x < agoraS || dados.x > agoraS + VALIDADE_MAX_S) return null;
  const email = dados.e.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : null;
}
