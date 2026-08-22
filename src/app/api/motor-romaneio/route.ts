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

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { haversineM, buscarAlvos, agruparPontosPorPlaca, suspenderPorChegada, type PontoEntrega } from "@/lib/unitrac";
import { temCoordenadaValida, BONUS_CORROBORACAO_POR_SINAL } from "@/lib/detectores";
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
// Mesmo teto de correções via /match por ciclo que a Central usa
// (route.ts:99, constante local não exportada -- mesmo valor, orçamento de
// custo/latência, não regra de desvio).
const MAX_CORRECOES_MATCH_POR_CICLO = 40;

function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function criaPgPool() {
  return new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 3 });
}

type Ponto = { lat: number; lng: number };

type LinhaRomaneioPontoDb = {
  veiculo_id: string;
  placa: string;
  nf: string;
  cliente_nome: string;
  lat: number;
  lng: number;
  presenca_confirmada_em: string | null;
};

type VeiculoInfo = { id: string; placa: string; cv: string; cliente_id: string };

type EstadoAnterior = {
  afastando_streak: number;
  rua_rara_streak: number;
  ultima_via_principal_em: Date | null;
  saiu_parada_confirmada_em: Date | null;
  atualizado_em: Date | null;
};

type AlertaAtivoRow = { id: string; tipo: string; nivel: "critico" | "atencao" };

