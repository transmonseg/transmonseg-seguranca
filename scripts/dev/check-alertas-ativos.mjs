import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// Ver detalhes dos alertas ativos: quando foram criados e estado do veículo
const { rows } = await c.query(`
  SELECT a.tipo, a.nivel, a.created_at, a.motivo,
         v.placa,
         p.atraso_min, p.ignicao, p.velocidade
  FROM alertas a
  JOIN veiculos v ON v.id = a.veiculo_id
  JOIN posicoes_atuais p ON p.veiculo_id = a.veiculo_id
  WHERE a.status = 'ativo'
  ORDER BY a.created_at ASC
`);

console.log("ALERTAS ATIVOS (mais antigos primeiro):");
for (const r of rows) {
  const idade = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000);
  const idadeStr = idade > 60 ? `${Math.round(idade/60)}h` : `${idade}min`;
  console.log(`  [${r.tipo.padEnd(20)}] ${r.placa.padEnd(8)} atraso=${r.atraso_min}min ign=${r.ignicao} vel=${r.velocidade} criado=${idadeStr} atrás`);
}

await c.end();
