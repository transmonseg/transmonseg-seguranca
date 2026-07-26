"use server";

import pg from "pg";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";

// Portal humano da Unitrac (autenticado, com captcha no login) — diferente
// da API aberta datalayer.portalunitrac.com usada pro resto do app.
// Comandos de saida digital (sirene, bloqueio) so existem por aqui.
const PORTAL = "https://www2.portalunitrac.com/unitrac";

function criarPool() {
  return new pg.Pool({
    ...configPoolContabo(process.env.DATABASE_URL),
    max: 2,
  });
}

// ─── Sessao guardada (singleton, 1 linha) ──────────────────────────────────
// O login do portal tem reCAPTCHA v2 de verdade — nao da pra automatizar.
// Um humano loga uma vez (script scripts/capturar-sessao-unitrac.mjs) e essa
// sessao fica guardada aqui, reusada em todo comando ate expirar por
// inatividade. manterSessaoViva() (chamado pelo motor a cada ciclo) evita a
// expiracao pingando a sessao periodicamente.

async function lerSessaoGuardada(): Promise<string | null> {
  const pool = criarPool();
  try {
    const { rows } = await pool.query<{ cookie: string; ok: boolean }>(
      `select cookie, ok from unitrac_sessao where id = 1`
    );
    if (rows.length === 0 || !rows[0].ok) return null;
    return rows[0].cookie;
  } catch {
    return null;
  } finally {
    await pool.end();
  }
}

// Chamado pelo script de captura manual (login com captcha feito por humano)
// pra guardar a sessao recem-obtida.
export async function salvarSessaoUnitrac(cookiePhpSessId: string): Promise<void> {
  const pool = criarPool();
  try {
    await pool.query(
      `insert into unitrac_sessao (id, cookie, criado_em, atualizado_em, ok)
       values (1, $1, now(), now(), true)
       on conflict (id) do update set
         cookie = excluded.cookie,
         criado_em = now(),
         atualizado_em = now(),
         ok = true`,
      [cookiePhpSessId]
    );
  } finally {
    await pool.end();
  }
}

// Keep-alive: pinga a sessao guardada pra resetar o timer de inatividade do
// PHP no servidor da Unitrac. Chamado pelo motor a cada ciclo (ver
// src/app/api/motor/route.ts). Marca ok=false se a sessao morreu — alguem
// precisa rodar scripts/capturar-sessao-unitrac.mjs de novo pra renovar.
export async function manterSessaoViva(): Promise<{ viva: boolean }> {
  const cookie = await lerSessaoGuardada();
  if (!cookie) return { viva: false };

  try {
    const res = await fetch(`${PORTAL}/unitrac_menu_principal2/unitrac_menu_principal2.php`, {
      headers: { cookie: `PHPSESSID=${cookie}` },
      redirect: "manual",
    });
    const corpo = await res.text().catch(() => "");
    // Se a sessao caiu, o portal devolve o form de login de novo (campo password).
    const viva = res.status === 200 && !/name=["']password["']/i.test(corpo);

    const pool = criarPool();
    try {
      await pool.query(`update unitrac_sessao set atualizado_em = now(), ok = $1 where id = 1`, [viva]);
    } finally {
      await pool.end();
    }
    return { viva };
  } catch {
    return { viva: false };
  }
}

// ─── Envio de sirene (confirmado via HAR real em 04/07/2026) ──────────────
// Formulario ScriptCase de 2 passos: abrir (pega csrf_token novo) e enviar.
// Ver memoria project_transmonseg_comando_sirene_bloqueio pro histórico completo.

interface DadosRastreador {
  identificacao: string; // placa
  seriemodulo: string; // IMEI do modulo rastreador
  protocolo: string; // modelo/protocolo do hardware, ex "TELTONIKA CODEC 8"
  idprotocolo: string; // id do registro de protocolo no Unitrac, por veiculo
}

function extrairCampoHidden(html: string, nome: string): string | null {
  const re = new RegExp(`name=["']${nome}["'][^>]*value=["']([^"']*)["']`, "i");
  const m = html.match(re);
  return m ? m[1] : null;
}

// script_case_init observado na unica captura confirmada ate agora. NAO
// esta confirmado se esse valor e portavel entre sessoes diferentes (pode
// ser especifico da instancia de formulario daquela sessao) — se o envio
// falhar, esse e o primeiro suspeito.
const SCRIPT_CASE_INIT_OBSERVADO = "8362";

async function abrirFormularioSirene(
  cookie: string,
  idprotocolo: string
): Promise<{ csrfToken: string; scriptCaseInit: string } | null> {
  const res = await fetch(
    `${PORTAL}/unitrac_comandosirene_incluir/unitrac_comandosirene_incluir.php`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `PHPSESSID=${cookie}`,
      },
      body: new URLSearchParams({
        nmgp_opcao: "",
        script_case_init: SCRIPT_CASE_INIT_OBSERVADO,
        idprotocolo,
        nmgp_opc_ant: "",
        nmgp_bok: "Ok",
      }),
    }
  );
  if (res.status !== 200) return null;
  const html = await res.text();
  const csrfToken = extrairCampoHidden(html, "csrf_token");
  if (!csrfToken) return null;
  const scriptCaseInit = extrairCampoHidden(html, "script_case_init") ?? SCRIPT_CASE_INIT_OBSERVADO;
  return { csrfToken, scriptCaseInit };
}

