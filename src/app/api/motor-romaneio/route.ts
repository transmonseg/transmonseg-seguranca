// Motor de desvio de rota ALIMENTADO PELO ROMANEIO -- POST /api/motor-romaneio
//
// Por que existe: o motor principal (/api/motor) só enxerga como "destino"
// os alvos vindos da Unitrac. Em 21/08/2026, 14 veículos da Nutry Max
// tinham romaneio do dia mas ZERO alvo na Unitrac (10 deles são a "Escala
// do Pão", cujo romaneio é um documento separado que nunca entra na
// Unitrac) -- sem destino contra o qual medir "afastando de tudo", esses
// carros disparavam desvio o dia inteiro. Esta rota roda A MESMA detecção
// de desvio (mesmas funções puras, mesma sequência, mesmos limiares),
// alimentada pelos pontos do romaneio em vez dos alvos da Unitrac.
//
// REGRA DE OURO (repetida pelo usuário no planejamento): "é tudo igual, só
// muda a fonte dos pontos". Este arquivo IMPORTA as funções de regra da
// Central (@/lib/desvio, @/lib/corredor-confirmacao,
// @/lib/classe-viaria-confirmacao) e as chama na MESMA ordem/com os mesmos
// argumentos -- nunca reimplementa nem ajusta uma regra de desvio. Escreve
// SOMENTE nas tabelas próprias criadas pela Task 1 (romaneio_desvio_estado,
// alertas_romaneio -- ver scripts/migrations/contabo/055_motor_romaneio.sql)
// -- nunca em alertas/desvio_estado/posicoes_atuais/desvio_disparo_log
// (tabelas da Central), só LEITURA nessas. Ver
// docs/superpowers/specs/2026-07-31-central-romaneio-paralela-design.md
// (decisão original de isolar o romaneio da Central) e
// .superpowers/sdd/2026-08-22-motor-romaneio-paralelo/ (task-2-brief.md).
//
// Revisão de 22/08 (task-2-report.md, "fix" section): base e pontos de
// escala ENTRAM na lista de destinos do Sinal A (não são "fonte de ponto de
// entrega" que esta task troca -- são a mesma composição da Central,
// route.ts:1682-1690), o streak zera quando o ciclo é bloqueado (não
// sobrevive indefinidamente), o gate de chegada (suspenderPorChegada) e a
// correção de posição via OSRM /match foram adicionados, os alertas se
// auto-resolvem quando o sinal para, e há uma checagem de idempotência por
// leitura de GPS.
//
// Fix de produção 22/08 (mesmo dia, achado ao vivo): a checagem de
// idempotência comparava datagps (relógio da Unitrac, deslocado ~3h pro
// passado por um bug de fuso em parseDatagps da Central, ver comentário no
// gate abaixo) contra atualizado_em (relógio real do Postgres) -- nunca
// passava depois do primeiro ciclo, o motor parava de vez. Corrigido pra
// comparar datagps-contra-datagps (nova coluna ultimo_datagps, migration
// 056) -- mesmo offset dos dois lados, deixa de importar.

// Revisão final de 22/08 (task-6, findings da revisão ampla que olhou as
// interações entre as partes). O que mudou aqui, tudo copiando a solução que
// a Central já tinha pro mesmo problema: (1) o motor NUNCA fecha alerta de
// desvio -- TIPOS_NAO_GERENCIADOS, com contexto.auto_resolvido no que sobrar
// de auto-resolve; (2) lease de execução única em linha própria de
// motor_lease (id=2), porque os 2 crons por minuto se sobrepõem; (3) timeout
// de 20s na Unitrac; (4) datagps implausível não vira marco de idempotência;
// (5) silenciamento de 2h depois de "falso positivo"; (6) dedup lê
// ativo+reconhecido; (7) streak não atravessa o dia; (8) a posição anterior
// é escolhida por corte de tempo, não por OFFSET. Migration 058 acompanha
// (linha do lease + expiração/retenção de alertas_romaneio).

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { haversineM, agruparPontosPorPlaca, suspenderPorChegada, type AlvoUnitrac, type PontoEntrega } from "@/lib/unitrac";
import {
  temCoordenadaValida,
  BONUS_CORROBORACAO_POR_SINAL,
  TIPOS_NAO_GERENCIADOS,
  contaComoEventoDeSilenciamento,
} from "@/lib/detectores";
import { montarPontosDeRomaneio, type LinhaRomaneioGeocodificada } from "@/lib/romaneio";
import { buscarDistanciasReais } from "@/lib/distancia-real";
import { avaliarAfastandoDeTudo, avaliarRuaRara, montarAlertaDesvio, LIMIAR_CARENCIA_BASE_M } from "@/lib/desvio";
import { verificarCorredorFora, aplicarCorroboracaoCorredor } from "@/lib/corredor-confirmacao";
import {
  melhorClasse,
  avaliarQuedaClasseViaria,
  avaliarSaiuParadaConfirmadaRecentemente,
  aplicarCorroboracaoClasseViaria,
  type ClasseViaria,
} from "@/lib/classe-viaria-confirmacao";
import { celulaDe, vizinhanca3x3 } from "@/lib/celulas";
import { dataSP, datagpsPlausivelComoMarco, estadoEhDeOutroDiaSP } from "@/lib/motor-romaneio-estado";
import { corrigirPosicoesComMatch, type ResultadoMatch } from "@/lib/osrm-match";

// Função serverless -- pode levar tempo com OSRM/Unitrac, mesmo teto que a Central.
export const maxDuration = 60;

// Mesmos limiares da Central (route.ts) -- não são "regra de desvio", são
// filtros de qualidade de dado sobre a MESMA função pura (ver comentário de
// cada um em desvio.ts / route.ts).
const LIMIAR_DESTINO_RELEVANTE_M = 50_000;
const LIMIAR_MOVIMENTO_MINIMO_M = 50;
// Mesmo limiar de "fresco" usado por normalizar() em lib/unitrac.ts (atraso
// em minutos desde a última leitura de GPS aceita como válida).
const LIMIAR_ATRASO_FRESCO_MIN = 60;
// Mesmo piso de confiança do /match que a Central usa (route.ts:2551).
const LIMIAR_CONFIANCA_MATCH = 0.5;
// Mesmo timeout de Unitrac da Central (motor/route.ts:72). As falhas de rede
// da Unitrac na Nutry Max são recorrentes o dia todo (comentário da Central
// em 266-273).
const TIMEOUT_UNITRAC_MS = 20_000;
// Mesmo teto de correções via /match por ciclo que a Central usa
// (route.ts:99, constante local não exportada -- mesmo valor, orçamento de
// custo/latência, não regra de desvio).
const MAX_CORRECOES_MATCH_POR_CICLO = 40;

