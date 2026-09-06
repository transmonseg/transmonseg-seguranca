// Auditoria sistematica das ancoras write-once (romaneio_cliente_codigo_
// geocode) -- achado real 06/09: a limpeza manual de hoje (66 linhas da
// Zona Oeste) so' cobriu os bairros que ja' tinham aparecido num incidente
// concreto ("carga transferida" cruzando placas). Duas ancoras FORA dessa
// lista (ESTRADA SANTA MARIA/Campo Grande, AVENIDA DAS AMERICAS/Barra da
// Tijuca) tambem estavam erradas, congeladas desde 19/08 e 25/08 -- achadas
// so' por amostragem manual. Essa ferramenta generaliza o metodo: pra cada
// ancora, extrai a RUA e o MUNICIPIO do endereco_chave (mesmas funcoes que
// a cascata de geocodificacao usa) e mede a distancia da coordenada
// guardada ate' o candidato CNEFE mais proximo daquele nome de rua NAQUELE
// municipio -- se a rua existe no CNEFE mas a ancora esta' longe de
// QUALQUER ponto dela, a ancora provavelmente e' de um trecho errado
// (mesmo diagnostico manual feito hoje, so' que pra todo o banco).
//
// Sem rede nenhuma (Nominatim/Google) -- so' Postgres local, roda rapido
// mesmo pras ~11 mil linhas da tabela inteira.
//
// Uso (relatorio, nao mexe em nada):
//   npx tsx --env-file=.env.production scripts/auditar-ancoras-cliente-codigo.ts [--limite-km 20] > relatorio.csv
//
// Uso (aplica -- APAGA as ancoras suspeitas, forcando reprocessamento no
// proximo ciclo do cron; NAO mexe em romaneio_pontos, que se auto-corrige
// sozinho quando a ancora some e a NF for reprocessada):
//   npx tsx --env-file=.env.production scripts/auditar-ancoras-cliente-codigo.ts --aplicar [--limite-km 20]
import { createAdminClient } from "../src/lib/supabase/admin";
import { extrairRuaDoEndereco, extrairCidadeDoEndereco, expandirCidadeTruncada, municipioCodigoIbge, normalizarNomeRua } from "../src/lib/romaneio-geocode-local";

