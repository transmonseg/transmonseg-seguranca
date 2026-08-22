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

import pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { configPoolContabo } from "@/lib/supabase/contabo-ca";
import { haversineM, buscarAlvos, agruparPontosPorPlaca, type PontoEntrega } from "@/lib/unitrac";
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

function hojeSP(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function criaPgPool() {
  return new pg.Pool({ ...configPoolContabo(process.env.DATABASE_URL), max: 3 });
}

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
};

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

    // posicoes_atuais -- mesma fonte da Central, SOMENTE LEITURA.
    const { data: posAtuaisRows, error: erroPosAtuais } = await admin
      .from("posicoes_atuais")
      .select("veiculo_id, lat, lng, velocidade, atraso_min")
      .in("veiculo_id", veiculoIds);
    if (erroPosAtuais) {
      erros.push(`Erro ao ler posicoes_atuais: ${erroPosAtuais.message}`);
    }
    type PosAtual = { veiculo_id: string; lat: number | null; lng: number | null; velocidade: number | null; atraso_min: number | null };
    const posAtualPorVeiculo = new Map<string, PosAtual>(
      ((posAtuaisRows ?? []) as PosAtual[]).map((p) => [p.veiculo_id, p])
    );

    // Estado anterior -- tabela PRÓPRIA (romaneio_desvio_estado, migration 055),
    // nunca desvio_estado da Central.
    const { rows: estadoRows } = await pool.query<{ veiculo_id: string } & EstadoAnterior>(
      `SELECT veiculo_id, afastando_streak, rua_rara_streak, ultima_via_principal_em, saiu_parada_confirmada_em
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

    // Bases do cliente (centróide) -- só pro gate de carência de base
    // (LIMIAR_CARENCIA_BASE_M, mesmo limiar/constante da Central). Leitura
    // direta do centróide via PostGIS -- não precisa da malha completa do
    // polígono (basesCliente/pontoEmGeo/foraDaBase da Central), só distância.
    const centroideBasePorCliente = new Map<string, { lat: number; lng: number }[]>();
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

    // Alertas ATIVOS de alertas_romaneio (dedup por tipo/veículo -- brief
    // Step 3.9). 1 select batched pra frota deste ciclo, tabela PRÓPRIA.
    const { data: alertasAtivosRows } = await admin
      .from("alertas_romaneio")
      .select("veiculo_id, tipo")
      .in("veiculo_id", veiculoIds)
      .eq("status", "ativo");
    const alertaAtivoPorVeiculoTipo = new Set(
      ((alertasAtivosRows ?? []) as { veiculo_id: string; tipo: string }[]).map((a) => `${a.veiculo_id}:${a.tipo}`)
    );

    for (const veiculoId of veiculoIds) {
      veiculosProcessados++;
      try {
        const info = veiculoInfoPorId.get(veiculoId);
        if (!info) continue;

        // Step 1: posição atual e anterior -- mesma fonte da Central
        // (posicoes_atuais / posicoes_historico), SOMENTE LEITURA.
        const posAtual = posAtualPorVeiculo.get(veiculoId);
        if (!posAtual || posAtual.lat == null || posAtual.lng == null) continue;
        const fresco = posAtual.atraso_min != null && posAtual.atraso_min < LIMIAR_ATRASO_FRESCO_MIN;
        if (!fresco) continue;
        const latAtual = posAtual.lat;
        const lngAtual = posAtual.lng;

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

        // Step 4: distâncias reais aos destinos relevantes (mesmo filtro de
        // 50km da Central -- destino muito distante não reflete
        // comportamento local, ver LIMIAR_DESTINO_RELEVANTE_M em route.ts).
        const destinosRelevantes = pendentes.filter(
          (d) => haversineM(latAtual, lngAtual, d.lat, d.lng) <= LIMIAR_DESTINO_RELEVANTE_M
        );

        // Step 5: estado anterior (romaneio_desvio_estado).
        const estadoAnterior: EstadoAnterior = estadoPorVeiculo.get(veiculoId) ?? {
          afastando_streak: 0,
          rua_rara_streak: 0,
          ultima_via_principal_em: null,
          saiu_parada_confirmada_em: null,
        };

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
        const centroidesBase = centroideBasePorCliente.get(info.cliente_id) ?? [];
        const distBaseM = centroidesBase.length > 0
          ? Math.min(...centroidesBase.map((b) => haversineM(latAtual, lngAtual, b.lat, b.lng)))
          : null;
        const emCarenciaDeBase = distBaseM != null && distBaseM < LIMIAR_CARENCIA_BASE_M;

        // Classe viária atual -- classificação de dado (SELECT em lote acima),
        // não é regra de desvio. Calculada sempre que a posição é fresca,
        // igual à Central (independe dos gates acima).
        let classeViaAtual: ClasseViaria | null = null;
        for (const cel of vizinhanca3x3(latAtual, lngAtual)) {
          classeViaAtual = melhorClasse(classeViaAtual, classePorCelula.get(cel) ?? null);
        }
        const ultimaViaPrincipalAnteriorEm = estadoAnterior.ultima_via_principal_em;
        const ultimaViaPrincipalEmNova = classeViaAtual === "principal" ? agora : ultimaViaPrincipalAnteriorEm;
        // saiu_parada_confirmada_em: a Central deriva QUANDO marcar esta
        // transição (deveMarcarSaidaParadaConfirmada) a partir de colunas de
        // dwell/raio de posicoes_atuais (no_raio_dwell_segundos etc.) que
        // pertencem exclusivamente à Central e não estão no schema de
        // romaneio_desvio_estado (migration 055) -- não há como calcular essa
        // transição aqui sem reimplementar esse rastreio (fora do escopo desta
        // task). Carrega o valor anterior indefinidamente, nunca seta um novo
        // "agora": efeito é fail-open (a supressão "saiu de parada há pouco"
        // nunca entra em ação nesta rota -- mais alertas, nunca menos, ver
        // [[feedback_desvio_priorizar_recall]]); a corroboração de queda de
        // classe viária continua funcionando normalmente.
        const saiuParadaConfirmadaEmNova = estadoAnterior.saiu_parada_confirmada_em;

        let afastandoStreakNovo = estadoAnterior.afastando_streak;
        let ruaRaraStreakNovo = estadoAnterior.rua_rara_streak;
        let alerta: ReturnType<typeof montarAlertaDesvio> = null;

        if (!paradoSemSeMover && !movimentoInsignificante && !emCarenciaDeBase && destinosRelevantes.length > 0) {
          // Step 6: mesma sequência e mesmos argumentos que a Central usa.
          const distAtuaisReais = await buscarDistanciasReais({ lat: latAtual, lng: lngAtual }, destinosRelevantes);
          const distAnterioresReais =
            anterior && distAtuaisReais
              ? await buscarDistanciasReais({ lat: anterior.lat, lng: anterior.lng }, destinosRelevantes)
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

        // Step 9: se houve alerta, insere em alertas_romaneio (tabela
        // PRÓPRIA) com o mesmo dedup por tipo/veículo que a Central faz --
        // não cria duplicata se já existe um ativo do mesmo tipo pro mesmo veículo.
        if (alerta) {
          const chaveDedup = `${veiculoId}:${alerta.tipo}`;
          if (!alertaAtivoPorVeiculoTipo.has(chaveDedup)) {
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
              alertaAtivoPorVeiculoTipo.add(chaveDedup);
            }
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