// Trava de execução única deste ciclo -- MESMO mecanismo da Central
// (motor/route.ts:497-528): lease com expiração por UPDATE atômico em
// motor_lease. Motivo medido na Central (comentário dela em 247-264): sem
// trava, dois ciclos sobrepostos leem o mesmo snapshot de alertas abertos,
// ambos inserem, e o UPSERT de estado vira last-write-wins -- até 34
// alertas de desvio por dia pro mesmo veículo. Esta rota tem exatamente a
// mesma exposição: os 2 jobs de pg_cron (057) disparam no mesmo minuto (um
// na hora exata, outro com pg_sleep(30)), então basta um ciclo passar de
// 30s pra eles se sobreporem.
//
// NUNCA trocar por pg_try_advisory_lock: na Central o advisory lock ficava
// preso por tempo indeterminado (64-88% dos ciclos pulados, achado de
// 10-11/07).
//
// LINHA PRÓPRIA (id = 2, criada pela migration 058). A id = 1 é da Central
// -- usar a mesma linha faria um motor bloquear o outro, e os dois PRECISAM
// rodar ao mesmo tempo pros mesmos carros (o produto da entrega é comparar
// os dois pipelines no mesmo dia).
const MOTOR_ROMANEIO_LEASE_ID = 2;
// 90s > maxDuration=60s: mesmo raciocínio (e mesmo número) da Central. O
// lease tem que sobreviver ao ciclo mais longo possível -- se expirasse
// antes, um ciclo ainda vivo perderia a trava e o disparo seguinte entraria
// em paralelo com ele, que é exatamente o que a trava existe pra impedir. E
// como é lease (não lock), um ciclo que morra no meio libera sozinho em 90s.
const LEASE_EXPIRACAO_SQL = "90 seconds";

// Data de HOJE em São Paulo. NUNCA trocar por current_date do Postgres: o
// servidor roda em CEST (UTC+2) e o Brasil é UTC-3 -- o dia do banco vira 5h
// antes do dia brasileiro. Implementação compartilhada com
// estadoEhDeOutroDiaSP (@/lib/motor-romaneio-estado) pra que "o dia" seja
// literalmente a mesma conta nos dois lugares.
function hojeSP(): string {
  return dataSP(new Date());
}

function criaPgPool() {
  return new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 3 });
}

// buscarAlvos COM timeout -- cópia local do padrão da Central
// (motor/route.ts:308-336, buscarAlvosComTimeout). A Central nunca usa a
// função crua no motor, e por um motivo concreto: buscarAlvos de
// @/lib/unitrac faz fetch SEM signal, então uma Unitrac que aceita a conexão
// e não responde deixa o fetch pendurado até o headersTimeout default do
// undici (~300s). Nesses 5 minutos o ciclo não termina, o
// `finally { pool.end() }` não roda, e o cron dispara ~10 ciclos novos --
// cada um também pendurado, cada um segurando seu pool. (Com o lease do
// commit anterior os ciclos novos agora só pulam, mas o ciclo travado
// continua segurando pool e lease até o undici desistir -- o timeout é o
// que fecha esse buraco de verdade.)
//
// DELIBERADAMENTE local, não um fix em @/lib/unitrac: mudar buscarAlvos lá
// afetaria TODOS os chamadores, inclusive a Central em produção -- mudança
// de comportamento da Central, proibida nesta entrega. Mesmo argumento que a
// Central usou pra reescrever o fetch inline em vez de mexer no módulo.
async function buscarAlvosComTimeout(cvs: string[]): Promise<AlvoUnitrac[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_UNITRAC_MS);
  try {
    const res = await fetch("https://datalayer.portalunitrac.com/mapa_servicos/alvos", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(cvs),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`buscarAlvos HTTP ${res.status}`);
    const data = (await res.json()) as { alvos?: AlvoUnitrac[] };
    return data.alvos ?? [];
  } finally {
    clearTimeout(timer);
  }
}

type Ponto = { lat: number; lng: number };

type LinhaRomaneioPontoDb = {
  veiculo_id: string;
  placa: string;
  nf: string;
  cliente_nome: string;
  // Nulos quando o geocode desta linha falhou -- fallback pra coordenada da
  // Unitrac fica por conta de montarPontosDeRomaneio (@/lib/romaneio).
  lat: number | null;
  lng: number | null;
  presenca_confirmada_em: string | null;
};

type VeiculoInfo = { id: string; placa: string; cv: string; cliente_id: string };

type EstadoAnterior = {
  afastando_streak: number;
  rua_rara_streak: number;
  ultima_via_principal_em: Date | null;
  saiu_parada_confirmada_em: Date | null;
  atualizado_em: Date | null;
  ultimo_datagps: Date | null;
};

type AlertaAtivoRow = {
  id: string;
  tipo: string;
  nivel: "critico" | "atencao";
  // Lido pra poder PRESERVAR o contexto existente ao marcar auto_resolvido
  // (ver resolverPelaMaquina) -- sobrescrever com {"auto_resolvido":true}
  // apagaria origem_desvio, que é o insumo da comparação entre os dois
  // pipelines.
  contexto: Record<string, unknown> | null;
};

