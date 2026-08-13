// Poll de falso_positivo em alertas tipo=desvio -- pra cada um novo, puxa o
// snapshot gravado em desvio_disparo_log (ver migration 045/047) e monta uma
// explicacao legivel de POR QUE disparou. Roda em loop, imprime só quando
// acha caso novo (nunca "sem novidade" -- pedido explicito do usuario).
import pg from "pg";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const desdeArg = process.argv[2];
const desde = desdeArg ? new Date(desdeArg) : new Date(Date.now() - 5 * 60000);

const { rows: alertas } = await c.query(
  `SELECT a.id, v.placa, a.veiculo_id, a.created_at, a.resolvido_em
     FROM alertas a JOIN veiculos v ON v.id = a.veiculo_id
    WHERE a.tipo = 'desvio' AND a.status = 'falso_positivo' AND a.resolvido_em > $1
    ORDER BY a.resolvido_em ASC`,
  [desde]
);

if (alertas.length === 0) {
  console.log("NENHUM_NOVO");
} else {
  for (const a of alertas) {
    const { rows: logs } = await c.query(
      `SELECT tipo_disparo, destinos, streak_afastando, streak_rua_rara, celula, n_visitas_celula, criado_em
         FROM desvio_disparo_log
        WHERE veiculo_id = $1 AND criado_em BETWEEN $2::timestamptz - interval '3 minutes' AND $2::timestamptz + interval '1 minute'
        ORDER BY criado_em DESC LIMIT 1`,
      [a.veiculo_id, a.created_at]
    );

    console.log(`\n=== ${a.placa} (falso_positivo, alerta ${a.id}) ===`);
    console.log(`Disparou: ${a.created_at.toISOString()}  Marcado falso positivo: ${a.resolvido_em.toISOString()}`);

    if (logs.length === 0) {
      console.log("SEM SNAPSHOT no desvio_disparo_log pra esse ciclo (fora da janela de +/-3min, ou disparo anterior ao deploy do log).");
      continue;
    }

    const l = logs[0];
    const destinos = l.destinos;
    if (l.tipo_disparo === "afastando_geral") {
      const ordenado = [...destinos].sort((x, y) => x.distAtualM - y.distAtualM);
      console.log(`Motivo registrado: AFASTANDO_GERAL (streak=${l.streak_afastando}) -- todos os ${destinos.length} destinos (pendentes+base+escala) divergiram por rota real (OSRM) por ${l.streak_afastando} leituras seguidas.`);
      console.log(`Destino mais proximo no momento: codigo=${ordenado[0].codigo ?? "(base/escala)"} dist_anterior=${ordenado[0].distAnteriorM}m -> dist_atual=${ordenado[0].distAtualM}m`);
      console.log(`Todos os destinos (ordenado por distancia atual):`);
      for (const d of ordenado.slice(0, 8)) {
        console.log(`  codigo=${d.codigo ?? "(base/escala)"} anterior=${d.distAnteriorM}m atual=${d.distAtualM}m delta=${(d.distAtualM - d.distAnteriorM).toFixed(0)}m`);
      }
    } else {
      console.log(`Motivo registrado: RUA_RARA_FROTA (streak=${l.streak_rua_rara}) -- celula ${l.celula} com ${l.n_visitas_celula} visita(s) no historico da frota, sem aproximar de nenhum pendente.`);
    }
  }
}

await c.end();