type Ancora = {
  cliente_id: string;
  cliente_codigo: string;
  endereco_chave: string;
  lat: number;
  lng: number;
  primeira_observacao: string;
};

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes("--aplicar");
  const idxLimite = args.indexOf("--limite-km");
  // 20km: acima de qualquer extensao razoavel de uma UNICA rua (mesmo em
  // municipio grande, ver MUNICIPIOS_GRANDES em romaneio-geocode.ts, que
  // usa 70km pro ponto de CIDADE inteiro -- aqui e' contra o candidato mais
  // PROXIMO da rua especifica, bem mais estreito que isso).
  const limiteKm = idxLimite >= 0 ? Number(args[idxLimite + 1]) : 20;

  const admin = createAdminClient();

  console.error("Buscando ancoras...");
  const { data: ancorasBrutas, error: erroAncoras } = await admin
    .from("romaneio_cliente_codigo_geocode")
    .select("cliente_id, cliente_codigo, endereco_chave, lat, lng, primeira_observacao");
  if (erroAncoras || !ancorasBrutas) {
    console.error("Erro ao buscar ancoras:", erroAncoras?.message);
    process.exit(1);
  }
  const ancoras = ancorasBrutas as Ancora[];
  console.error(`${ancoras.length} ancoras.`);

  // Extrai rua normalizada + municipio de cada ancora (so' as que tem
  // cidade reconhecida -- sem cidade nao da' pra validar contra CNEFE).
  type ComExtracao = Ancora & { ruaNormalizada: string; municipioCodigo: string };
  const comExtracao: ComExtracao[] = [];
  for (const a of ancoras) {
    const rua = extrairRuaDoEndereco(a.endereco_chave);
    const ruaNormalizada = normalizarNomeRua(rua);
    const cidadeBruta = extrairCidadeDoEndereco(a.endereco_chave);
    if (!cidadeBruta || !ruaNormalizada) continue;
    const cidade = expandirCidadeTruncada(cidadeBruta);
    const municipioCodigo = municipioCodigoIbge(cidade);
    if (!municipioCodigo) continue;
    comExtracao.push({ ...a, ruaNormalizada, municipioCodigo });
  }
  console.error(`${comExtracao.length} com rua+municipio reconhecidos (o resto fica de fora, sem como validar).`);

  // Agrupa por (rua, municipio) pra so' consultar o CNEFE uma vez por
  // combinacao unica, nao uma vez por ancora.
  const porChave = new Map<string, ComExtracao[]>();
  for (const a of comExtracao) {
    const chave = `${a.ruaNormalizada}::${a.municipioCodigo}`;
    const lista = porChave.get(chave) ?? [];
    lista.push(a);
    porChave.set(chave, lista);
  }
  console.error(`${porChave.size} combinacoes unicas de rua+municipio.`);

  type Suspeita = ComExtracao & { distKm: number; cnefeLat: number; cnefeLng: number; qtdCnefe: number };
  const suspeitas: Suspeita[] = [];
  let semCnefe = 0;
  let processadas = 0;

  for (const [, lista] of porChave) {
    processadas++;
    if (processadas % 500 === 0) console.error(`  ${processadas}/${porChave.size} combinacoes...`);
    const { ruaNormalizada, municipioCodigo } = lista[0];
    // Pega ate' 300 pontos CNEFE dessa rua no municipio -- suficiente pra
    // achar o mais proximo de cada ancora sem trazer o CNEFE inteiro.
    const { data: pontos } = await admin
      .from("cnefe_enderecos")
      .select("lat, lng")
      .eq("nome_normalizado", ruaNormalizada)
      .eq("municipio_codigo", municipioCodigo)
      .limit(300);
    if (!pontos || pontos.length === 0) {
      semCnefe += lista.length;
      continue;
    }
    for (const a of lista) {
      let melhorDist = Infinity;
      let melhorLat = 0;
      let melhorLng = 0;
      for (const p of pontos as { lat: number; lng: number }[]) {
        const d = haversineKm(a.lat, a.lng, p.lat, p.lng);
        if (d < melhorDist) { melhorDist = d; melhorLat = p.lat; melhorLng = p.lng; }
      }
      if (melhorDist > limiteKm) {
        suspeitas.push({ ...a, distKm: melhorDist, cnefeLat: melhorLat, cnefeLng: melhorLng, qtdCnefe: pontos.length });
      }
    }
  }

  console.error(`\n${semCnefe} ancoras cuja rua nao existe no CNEFE daquele municipio (nao da' pra validar, ficam de fora).`);
  console.error(`${suspeitas.length} ancoras SUSPEITAS (rua existe no CNEFE, mas a ancora esta' a mais de ${limiteKm}km de qualquer ponto dela).\n`);

  suspeitas.sort((a, b) => b.distKm - a.distKm);
  console.log("cliente_codigo,dist_km,lat,lng,cnefe_lat,cnefe_lng,qtd_cnefe,primeira_observacao,endereco_chave");
  for (const s of suspeitas) {
    const chaveEscapada = `"${s.endereco_chave.replace(/"/g, '""')}"`;
    console.log(`${s.cliente_codigo},${s.distKm.toFixed(1)},${s.lat},${s.lng},${s.cnefeLat},${s.cnefeLng},${s.qtdCnefe},${s.primeira_observacao},${chaveEscapada}`);
  }

  if (aplicar) {
    console.error(`\nApagando ${suspeitas.length} ancoras suspeitas...`);
    let apagadas = 0;
    for (const s of suspeitas) {
      const { error } = await admin
        .from("romaneio_cliente_codigo_geocode")
        .delete()
        .eq("cliente_id", s.cliente_id)
        .eq("cliente_codigo", s.cliente_codigo)
        .eq("endereco_chave", s.endereco_chave);
      if (error) console.error(`Erro ao apagar ${s.cliente_codigo}/${s.endereco_chave}:`, error.message);
      else apagadas++;
    }
    console.error(`${apagadas} apagadas. Proximo ciclo do cron reprocessa essas NFs do zero.`);
  } else {
    console.error("\nModo relatorio (nao apagou nada). Rode com --aplicar pra apagar as suspeitas.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
