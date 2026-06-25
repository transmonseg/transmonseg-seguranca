"use server";

const PORTAL = process.env.UNITRAC_PORTAL_URL ?? "https://www2.portalunitrac.com/unitrac";
const USUARIO = process.env.UNITRAC_USUARIO ?? "";
const SENHA = process.env.UNITRAC_SENHA ?? "";

async function obterSessaoUnitrac(): Promise<string | null> {
  if (!USUARIO || !SENHA) return null;
  try {
    const res = await fetch(`${PORTAL}/unitrac_login/unitrac_login.php`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nm_usuario: USUARIO, nm_senha: SENHA }),
      redirect: "manual",
    });
    const cookie = res.headers.get("set-cookie");
    if (!cookie) return null;
    const match = cookie.match(/(?:PHPSESSID|UNITRAC_SID)=([^;]+)/);
    return match ? `${match[0].split("=")[0]}=${match[1]}` : null;
  } catch {
    return null;
  }
}

// Envia comando de saida digital para um veiculo via portal Unitrac.
// O endpoint exato precisa ser confirmado interceptando trafego no portal.
// Enquanto nao confirmado, retorna fallback com link para o portal.
export async function enviarComandoVeiculo(
  cv: string,
  comando: "sirene" | "bloqueio"
): Promise<{ ok: boolean; erro?: string; portalUrl?: string }> {
  const portalUrl = `${PORTAL}/#veiculo/${cv}`;

  if (!USUARIO || !SENHA) {
    return { ok: false, erro: "credenciais_nao_configuradas", portalUrl };
  }

  const sessao = await obterSessaoUnitrac();
  if (!sessao) {
    return { ok: false, erro: "login_falhou", portalUrl };
  }

  const saida = comando === "sirene" ? "1" : "2";

  const candidatos = [
    `/ajax/comando.php`,
    `/mapa/comando.php`,
    `/controle/enviar_comando.php`,
    `/ajax/saida.php`,
  ];

  for (const path of candidatos) {
    try {
      const res = await fetch(`${PORTAL}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: sessao,
        },
        body: new URLSearchParams({ cv, saida, acao: comando }),
      });
      if (res.ok || res.status === 200) {
        const texto = await res.text().catch(() => "");
        if (texto.includes("sucesso") || texto.includes("ok") || texto === "1") {
          return { ok: true };
        }
      }
    } catch {
      // proxima candidata
    }
  }

  return { ok: false, erro: "endpoint_a_confirmar", portalUrl };
}