// Fecha alertas_romaneio POR AÇÃO DA MÁQUINA, marcando contexto.auto_resolvido.
// Mesma semântica do marcador que a Central usa (contexto.auto_expirado no cron
// 'expirar-alertas-ativos-esquecidos', 002_retencao.sql; contexto.auto_resolvido
// lido por contaComoEventoDeSilenciamento/contaComoRotuloHumano em
// src/lib/detectores.ts:580-625): sem ele, uma contagem futura não distingue
// "a máquina fechou" de "o operador clicou Resolver" -- e comparar os dois
// pipelines por essa contagem é justamente o produto desta entrega.
//
// Update por linha (e não um único .in("id", ...)): o merge do contexto é
// por linha, e o PostgREST não faz `contexto || '{...}'::jsonb` num update em
// lote. Custo irrelevante -- hoje esta função nunca recebe nada (ver
// TIPOS_NAO_GERENCIADOS no Step 9).
async function resolverPelaMaquina(
  admin: ReturnType<typeof createAdminClient>,
  alertas: AlertaAtivoRow[],
  agoraIso: string
): Promise<string | null> {
  for (const a of alertas) {
    const { error } = await admin
      .from("alertas_romaneio")
      .update({
        status: "resolvido",
        resolvido_em: agoraIso,
        contexto: { ...(a.contexto ?? {}), auto_resolvido: true },
      })
      .eq("id", a.id);
    if (error) return error.message;
  }
  return null;
}

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }

  const admin = createAdminClient();
  const pool = criaPgPool();

  // Lease (ver MOTOR_ROMANEIO_LEASE_ID acima). Adquirido ANTES de qualquer
  // leitura: o ciclo inteiro é uma sequência ler-decidir-escrever, e ler
  // fora da trava já basta pra duas execuções verem o mesmo "zero alertas
  // ativos" e inserirem duas vezes.
  let leaseToken: string | null = null;
  {
    const lockClient = await pool.connect();
    try {
      const { rows: leaseRows } = await lockClient.query<{ token: string }>(
        `update motor_lease
            set expira_em = now() + interval '${LEASE_EXPIRACAO_SQL}',
                token = gen_random_uuid(),
                adquirido_em = now()
          where id = $1 and expira_em < now()
        returning token`,
        [MOTOR_ROMANEIO_LEASE_ID]
      );
      leaseToken = leaseRows[0]?.token ?? null;
    } finally {
      lockClient.release();
    }
  }
  if (!leaseToken) {
    // Duas causas produzem EXATAMENTE o mesmo UPDATE de 0 linhas: (a) o
    // ciclo anterior ainda está rodando -- normal, esperado; (b) a linha
    // id=2 não existe porque a migration 058 nunca foi aplicada -- e aí o
    // motor fica inerte PRA SEMPRE, 100% dos ciclos pulados. Sem distinguir
    // as duas, (b) se disfarça de (a): HTTP 200, 'succeeded' no
    // cron.job_run_details, nada em erros[], e um motivo que manda o
    // investigador procurar um ciclo travado que não existe -- string
    // indistinguível, ainda por cima, do `pulado` legítimo da Central que
    // fica na mesma net._http_response. Uma query a mais, só neste caminho.
    let leaseExiste = true;
    try {
      const { rows } = await pool.query(`select 1 from motor_lease where id = $1`, [
        MOTOR_ROMANEIO_LEASE_ID,
      ]);
      leaseExiste = rows.length > 0;
    } catch {
      // Falha de leitura não é prova de ausência -- mantém o diagnóstico
      // conservador (assume que a linha existe e o ciclo está só ocupado).
    }
    // Fecha o pool antes de sair, igual à Central (route.ts:522-528) -- sem
    // isso cada ciclo pulado deixaria um pool de até 3 conexões pendurado.
    await pool.end();
    if (!leaseExiste) {
      const msg =
        `CRITICO: a linha ${MOTOR_ROMANEIO_LEASE_ID} de motor_lease nao existe -- ` +
        `a migration 058 (058_motor_romaneio_lease_e_retencao.sql) nao foi aplicada neste banco. ` +
        `O motor-romaneio NAO esta rodando: todo ciclo e pulado por falta da linha de lease, nao por ciclo em andamento.`;
      console.error(msg);
      return Response.json({ pulado: true, motivo: msg });
    }
    return Response.json({
      pulado: true,
      motivo: "ciclo anterior do motor-romaneio ainda em execucao",
    });
  }

  const agora = new Date();
  const erros: string[] = [];
  let veiculosProcessados = 0;
  let alertasGerados = 0;
  // Orçamento de correção via /match compartilhado pelo ciclo inteiro --
  // mesmo padrão de contadorCorrecoesMatch em route.ts:548.
  const contadorCorrecoesMatch = { valor: 0 };

  try {
    const hoje = hojeSP();

    // Só veículos com romaneio utilizável de hoje (ver task-2-brief.md, Step 3).
    // NÃO filtra por geocode_status/lat/lng aqui (removido na task-5, ver
    // task-5-brief.md): uma NF cujo geocode falhou ainda entra na lista --
    // montarPontosDeRomaneio (@/lib/romaneio) resolve a coordenada dela via
    // fallback pelo alvo da Unitrac que casa por NF, ou descarta a linha se
    // nem isso existir. Filtrar geocode_status aqui faria a NF sumir ANTES
    // desse fallback rodar, reabrindo o buraco que esta task fecha.
    const { rows: linhasRomaneio } = await pool.query<LinhaRomaneioPontoDb>(
      `SELECT veiculo_id, placa, nf, cliente_nome, lat, lng, presenca_confirmada_em
         FROM romaneio_pontos
        WHERE romaneio_data = $1::date
          AND modo_teste = false
          AND veiculo_id IS NOT NULL`,
      [hoje]
    );

    if (linhasRomaneio.length === 0) {
      return Response.json({ veiculosProcessados: 0, alertasGerados: 0, erros });
    }

    const romaneioPorVeiculo = new Map<string, LinhaRomaneioPontoDb[]>();
    for (const l of linhasRomaneio) {
      const lista = romaneioPorVeiculo.get(l.veiculo_id) ?? [];
      lista.push(l);
      romaneioPorVeiculo.set(l.veiculo_id, lista);
    }
    const veiculoIds = [...romaneioPorVeiculo.keys()];

    const { data: veiculosData, error: erroVeiculos } = await admin
      .from("veiculos")
      .select("id, placa, cv, cliente_id")
      .in("id", veiculoIds);
    if (erroVeiculos) {
      return Response.json({ erro: `falha ao ler veiculos: ${erroVeiculos.message}` }, { status: 500 });
    }
    const veiculoInfoPorId = new Map<string, VeiculoInfo>(
      ((veiculosData ?? []) as VeiculoInfo[]).map((v) => [v.id, v])
    );

    // Status feito/pendente por NF continua vindo da Unitrac (ver brief Step 2) --
    // o romaneio só dá a lista/coordenada. Falha aqui não impede o ciclo: sem
    // status Unitrac, montarPontosDeRomaneio trata tudo como pendente (fail-open
    // pró-recall, nunca esconde um desvio real).
    const cvsUnicos = [...new Set(
      [...veiculoInfoPorId.values()].map((v) => v.cv).filter((cv): cv is string => !!cv)
    )];
    let pontosUnitracPorPlaca = new Map<string, PontoEntrega[]>();
    if (cvsUnicos.length > 0) {
      try {
        // Com timeout de 20s (ver buscarAlvosComTimeout acima). O catch
        // abaixo continua fail-open pró-recall: sem alvos, o ciclo segue só
        // com o romaneio, tratando tudo como pendente.
        const alvos = await buscarAlvosComTimeout(cvsUnicos);
        pontosUnitracPorPlaca = agruparPontosPorPlaca(alvos);
      } catch (errUnitrac) {
        erros.push(`Aviso: falha ao buscar alvos Unitrac (segue so com romaneio, tudo pendente): ${String(errUnitrac)}`);
      }
    }

    // posicoes_atuais -- mesma fonte da Central, SOMENTE LEITURA. datagps
    // entra pra idempotência (ver I3 do fix de 22/08): sem isso não dá pra
    // saber se esta leitura já foi avaliada num ciclo anterior.
    const { data: posAtuaisRows, error: erroPosAtuais } = await admin
      .from("posicoes_atuais")
      .select("veiculo_id, lat, lng, velocidade, atraso_min, datagps, updated_at")
      .in("veiculo_id", veiculoIds);
    if (erroPosAtuais) {
      erros.push(`Erro ao ler posicoes_atuais: ${erroPosAtuais.message}`);
    }
    type PosAtual = {
      veiculo_id: string; lat: number | null; lng: number | null;
      velocidade: number | null; atraso_min: number | null; datagps: string | null;
      // Quando a Central gravou ESTA leitura (relógio do Postgres). Usado só
      // pra achar a posição ANTERIOR sem ambiguidade -- ver a query de
      // `anterior` no loop.
      updated_at: string | null;
    };
    const posAtualPorVeiculo = new Map<string, PosAtual>(
      ((posAtuaisRows ?? []) as PosAtual[]).map((p) => [p.veiculo_id, p])
    );

    // Estado anterior -- tabela PRÓPRIA (romaneio_desvio_estado, migration 055
    // + 056). ultimo_datagps entra pra idempotência (I3, revisado 22/08 --
    // ver comentário no gate mais abaixo pro motivo de NÃO usar atualizado_em).
    const { rows: estadoRows } = await pool.query<{ veiculo_id: string } & EstadoAnterior>(
      `SELECT veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em, atualizado_em, ultimo_datagps
         FROM romaneio_desvio_estado
        WHERE veiculo_id = ANY($1::uuid[])`,
      [veiculoIds]
    );
    const estadoPorVeiculo = new Map(estadoRows.map((r) => [r.veiculo_id, r]));

    // Frequência de célula por cliente (Sinal B, rua rara) -- tabela da
    // Central (celula_frequencia_cliente), SOMENTE LEITURA: já é alimentada
    // pelo motor principal a cada ciclo pra TODA a frota (inclusive estes
    // veículos, que continuam sendo processados por /api/motor pros outros
    // detectores) -- esta rota não precisa (nem deve) escrever nela de novo.
    const clienteIdsUnicos = [...new Set([...veiculoInfoPorId.values()].map((v) => v.cliente_id))];
    const freqCelulaPorCliente = new Map<string, Map<string, number>>();
    if (clienteIdsUnicos.length > 0) {
      try {
        const { rows } = await pool.query<{ cliente_id: string; celula: string; n_visitas: number }>(
          `SELECT cliente_id, celula, n_visitas FROM celula_frequencia_cliente WHERE cliente_id = ANY($1::uuid[])`,
          [clienteIdsUnicos]
        );
        for (const r of rows) {
          const mapa = freqCelulaPorCliente.get(r.cliente_id) ?? new Map<string, number>();
          mapa.set(r.celula, r.n_visitas);
          freqCelulaPorCliente.set(r.cliente_id, mapa);
        }
      } catch (errFreq) {
        erros.push(`Aviso: falha ao ler celula_frequencia_cliente: ${String(errFreq)}`);
      }
    }

    // Classificação viária por célula (corroboração) -- tabela da Central
    // (vias_celulas), SOMENTE LEITURA. Batched pela vizinhança 3x3 de toda
    // posição válida deste ciclo, mesmo padrão da Central.
    let classePorCelula = new Map<string, ClasseViaria>();
    try {
      const celulasCandidatas = new Set<string>();
      for (const p of posAtualPorVeiculo.values()) {
        if (p.lat != null && p.lng != null) {
          for (const c of vizinhanca3x3(p.lat, p.lng)) celulasCandidatas.add(c);
        }
      }
      if (celulasCandidatas.size > 0) {
        const { rows } = await pool.query<{ celula: string; classe: ClasseViaria }>(
          `SELECT celula, classe FROM vias_celulas WHERE celula = ANY($1::text[])`,
          [[...celulasCandidatas]]
        );
        classePorCelula = new Map(rows.map((r) => [r.celula, r.classe]));
      }
    } catch (errClasse) {
      erros.push(`Aviso: falha ao classificar via em lote: ${String(errClasse)}`);
    }

    // Bases do cliente (centróide) -- entram tanto no gate de carência de
    // base (LIMIAR_CARENCIA_BASE_M) quanto na lista de destinos do Sinal A
    // (ver C2 do fix de 22/08 -- mesma composição de route.ts:1682-1690:
    // pendentes + bases + escala). Leitura direta do centróide via PostGIS
    // -- não precisa da malha completa do polígono (basesCliente/pontoEmGeo/
    // foraDaBase da Central), só distância/ponto.
    const centroideBasePorCliente = new Map<string, Ponto[]>();
    if (clienteIdsUnicos.length > 0) {
      try {
        const { rows } = await pool.query<{ cliente_id: string; lat: number; lng: number }>(
          `SELECT cliente_id, ST_Y(ST_Centroid(geom::geometry)) AS lat, ST_X(ST_Centroid(geom::geometry)) AS lng
             FROM bases WHERE cliente_id = ANY($1::uuid[])`,
          [clienteIdsUnicos]
        );
        for (const r of rows) {
          const lista = centroideBasePorCliente.get(r.cliente_id) ?? [];
          lista.push({ lat: r.lat, lng: r.lng });
          centroideBasePorCliente.set(r.cliente_id, lista);
        }
      } catch (errBases) {
        erros.push(`Aviso: falha ao ler bases: ${String(errBases)}`);
      }
    }

    // Pontos de escala de hoje (route.ts:1683-1691 inclui escala na lista de
    // destinos do Sinal A -- não é ponto de entrega, é a mesma composição da
    // Central, ver C2 do fix de 22/08).
    const escalaPorPlaca = new Map<string, Ponto[]>();
    try {
      const { rows } = await pool.query<{ placa: string; lat: number; lng: number }>(
        `SELECT placa, lat, lng FROM escala_pontos
          WHERE escala_data = $1::date AND veiculo_id = ANY($2::uuid[])
            AND lat IS NOT NULL AND lng IS NOT NULL`,
        [hoje, veiculoIds]
      );
      for (const r of rows) {
        const lista = escalaPorPlaca.get(r.placa) ?? [];
        lista.push({ lat: r.lat, lng: r.lng });
        escalaPorPlaca.set(r.placa, lista);
      }
    } catch (errEscala) {
      erros.push(`Aviso: falha ao ler escala_pontos: ${String(errEscala)}`);
    }

    // Alertas EM ABERTO de alertas_romaneio, tabela PRÓPRIA -- id/nivel entram
    // pra poder resolver/escalar (ver I2 do fix de 22/08), não só deduplicar.
    const { data: alertasAbertosRows } = await admin
      .from("alertas_romaneio")
      .select("id, veiculo_id, tipo, nivel, contexto")
      .in("veiculo_id", veiculoIds)
      .in("status", ["ativo", "reconhecido"]);
    const alertasAbertosPorVeiculo = new Map<string, AlertaAtivoRow[]>();
    for (const a of (alertasAbertosRows ?? []) as (AlertaAtivoRow & { veiculo_id: string })[]) {
      const lista = alertasAbertosPorVeiculo.get(a.veiculo_id) ?? [];
      lista.push({ id: a.id, tipo: a.tipo, nivel: a.nivel, contexto: a.contexto });
      alertasAbertosPorVeiculo.set(a.veiculo_id, lista);
    }

    // Tipos SILENCIADOS por 2h depois de um "falso positivo" marcado pelo
    // operador -- mesmo mecanismo da Central (motor/route.ts:1452-1466 e
    // 3086-3088). Sem isso: o operador marca falso, o status sai de 'ativo',
    // 30s depois alertaExistente é undefined e o motor insere o MESMO alerta
    // de novo, e repete a cada ciclo enquanto o streak ≥ 2 -- é o padrão que
    // a Central precisou combater no caso TUG-9D18 (17 alertas em 2h pro
    // mesmo episódio).
    //
    // contaComoEventoDeSilenciamento (@/lib/detectores) filtra o que NÃO é
    // decisão humana: um fechamento da máquina reusa o mesmo status e
    // silenciaria o tipo sem ninguém ter julgado nada (ver o marcador
    // contexto.auto_resolvido no Step 9).
    //
    // SEM filtro de modo_teste aqui: alertas_romaneio não tem essa coluna
    // (migration 055) -- ao contrário de `alertas`, onde a Central filtra.
    // Copiar o predicado da Central sem conferir estouraria em runtime, e
    // nem tsc nem eslint pegam coluna inexistente em query.
    const desde2h = new Date(agora.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const tiposSilenciadosPorVeiculo = new Map<string, Set<string>>();
    {
      const { data: falsosRecentes, error: erroFalsos } = await admin
        .from("alertas_romaneio")
        .select("tipo, veiculo_id, contexto")
        .in("veiculo_id", veiculoIds)
        .eq("status", "falso_positivo")
        .gte("resolvido_em", desde2h);
      if (erroFalsos) {
        erros.push(`Aviso: falha ao ler falsos positivos recentes de alertas_romaneio: ${erroFalsos.message}`);
      }
      for (const fp of (falsosRecentes ?? []) as { tipo: string; veiculo_id: string; contexto: unknown }[]) {
        if (!contaComoEventoDeSilenciamento(fp.contexto)) continue;
        const set = tiposSilenciadosPorVeiculo.get(fp.veiculo_id) ?? new Set<string>();
        set.add(fp.tipo);
        tiposSilenciadosPorVeiculo.set(fp.veiculo_id, set);
      }
    }

    for (const veiculoId of veiculoIds) {
      try {
        const info = veiculoInfoPorId.get(veiculoId);
        if (!info) continue;

        // Step 1: posição atual -- mesma fonte da Central (posicoes_atuais), SOMENTE LEITURA.
        const posAtual = posAtualPorVeiculo.get(veiculoId);
        if (!posAtual || posAtual.lat == null || posAtual.lng == null) continue;
        const latAtual = posAtual.lat;
        const lngAtual = posAtual.lng;
        const fresco = posAtual.atraso_min != null && posAtual.atraso_min < LIMIAR_ATRASO_FRESCO_MIN;

        const estadoGravado: EstadoAnterior = estadoPorVeiculo.get(veiculoId) ?? {
          afastando_streak: 0,
          rua_rara_streak: 0,
          ultima_via_principal_em: null,
          saiu_parada_confirmada_em: null,
          atualizado_em: null,
          ultimo_datagps: null,
        };

        // Estado que atravessou o dia -- streak NÃO sobrevive à virada.
        // Esta rota retorna cedo quando não há romaneio do dia (fim de
        // semana, feriado), então ninguém escreve e ninguém zera: um veículo
        // que terminou a sexta com afastando_streak=1 voltaria na segunda
        // com 1, e a PRIMEIRA leitura divergente já dispararia, com metade
        // da evidência. A Central não tem mecanismo equivalente pra copiar
        // (conferido: nada toca desvio_estado fora do motor) porque ela não
        // precisa -- roda pra frota inteira em todo ciclo, 24/7, e qualquer
        // ciclo bloqueado já zera o streak dela naturalmente.
        //
        // Só o streak. ultima_via_principal_em / saiu_parada_confirmada_em
        // ficam: quem as consome já compara contra `agora` com janela de
        // 10min/5min (avaliarQuedaClasseViaria e
        // avaliarSaiuParadaConfirmadaRecentemente,
        // @/lib/classe-viaria-confirmacao), então um valor de dias atrás já
        // responde false sozinho -- zerá-las aqui não mudaria resultado
        // nenhum e só apagaria histórico.
        const estadoDeOutroDia = estadoEhDeOutroDiaSP(estadoGravado.atualizado_em, hoje);
        const estadoAnterior: EstadoAnterior = estadoDeOutroDia
          ? { ...estadoGravado, afastando_streak: 0, rua_rara_streak: 0 }
          : estadoGravado;

        // I3 (revisado 22/08 -- achado real em produção, ver task-2-report.md):
        // idempotência por leitura de GPS, mas comparando datagps-CONTRA-
        // datagps, NUNCA datagps contra now()/atualizado_em. Motivo concreto:
        // parseDatagps (src/app/api/motor/route.ts:226-237) grava o horário
        // de Brasília que a Unitrac devolve com sufixo "Z" (UTC) -- isso
        // desloca TODO datagps ~3h pro passado, sistematicamente (não é
        // atraso real; a Unitrac responde ao vivo em segundos). Pra Central
        // isso é inofensivo (ela usa atraso_min, nunca compara datagps com
        // now()); comparando esse datagps deslocado contra now()/
        // atualizado_em (relógio real do Postgres) essa checagem NUNCA
        // passava depois do primeiro ciclo -- o motor pulava TODO veículo pra
        // sempre (produção, 22/08). Guardando o ÚLTIMO datagps já processado
        // (ultimo_datagps, migration 056) e comparando datagps-contra-datagps,
        // o mesmo offset aparece dos dois lados e deixa de importar. NÃO
        // "simplificar" isso de volta pra comparar com now()/atualizado_em --
        // é exatamente o bug que já aconteceu uma vez. NÃO corrigir
        // parseDatagps em vez disso: é função da Central, em produção, mudar
        // o fuso do dado gravado lá é risco desnecessário pro que precisamos
        // aqui. Pula só quando ultimo_datagps é conhecido E a leitura atual
        // não é mais nova que ele; processa quando é mais nova ou quando
        // ultimo_datagps ainda é null (nunca processado, ou posAtual.datagps
        // ausente -- fail-open, nunca bloqueia por falta de dado).
        if (
          posAtual.datagps != null &&
          estadoAnterior.ultimo_datagps != null &&
          new Date(posAtual.datagps).getTime() <= estadoAnterior.ultimo_datagps.getTime()
        ) {
          continue;
        }

        veiculosProcessados++;

        // Posição anterior -- mesma fonte da Central (posicoes_historico),
        // SOMENTE LEITURA.
        //
        // O corte é `criado_em < posicoes_atuais.updated_at`, NÃO
        // `OFFSET 1` (como era até 22/08). Motivo: a Central grava
        // posicoes_atuais no meio do ciclo (route.ts:3222, updated_at =
        // `agora` do ciclo dela) e só depois insere a MESMA leitura em
        // posicoes_historico (route.ts:3327, criado_em = now() do momento do
        // insert). Ou seja, a linha de histórico da leitura ATUAL sempre tem
        // criado_em > updated_at, e a da leitura anterior sempre tem
        // criado_em < updated_at. Com OFFSET 1 a janela medida dependia de o
        // ciclo do romaneio ter caído antes ou depois desse insert: às vezes
        // 30s (correto), às vezes 60s (dois ciclos), variando de leitura pra
        // leitura -- e o Sinal A mede exatamente delta de distância nessa
        // janela.
        //
        // Isto alinha a janela com a que a Central usa: ela compara a
        // leitura nova contra o snapshot ANTERIOR de posicoes_atuais
        // (route.ts:1488, mapaPosAtual lido no início do ciclo), que é
        // precisamente a leitura que este SELECT devolve. Sem mecanismo
        // novo, sem coluna nova, só com dado que já existe.
        //
        // Fallback pro OFFSET 1 se updated_at vier ausente (coluna é NOT
        // NULL no schema; defensivo contra falha de leitura, não contra
        // dado real).
        const corteAnterior = posAtual.updated_at;
        const { rows: anteriorRows } = corteAnterior
          ? await pool.query<{ lat: number; lng: number }>(
              `SELECT lat, lng FROM posicoes_historico
                WHERE veiculo_id = $1 AND criado_em < $2
                ORDER BY criado_em DESC LIMIT 1`,
              [veiculoId, corteAnterior]
            )
          : await pool.query<{ lat: number; lng: number }>(
              `SELECT lat, lng FROM posicoes_historico
                WHERE veiculo_id = $1
                ORDER BY criado_em DESC LIMIT 1 OFFSET 1`,
              [veiculoId]
            );
        const anterior = anteriorRows[0] ?? null;

        // Step 2: monta os pontos (romaneio + status Unitrac) -- reusa
        // montarPontosDeRomaneio como está, regra de "feito" já embutida
        // ((alvo?.feito ?? false) || presencaConfirmadaEm !== null). Nome
        // sem "Geocodificadas" (task-5): desde que a query parou de filtrar
        // geocode_status, algumas destas linhas não têm coordenada própria
        // — a Unitrac pode preencher via fallback dentro da função, ou a
        // linha ser descartada lá dentro.
        const linhasVeiculo = romaneioPorVeiculo.get(veiculoId) ?? [];
        const pontosRomaneioDoVeiculo: LinhaRomaneioGeocodificada[] = linhasVeiculo.map((l) => ({
          nf: l.nf,
          clienteNome: l.cliente_nome,
          lat: l.lat,
          lng: l.lng,
          presencaConfirmadaEm: l.presenca_confirmada_em,
        }));
        const pontosUnitracVeiculo = pontosUnitracPorPlaca.get(info.placa) ?? [];
        const pontos = montarPontosDeRomaneio(pontosRomaneioDoVeiculo, pontosUnitracVeiculo);

        // Step 3: mesma regra de pendentes da Central pro Sinal A
        // (pontosVeiculoParaDesvio em route.ts): !pt.feito && temCoordenadaValida(pt).
        const pendentes = pontos.filter((pt) => !pt.feito && temCoordenadaValida(pt));

        // I1: gate de chegada (suspenderPorChegada, pura, @/lib/unitrac) --
        // suspende a avaliação quando o veículo já está dentro do raio do
        // pendente mais próximo (manobra/chegada, não desvio). Sem infra de
        // "ponto seguro" (postos de gasolina) nesta rota -- mesmo argumento
        // `false` que a Central usa em chegouEmDestinoConhecido (route.ts:1830).
        let idxMaisProximoPendente = -1;
        let distMaisProximoPendenteM = Infinity;
        pendentes.forEach((pt, i) => {
          const d = haversineM(latAtual, lngAtual, pt.lat, pt.lng);
          if (d < distMaisProximoPendenteM) {
            distMaisProximoPendenteM = d;
            idxMaisProximoPendente = i;
          }
        });
        const suspensoPorChegada =
          idxMaisProximoPendente >= 0
            ? suspenderPorChegada(distMaisProximoPendenteM, pendentes[idxMaisProximoPendente].raio, false)
            : false;

        // Step 4: destinos do Sinal A -- pendentes + bases + escala, MESMA
        // composição da Central (route.ts:1682-1690). Base/escala não são
        // "fonte de ponto de entrega" que esta task troca -- entram sempre,
        // senão um caminhão voltando pra base com pendente aberto (situação
        // permanente na Escala do Pão) se afasta de "tudo" e dispara.
        const centroidesBase = centroideBasePorCliente.get(info.cliente_id) ?? [];
        const escalaDoVeiculo = escalaPorPlaca.get(info.placa) ?? [];
        const destinosBase: Ponto[] = [
          ...pendentes.map((pt) => ({ lat: pt.lat, lng: pt.lng })),
          ...centroidesBase,
          ...escalaDoVeiculo,
        ];
        const destinosRelevantes = destinosBase.filter(
          (d) => haversineM(latAtual, lngAtual, d.lat, d.lng) <= LIMIAR_DESTINO_RELEVANTE_M
        );

        // Gates que suspendem a avaliação -- mesmos da Central (brief Step 1):
        // ruído de GPS/OSRM parado ou quase parado nunca deve alimentar streak.
        const mesmoPonto =
          anterior != null &&
          Math.round(anterior.lat * 10000) === Math.round(latAtual * 10000) &&
          Math.round(anterior.lng * 10000) === Math.round(lngAtual * 10000);
        const paradoSemSeMover = mesmoPonto;

        const movimentoRealM = anterior ? haversineM(anterior.lat, anterior.lng, latAtual, lngAtual) : null;
        const movimentoInsignificante = movimentoRealM != null && movimentoRealM < LIMIAR_MOVIMENTO_MINIMO_M;

        // Carência de base (LIMIAR_CARENCIA_BASE_M, importado de @/lib/desvio,
        // mesmo valor da Central) -- manobra de saída/permanência no pátio não
        // deve contar como "afastando de tudo".
        const distBaseM = centroidesBase.length > 0
          ? Math.min(...centroidesBase.map((b) => haversineM(latAtual, lngAtual, b.lat, b.lng)))
          : null;
        const emCarenciaDeBase = distBaseM != null && distBaseM < LIMIAR_CARENCIA_BASE_M;

        // Classe viária atual -- classificação de dado (SELECT em lote acima),
        // não é regra de desvio. Calculada só quando a posição é fresca,
        // igual à Central (route.ts:2217).
        let classeViaAtual: ClasseViaria | null = null;
        if (fresco) {
          for (const cel of vizinhanca3x3(latAtual, lngAtual)) {
            classeViaAtual = melhorClasse(classeViaAtual, classePorCelula.get(cel) ?? null);
          }
        }
        const ultimaViaPrincipalAnteriorEm = estadoAnterior.ultima_via_principal_em;
        const ultimaViaPrincipalEmNova = fresco && classeViaAtual === "principal" ? agora : ultimaViaPrincipalAnteriorEm;
        // saiu_parada_confirmada_em: a Central deriva QUANDO marcar esta
        // transição (deveMarcarSaidaParadaConfirmada) a partir de colunas de
        // dwell/raio de posicoes_atuais (no_raio_dwell_segundos etc.) que
        // pertencem exclusivamente à Central e não estão no schema de
        // romaneio_desvio_estado (migration 055) -- não há como calcular essa
        // transição aqui sem reimplementar esse rastreio (fora do escopo desta
        // task, decisão revisada e mantida no fix de 22/08). Carrega o valor
        // anterior indefinidamente, nunca seta um novo "agora": efeito é
        // fail-open (a supressão "saiu de parada há pouco" nunca entra em
        // ação nesta rota -- mais alertas, nunca menos, ver
        // [[feedback_desvio_priorizar_recall]]); a corroboração de queda de
        // classe viária continua funcionando normalmente.
        const saiuParadaConfirmadaEmNova = estadoAnterior.saiu_parada_confirmada_em;

        // C1: streak SEMPRE começa zerado -- mesmo default da Central
        // (route.ts:2418-2419). Só é restaurado ao valor anterior no branch
        // específico de falha do OSRM /table logo abaixo (route.ts:2821-2824)
        // -- qualquer outro motivo de bloqueio (não fresco, chegada, carência
        // de base, parado, movimento insignificante, sem destino relevante)
        // zera o streak, nunca deixa ele sobreviver ao ciclo bloqueado.
        let afastandoStreakNovo = 0;
        let ruaRaraStreakNovo = 0;
        let alerta: ReturnType<typeof montarAlertaDesvio> = null;

        if (fresco && !suspensoPorChegada && !emCarenciaDeBase && !paradoSemSeMover && !movimentoInsignificante && destinosRelevantes.length > 0) {
          // M3: correção de posição via OSRM /match (route.ts:2551-2624) --
          // só entra em ação quando já existe streak (afastandoStreak > 0) e
          // existe pra matar o ruído de snap-to-road do achado de 13/08.
          let posParaAvaliar: Ponto = { lat: latAtual, lng: lngAtual };
          let anteriorParaAvaliar: Ponto | null = anterior ? { lat: anterior.lat, lng: anterior.lng } : null;
          if (estadoAnterior.afastando_streak > 0 && anteriorParaAvaliar !== null && contadorCorrecoesMatch.valor < MAX_CORRECOES_MATCH_POR_CICLO) {
            try {
              const { rows: janelaRecente } = await pool.query<{ lat: number; lng: number; criado_em: Date }>(
                `SELECT lat, lng, criado_em FROM posicoes_historico
                  WHERE veiculo_id = $1 AND criado_em > now() - interval '5 minutes'
                  ORDER BY criado_em ASC`,
                [veiculoId]
              );
              const pontosMatch = janelaRecente.map((p) => ({ lat: p.lat, lng: p.lng, timestamp: p.criado_em }));
              pontosMatch.push({ lat: latAtual, lng: lngAtual, timestamp: agora });
              const corrigido: ResultadoMatch | null = await corrigirPosicoesComMatch(pontosMatch);
              if (corrigido && corrigido.confidence >= LIMIAR_CONFIANCA_MATCH) {
                posParaAvaliar = corrigido.atual;
                anteriorParaAvaliar = corrigido.anterior;
                contadorCorrecoesMatch.valor += 1;
              }
            } catch (errMatch) {
              erros.push(`Aviso: falha ao corrigir posicao via /match pro veiculo ${veiculoId}: ${String(errMatch)}`);
            }
          }

          // Step 6: mesma sequência e mesmos argumentos que a Central usa.
          const distAtuaisReais = await buscarDistanciasReais(posParaAvaliar, destinosRelevantes);
          const distAnterioresReais =
            anteriorParaAvaliar && distAtuaisReais
              ? await buscarDistanciasReais(anteriorParaAvaliar, destinosRelevantes)
              : null;

          if (distAtuaisReais && distAnterioresReais) {
            const afastando = avaliarAfastandoDeTudo(distAtuaisReais, distAnterioresReais, estadoAnterior.afastando_streak);
            afastandoStreakNovo = afastando.streak;

            const celulaAtual = celulaDe(latAtual, lngAtual);
            const nVisitasHistorico = freqCelulaPorCliente.get(info.cliente_id)?.get(celulaAtual) ?? 0;
            const ruaRara = avaliarRuaRara(nVisitasHistorico, afastando.aproximandoAlgum, estadoAnterior.rua_rara_streak);
            ruaRaraStreakNovo = ruaRara.streak;

            // Sinal B (rua rara) desligado -- MESMA decisão/mesmos argumentos
            // da Central (13/08): só o Sinal A dispara alerta, mas o streak
            // continua sendo calculado/gravado pra não perder a série
            // histórica caso volte a ser religado.
            alerta = montarAlertaDesvio(afastando, { ...ruaRara, disparou: false, celula: celulaAtual, nVisitas: nVisitasHistorico });

            // Step 7: corroborações, mesma ordem da Central -- corredor, depois classe viária.
            if (alerta) {
              try {
                const segundosStreak = Math.min(afastandoStreakNovo, 20) * 30;
                const { rows: ancoraRows } = await pool.query<{ lat: number; lng: number }>(
                  `SELECT lat, lng FROM posicoes_historico
                    WHERE veiculo_id = $1 AND criado_em <= now() - ($2 || ' seconds')::interval
                    ORDER BY criado_em DESC LIMIT 1`,
                  [veiculoId, String(segundosStreak)]
                );
                const ancora = ancoraRows[0];
                if (ancora) {
                  const { confirmaFora } = await verificarCorredorFora(
                    { lat: ancora.lat, lng: ancora.lng },
                    { lat: latAtual, lng: lngAtual, velocidade: posAtual.velocidade ?? 0 },
                    destinosRelevantes
                  );
                  if (confirmaFora) {
                    alerta = aplicarCorroboracaoCorredor(alerta, confirmaFora, BONUS_CORROBORACAO_POR_SINAL);
                  }
                }
              } catch (errCorredor) {
                erros.push(`Aviso: falha ao verificar corredor pro veiculo ${veiculoId}: ${String(errCorredor)}`);
              }

              try {
                const { quedaDetectada } = avaliarQuedaClasseViaria(classeViaAtual, ultimaViaPrincipalAnteriorEm, agora);
                const saiuParadaRecente = avaliarSaiuParadaConfirmadaRecentemente(saiuParadaConfirmadaEmNova, agora);
                alerta = aplicarCorroboracaoClasseViaria(alerta, quedaDetectada, saiuParadaRecente, BONUS_CORROBORACAO_POR_SINAL);
              } catch (errClasseViaria) {
                erros.push(`Aviso: falha ao avaliar classe viaria pro veiculo ${veiculoId}: ${String(errClasseViaria)}`);
              }
            }
          } else {
            // C1: falha pontual do OSRM /table (transiente) -- preserva o
            // streak anterior em vez de zerar, mesmo comportamento de
            // route.ts:2821-2824 (só este branch específico preserva; todo
            // resto do gate acima zera).
            afastandoStreakNovo = estadoAnterior.afastando_streak;
            ruaRaraStreakNovo = estadoAnterior.rua_rara_streak;
          }
        }

        // Step 8: grava estado (UPSERT por veiculo_id), tabela PRÓPRIA.
        // ultimo_datagps grava o datagps DESTA leitura -- vira o marco de
        // idempotência do próximo ciclo (ver comentário no gate acima).
        // COALESCE evita regredir pra null quando posAtual.datagps veio
        // ausente neste ciclo (mesmo padrão das outras colunas que só
        // avançam quando o dado novo é conhecido).
        //
        // datagpsPlausivelComoMarco (@/lib/motor-romaneio-estado, com teste
        // unitário e o raciocínio numérico completo): a Central grava
        // `parseDatagps(pos.datagps) ?? agora.toISOString()`
        // (motor/route.ts:2982), então um payload da Unitrac sem datagps
        // envenena posicoes_atuais.datagps com o UTC REAL, ~3h à frente de
        // todos os outros valores da coluna. Guardar esse valor como marco
        // travaria este veículo por ~3h (`datagps <= ultimo_datagps` a cada
        // 30s), silenciosamente. O veículo é processado normalmente; só a
        // leitura implausível não vira marco -- o marco antigo fica, e o
        // COALESCE abaixo o preserva.
        const datagpsMarco = datagpsPlausivelComoMarco(posAtual.datagps, agora) ? posAtual.datagps : null;
        try {
          await pool.query(
            `INSERT INTO romaneio_desvio_estado (veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em, ultimo_datagps, atualizado_em)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (veiculo_id) DO UPDATE SET
               afastando_streak = EXCLUDED.afastando_streak,
               rua_rara_streak = EXCLUDED.rua_rara_streak,
               ultima_via_principal_em = COALESCE(EXCLUDED.ultima_via_principal_em, romaneio_desvio_estado.ultima_via_principal_em),
               saiu_parada_confirmada_em = COALESCE(EXCLUDED.saiu_parada_confirmada_em, romaneio_desvio_estado.saiu_parada_confirmada_em),
               ultimo_datagps = COALESCE(EXCLUDED.ultimo_datagps, romaneio_desvio_estado.ultimo_datagps),
               atualizado_em = now()`,
            [veiculoId, afastandoStreakNovo, ruaRaraStreakNovo, ultimaViaPrincipalEmNova, saiuParadaConfirmadaEmNova, datagpsMarco]
          );
        } catch (errEstado) {
          erros.push(`Aviso: falha ao gravar romaneio_desvio_estado pro veiculo ${veiculoId}: ${String(errEstado)}`);
        }

        // Step 9: gerencia alertas_romaneio, tabela PRÓPRIA -- MESMO padrão
        // de dedup + auto-resolve que a Central faz em `alertas`
        // (route.ts:3079-3212).
        const alertasAbertosVeiculo = alertasAbertosPorVeiculo.get(veiculoId) ?? [];

        // 🔴 O MOTOR NUNCA FECHA DESVIO. Mesmo filtro da Central
        // (route.ts:3079-3081, TIPOS_NAO_GERENCIADOS importado de
        // @/lib/detectores -- a MESMA lista, nunca uma cópia paralela):
        // favela, desvio, bypass_entrega e parada_sem_marcacao só saem de
        // 'ativo' por ação MANUAL do operador. É pedido explícito do
        // usuário depois do incidente de 11/07 (churn da cerca virtual:
        // alerta sumia e voltava com id/desde novos a cada ciclo, e
        // 210+ desvios reais foram fechados sozinhos em 5 dias).
        //
        // Sem este filtro o pipeline novo repetia o 11/07 inteiro: como
        // montarAlertaDesvio só produz tipo "desvio", 100% do conteúdo de
        // alertas_romaneio era auto-fechável a cada ciclo, e QUALQUER gate
        // do ciclo servia de gatilho (!fresco, suspensoPorChegada,
        // emCarenciaDeBase, movimentoInsignificante, destinosRelevantes
        // vazio, OSRM devolvendo null). Já aconteceu em produção: o único
        // alerta que a entrega gerou (TTK-8A87, crítico, score 90) foi
        // fechado pela máquina às 01:51:36 do dia 23/08 -- operador_id e
        // origem_acao nulos, ou seja, não foi humano.
        //
        // CONSEQUÊNCIA DE HOJE, pra quem for "limpar código morto": como
        // "desvio" é o ÚNICO tipo que esta tabela recebe, alertasGerenciados
        // é SEMPRE vazio, e portanto os dois caminhos de resolve abaixo
        // nunca executam. Isso é o comportamento CORRETO, não sobra. Os
        // caminhos ficam porque um segundo tipo de alerta nesta tabela
        // (parada_fora_tapete, por exemplo, que na Central é deliberadamente
        // gerenciado) precisa deles no dia em que entrar. Quem fecha o que
        // ninguém trata é o cron de 7 dias
        // ('expirar-alertas-romaneio-ativos-esquecidos', migration 058),
        // igual à Central.
        const alertasGerenciados = alertasAbertosVeiculo.filter(
          (a) => !TIPOS_NAO_GERENCIADOS.has(a.tipo)
        );

        if (alerta) {
          const alertaExistente = alertasAbertosVeiculo.find((a) => a.tipo === alerta!.tipo);
          // Silenciamento de 2h (ver tiposSilenciadosPorVeiculo acima) --
          // mesma estrutura da Central (route.ts:3086-3088): quando o tipo
          // está silenciado NADA acontece pro veículo neste ciclo, nem
          // insert nem resolve de obsoletos (a Central não resolve
          // silenciado de propósito, pra preservar o contexto enquanto o
          // operador investiga).
          const silenciado = tiposSilenciadosPorVeiculo.get(veiculoId)?.has(alerta.tipo) ?? false;

          if (!silenciado) {
            const obsoletos = alertasGerenciados.filter((a) => a.tipo !== alerta!.tipo);
            if (obsoletos.length > 0) {
              const erroResolveObsoletos = await resolverPelaMaquina(admin, obsoletos, agora.toISOString());
              if (erroResolveObsoletos) {
                erros.push(`Aviso: falha ao resolver alertas_romaneio obsoletos do veiculo ${veiculoId}: ${erroResolveObsoletos}`);
              }
            }

            if (!alertaExistente) {
              const { error: erroInsert } = await admin.from("alertas_romaneio").insert({
                cliente_id: info.cliente_id,
                veiculo_id: veiculoId,
                nivel: alerta.nivel,
                tipo: alerta.tipo,
                motivo: alerta.motivo,
                score: alerta.score,
                status: "ativo",
                lat: latAtual,
                lng: lngAtual,
                contexto: { origem_desvio: alerta.origemDesvio },
                desde: agora.toISOString(),
              });
              if (erroInsert) {
                erros.push(`Aviso: falha ao inserir alertas_romaneio pro veiculo ${veiculoId}: ${erroInsert.message}`);
              } else {
                alertasGerados++;
              }
            } else if (alertaExistente.nivel !== "critico" && alerta.nivel === "critico") {
              const { error: erroEscalar } = await admin
                .from("alertas_romaneio")
                .update({ nivel: alerta.nivel, motivo: alerta.motivo, score: alerta.score })
                .eq("id", alertaExistente.id);
              if (erroEscalar) {
                erros.push(`Aviso: falha ao escalar alertas_romaneio do veiculo ${veiculoId}: ${erroEscalar.message}`);
              }
            }
          }
        } else if (alertasGerenciados.length > 0) {
          // Sem alerta neste ciclo -- resolve os GERENCIADOS em aberto deste
          // veículo (mesma lógica de route.ts:3206-3212). Hoje: nunca entra
          // aqui, porque desvio nunca é gerenciado -- ver o bloco de
          // TIPOS_NAO_GERENCIADOS acima antes de considerar isto morto.
          const erroResolveTodos = await resolverPelaMaquina(admin, alertasGerenciados, agora.toISOString());
          if (erroResolveTodos) {
            erros.push(`Aviso: falha ao resolver alertas_romaneio do veiculo ${veiculoId}: ${erroResolveTodos}`);
          }
        }
      } catch (errVeiculo) {
        erros.push(`Erro ao processar veiculo ${veiculoId}: ${String(errVeiculo)}`);
      }
    }

    return Response.json({ veiculosProcessados, alertasGerados, erros });
  } finally {
    // Libera o lease SÓ se ainda formos o dono (token confere) -- mesmo
    // cuidado da Central (route.ts:4019-4033): um ciclo que passou de 90s e
    // já perdeu o lease nunca pode derrubar o lease do sucessor.
    try {
      const pgLease = await pool.connect();
      try {
        await pgLease.query(
          `update motor_lease set expira_em = now() where id = $1 and token = $2`,
          [MOTOR_ROMANEIO_LEASE_ID, leaseToken]
        );
      } finally {
        pgLease.release();
      }
    } catch { /* lease expira sozinho em 90s */ }
    await pool.end();
  }
}