// Liga a sirene do veiculo. "Desligar" ainda nao foi confirmado (mesmo
// endpoint, provavelmente outro valor em valorsirene) — nao implementado
// ainda pra nao adivinhar e mandar comando errado pra um veiculo real.
export async function enviarSirene(
  dados: DadosRastreador
): Promise<{ ok: boolean; erro?: string }> {
  const cookie = await lerSessaoGuardada();
  if (!cookie) return { ok: false, erro: "sem_sessao_guardada" };

  const aberto = await abrirFormularioSirene(cookie, dados.idprotocolo);
  if (!aberto) return { ok: false, erro: "nao_abriu_formulario" };

  const res = await fetch(
    `${PORTAL}/unitrac_comandosirene_incluir/unitrac_comandosirene_incluir.php`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `PHPSESSID=${cookie}`,
      },
      body: new URLSearchParams({
        nm_form_submit: "1",
        nmgp_idioma_novo: "",
        nmgp_schema_f: "",
        nmgp_url_saida: "",
        bok: "OK",
        nmgp_opcao: "",
        nmgp_ancora: "",
        nmgp_num_form: "",
        nmgp_parms: "nmgp_opcao?#?formphp?@?nm_call_php?#?enviar?@?",
        script_case_init: aberto.scriptCaseInit,
        NM_cancel_return_new: "",
        csrf_token: aberto.csrfToken,
        _sc_force_mobile: "",
        identificacao: dados.identificacao,
        seriemodulo: dados.seriemodulo,
        protocolo: dados.protocolo,
        comando: "1",
        saida2: "2",
        valorsirene: "2",
        idprotocolo: dados.idprotocolo,
      }),
    }
  );

  if (res.status !== 200) return { ok: false, erro: `http_${res.status}` };
  return { ok: true };
}

// ─── Ponto de entrada usado pela UI (MonitorV2.tsx) ────────────────────────
export async function enviarComandoVeiculo(
  cv: string,
  comando: "sirene" | "bloqueio"
): Promise<{ ok: boolean; erro?: string; portalUrl?: string }> {
  const portalUrl = `${PORTAL}/#veiculo/${cv}`;

  const pool = criarPool();
  let veiculo: {
    placa: string;
    unitrac_seriemodulo: string | null;
    unitrac_protocolo: string | null;
    unitrac_idprotocolo: string | null;
  } | null = null;
  try {
    const { rows } = await pool.query(
      `select placa, unitrac_seriemodulo, unitrac_protocolo, unitrac_idprotocolo
       from veiculos where cv = $1 limit 1`,
      [cv]
    );
    veiculo = rows[0] ?? null;
  } catch {
    return { ok: false, erro: "erro_ao_consultar_veiculo", portalUrl };
  } finally {
    await pool.end();
  }

  if (!veiculo) return { ok: false, erro: "veiculo_nao_encontrado", portalUrl };

  // Bloqueio de motor ainda nao foi confirmado via HAR real — nao adivinha,
  // cai no fallback do portal ate confirmar (ver memoria do projeto).
  if (comando === "bloqueio") {
    return { ok: false, erro: "bloqueio_ainda_nao_confirmado", portalUrl };
  }

  if (!veiculo.unitrac_seriemodulo || !veiculo.unitrac_protocolo || !veiculo.unitrac_idprotocolo) {
    return { ok: false, erro: "veiculo_sem_dados_rastreador_cadastrados", portalUrl };
  }

  const resultado = await enviarSirene({
    identificacao: veiculo.placa,
    seriemodulo: veiculo.unitrac_seriemodulo,
    protocolo: veiculo.unitrac_protocolo,
    idprotocolo: veiculo.unitrac_idprotocolo,
  });

  if (!resultado.ok) return { ok: false, erro: resultado.erro, portalUrl };
  return { ok: true };
}
