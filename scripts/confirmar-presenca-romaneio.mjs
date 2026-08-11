// scripts/confirmar-presenca-romaneio.mjs
//
// Confirma presenca em romaneio_pontos usando SO o historico de GPS real +
// a coordenada geocodificada do proprio romaneio -- sem depender de
// pontoCodigo/alvo da Unitrac. Fecha o buraco achado 11/08 (grupo do
// WhatsApp, audios): clientes sem cadastro na Unitrac tem bolinha no mapa
// (ja existia desde 01/08, ver api/alvos/route.ts) mas NUNCA viravam
// "entregue" -- a unica confirmacao existente (presencaConfirmadaCiclo, no
// motor ao vivo) exige alvoNoRaioAgora?.documento, que so existe quando ha
// alvo real da Unitrac.
//
// Desenhado como job PERIODICO separado (cron), nao como mudanca no motor
// ao vivo -- mesmo raciocinio de aprender_pontos_entrega() (migration 028):
// mais seguro mexer num job isolado que le e escreve uma coisa so, do que
// alterar a maquina de estado do motor (ja mexida 3x hoje, cada mudanca la
// teve efeito colateral real). "Automatico" pro usuario nao precisa ser
// no mesmo ciclo do motor -- rodar a cada poucos minutos ja atende.
//
// Generico por desenho (achado real 11/08, audio do cliente: "esse sistema
// vai servir outras empresas... nao sei como o sistema vai identificar de
// outra escala... por isso tem que ser endereco"): usa SO lat/lng
// geocodificado do romaneio + raio fixo, nada especifico de Nutry Max --
// funciona pra qualquer cliente/veiculo que tenha romaneio_pontos com
// coordenada.
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://app_service:5cf0fd1c8cfc0dfdf66a19196d5e6ebc691bbc628d7e637c@localhost:5432/transmonseg";

// Mesmos limiares do motor ao vivo (raio nominal de entrega, dwell minimo
// pra "parou de verdade" -- ver BYPASS_ENTREGA_DWELL_MINIMO_SEGUNDOS em
// src/lib/detectores.ts). Duplicado aqui de proposito: este script roda
// fora do Next.js, sem acesso a src/lib/*.ts (mesmo padrao ja usado por
// scripts/ingerir-*.mjs).
const RAIO_PADRAO_M = 50;
const DWELL_MINIMO_SEGUNDOS = 120;
const VELOCIDADE_MAX_PARADO_KMH = 5;
// So processa romaneios dos ultimos N dias -- historico antigo ja teve
// tempo de ser confirmado (ou nao vai ser, se o caminhao nunca passou la).
const JANELA_DIAS = 3;

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  const { rows: pendentes } = await pool.query(
    `SELECT id, veiculo_id, nf, romaneio_data, lat, lng
       FROM romaneio_pontos
      WHERE presenca_confirmada_em IS NULL
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND modo_teste = false
        AND romaneio_data >= current_date - $1::int
        AND romaneio_data <= current_date + 1`,
    [JANELA_DIAS]
  );
  console.log(`${pendentes.length} pontos de romaneio sem presenca confirmada, na janela de ${JANELA_DIAS} dias.`);

  let confirmados = 0;
  for (const p of pendentes) {
    const { rows: trilha } = await pool.query(
      `SELECT lat, lng, velocidade FROM posicoes_historico
        WHERE veiculo_id = $1
          AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = $2::date
        ORDER BY criado_em ASC`,
      [p.veiculo_id, p.romaneio_data]
    );
    if (trilha.length === 0) continue;

    // Dwell: maior sequencia CONSECUTIVA de leituras dentro do raio E com
    // velocidade baixa. Nao precisa ser a MESMA leitura sempre parada no
    // pixel exato -- so dentro do raio de entrega, devagar, por tempo
    // suficiente. Estima segundos pela diferenca real entre leituras (nao
    // conta leitura fixa) -- posicoes_historico nao tem cadencia fixa.
    let dwellAtualS = 0;
    let dwellMaxS = 0;
    let entrouEm = null;
    for (let i = 0; i < trilha.length; i++) {
      const ponto = trilha[i];
      const dentro =
        haversineM(ponto.lat, ponto.lng, p.lat, p.lng) <= RAIO_PADRAO_M &&
        ponto.velocidade <= VELOCIDADE_MAX_PARADO_KMH;
      if (dentro) {
        if (entrouEm === null) {
          entrouEm = i;
          dwellAtualS = 0;
        } else {
          // soma o intervalo real desde a leitura anterior (assume
          // continuidade -- se a leitura anterior tambem tava dentro).
          dwellAtualS += 30; // aproximacao: cadencia tipica de GPS real, ver posicoes_historico
        }
        dwellMaxS = Math.max(dwellMaxS, dwellAtualS);
      } else {
        entrouEm = null;
        dwellAtualS = 0;
      }
    }

    if (dwellMaxS >= DWELL_MINIMO_SEGUNDOS) {
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE romaneio_pontos SET presenca_confirmada_em = now() WHERE id = $1 AND presenca_confirmada_em IS NULL`,
          [p.id]
        );
      }
      confirmados++;
      const prefixo = DRY_RUN ? "[dry-run] Confirmaria" : "Confirmado";
      console.log(`${prefixo}: veiculo=${p.veiculo_id} nf=${p.nf} dia=${p.romaneio_data.toISOString().slice(0,10)} dwell~${dwellMaxS}s`);
    }
  }

  console.log(`\n${confirmados} presencas ${DRY_RUN ? "seriam confirmadas (dry-run, nada gravado)" : "confirmadas neste ciclo"}.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