export async function POST(request: Request) {
  const chave = request.headers.get("x-motor-key");
  if (!chave || chave !== process.env.MOTOR_SECRET) {
    return Response.json({ erro: "nao autorizado" }, { status: 401 });
  }

  const admin = createAdminClient();
  const pool = criaPgPool();
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
    const { rows: linhasRomaneio } = await pool.query<LinhaRomaneioPontoDb>(
      `SELECT veiculo_id, placa, nf, cliente_nome, lat, lng, presenca_confirmada_em
         FROM romaneio_pontos
        WHERE romaneio_data = $1::date
          AND modo_teste = false
          AND geocode_status = 'ok'
          AND lat IS NOT NULL AND lng IS NOT NULL
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
        const alvos = await buscarAlvos(cvsUnicos);
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
      .select("veiculo_id, lat, lng, velocidade, atraso_min, datagps")
      .in("veiculo_id", veiculoIds);
    if (erroPosAtuais) {
      erros.push(`Erro ao ler posicoes_atuais: ${erroPosAtuais.message}`);
    }
    type PosAtual = {
      veiculo_id: string; lat: number | null; lng: number | null;
      velocidade: number | null; atraso_min: number | null; datagps: string | null;
    };
    const posAtualPorVeiculo = new Map<string, PosAtual>(
      ((posAtuaisRows ?? []) as PosAtual[]).map((p) => [p.veiculo_id, p])
    );

    // Estado anterior -- tabela PRÓPRIA (romaneio_desvio_estado, migration 055),
    // nunca desvio_estado da Central. atualizado_em entra pra idempotência (I3).
    const { rows: estadoRows } = await pool.query<{ veiculo_id: string } & EstadoAnterior>(
      `SELECT veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em, atualizado_em
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

    // Alertas ATIVOS de alertas_romaneio, tabela PRÓPRIA -- id/nivel entram
    // pra poder resolver/escalar (ver I2 do fix de 22/08), não só deduplicar.
    const { data: alertasAtivosRows } = await admin
      .from("alertas_romaneio")
      .select("id, veiculo_id, tipo, nivel")
      .in("veiculo_id", veiculoIds)
      .eq("status", "ativo");
    const alertasAtivosPorVeiculo = new Map<string, AlertaAtivoRow[]>();
    for (const a of (alertasAtivosRows ?? []) as (AlertaAtivoRow & { veiculo_id: string })[]) {
      const lista = alertasAtivosPorVeiculo.get(a.veiculo_id) ?? [];
      lista.push({ id: a.id, tipo: a.tipo, nivel: a.nivel });
      alertasAtivosPorVeiculo.set(a.veiculo_id, lista);
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

        const estadoAnterior: EstadoAnterior = estadoPorVeiculo.get(veiculoId) ?? {
          afastando_streak: 0,
          rua_rara_streak: 0,
          ultima_via_principal_em: null,
          saiu_parada_confirmada_em: null,
          atualizado_em: null,
        };

        // I3: idempotência por leitura de GPS -- sem isso, duas execuções
        // sobre a MESMA leitura (drift entre disparos do cron) incrementam o
        // streak duas vezes pelo mesmo movimento. atualizado_em é a última
        // vez que ESTA rota processou este veículo; se o datagps da leitura
        // atual já é <= esse instante, já avaliamos esta leitura antes --
        // pula o veículo inteiro (nada mudou, nada novo pra escrever).
        if (
          posAtual.datagps != null &&
          estadoAnterior.atualizado_em != null &&
          new Date(posAtual.datagps).getTime() <= estadoAnterior.atualizado_em.getTime()
        ) {
          continue;
        }

        veiculosProcessados++;

        // Posição anterior -- mesma fonte da Central (posicoes_historico), SOMENTE LEITURA.
        const { rows: anteriorRows } = await pool.query<{ lat: number; lng: number }>(
          `SELECT lat, lng FROM posicoes_historico
            WHERE veiculo_id = $1
            ORDER BY criado_em DESC LIMIT 1 OFFSET 1`,
          [veiculoId]
        );
        const anterior = anteriorRows[0] ?? null;

        // Step 2: monta os pontos (romaneio + status Unitrac) -- reusa
        // montarPontosDeRomaneio como está, regra de "feito" já embutida
        // ((alvo?.feito ?? false) || presencaConfirmadaEm !== null).
        const linhasVeiculo = romaneioPorVeiculo.get(veiculoId) ?? [];
        const pontosRomaneioGeocodificados: LinhaRomaneioGeocodificada[] = linhasVeiculo.map((l) => ({
          nf: l.nf,
          clienteNome: l.cliente_nome,
          lat: l.lat,
          lng: l.lng,
          presencaConfirmadaEm: l.presenca_confirmada_em,
        }));
        const pontosUnitracVeiculo = pontosUnitracPorPlaca.get(info.placa) ?? [];
        const pontos = montarPontosDeRomaneio(pontosRomaneioGeocodificados, pontosUnitracVeiculo);

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
        try {
          await pool.query(
            `INSERT INTO romaneio_desvio_estado (veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em, atualizado_em)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (veiculo_id) DO UPDATE SET
               afastando_streak = EXCLUDED.afastando_streak,
               rua_rara_streak = EXCLUDED.rua_rara_streak,
               ultima_via_principal_em = COALESCE(EXCLUDED.ultima_via_principal_em, romaneio_desvio_estado.ultima_via_principal_em),
               saiu_parada_confirmada_em = COALESCE(EXCLUDED.saiu_parada_confirmada_em, romaneio_desvio_estado.saiu_parada_confirmada_em),
               atualizado_em = now()`,
            [veiculoId, afastandoStreakNovo, ruaRaraStreakNovo, ultimaViaPrincipalEmNova, saiuParadaConfirmadaEmNova]
          );
        } catch (errEstado) {
          erros.push(`Aviso: falha ao gravar romaneio_desvio_estado pro veiculo ${veiculoId}: ${String(errEstado)}`);
        }

        // Step 9: gerencia alertas_romaneio, tabela PRÓPRIA -- MESMO padrão
        // de dedup + auto-resolve que a Central faz em `alertas`
        // (route.ts:3083-3212, I2 do fix de 22/08): sem o resolve, o
        // primeiro alerta de cada veículo fica ativo pra sempre e silencia
        // o veículo em todos os dias seguintes.
        const alertasAtivosVeiculo = alertasAtivosPorVeiculo.get(veiculoId) ?? [];
        if (alerta) {
          const alertaExistente = alertasAtivosVeiculo.find((a) => a.tipo === alerta!.tipo);
          const obsoletos = alertasAtivosVeiculo.filter((a) => a.tipo !== alerta!.tipo);
          if (obsoletos.length > 0) {
            const { error: erroResolveObsoletos } = await admin
              .from("alertas_romaneio")
              .update({ status: "resolvido", resolvido_em: agora.toISOString() })
              .in("id", obsoletos.map((a) => a.id));
            if (erroResolveObsoletos) {
              erros.push(`Aviso: falha ao resolver alertas_romaneio obsoletos do veiculo ${veiculoId}: ${erroResolveObsoletos.message}`);
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
        } else if (alertasAtivosVeiculo.length > 0) {
          // Sem alerta neste ciclo -- resolve todos os ativos deste veículo
          // (mesma lógica de route.ts:3206-3212).
          const { error: erroResolveTodos } = await admin
            .from("alertas_romaneio")
            .update({ status: "resolvido", resolvido_em: agora.toISOString() })
            .in("id", alertasAtivosVeiculo.map((a) => a.id));
          if (erroResolveTodos) {
            erros.push(`Aviso: falha ao resolver alertas_romaneio do veiculo ${veiculoId}: ${erroResolveTodos.message}`);
          }
        }
      } catch (errVeiculo) {
        erros.push(`Erro ao processar veiculo ${veiculoId}: ${String(errVeiculo)}`);
      }
    }

    return Response.json({ veiculosProcessados, alertasGerados, erros });
  } finally {
    await pool.end();
  }
}
