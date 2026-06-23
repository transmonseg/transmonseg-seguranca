// Sonda os endpoints de monitoramento do Unitrac para planejar o "mapa igual o Unitrac".
// Roda: node scripts/dev/sonda-monitoramento.mjs
const BASE = "https://datalayer.portalunitrac.com";

function chaves(obj, prefixo = "") {
  // Lista chaves de um objeto com uma amostra do valor (curta)
  return Object.entries(obj).map(([k, v]) => {
    let amostra = v;
    if (typeof v === "string" && v.length > 40) amostra = v.slice(0, 40) + "…";
    if (typeof v === "object" && v !== null) amostra = Array.isArray(v) ? `[${v.length}]` : "{...}";
    return `${prefixo}${k}=${amostra}`;
  });
}

async function main() {
  // 1. Frota Benassi (4586) — pegar um cv ativo
  const rVeic = await fetch(`${BASE}/veiculos/masn/4586`, { headers: { accept: "application/json" } });
  const veic = await rVeic.json();
  const lista = veic.veiculos ?? [];
  console.log(`\n=== VEICULOS BENASSI: ${lista.length} ===`);
  console.log("Campos de 1 veiculo:", chaves(lista[0] ?? {}).join(" | "));

  // pegar codigos (campo e' "cv")
  const cvs = lista.map((v) => String(v.cv ?? v.veicucodigo)).filter((s) => s && s !== "undefined");
  console.log(`cvs amostra: ${cvs.slice(0, 5).join(",")}`);

  // 2. Posicoes — payload COMPLETO de 1 veiculo (todos os campos)
  const rPos = await fetch(`${BASE}/mapa_servicos/posicoes/N/N`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(cvs.slice(0, 30)),
  });
  const pos = await rPos.json();
  const posicoes = pos.Posicoes ?? [];
  console.log(`\n=== POSICOES: ${posicoes.length} ===`);
  if (posicoes[0]) {
    console.log("TODOS os campos de 1 posicao:");
    console.log(chaves(posicoes[0]).join("\n"));
  }

  // achar um cv que tenha posicao com lat/lng pra testar rastro/stops
  const alvo = posicoes.find((p) => p.posiclatitude && p.veicucodigo) ?? posicoes[0];
  const cv = String(alvo?.veicucodigo ?? cvs[0]);
  console.log(`\ncv escolhido p/ rastro/stops: ${cv} (placa ${alvo?.veicuplaca})`);

  // 3. RASTRO — testar 24h e 96h (4 dias, como Unitrac)
  for (const horas of [24, 96]) {
    try {
      const r = await fetch(`${BASE}/mapa_servicos/rastro/${cv}/${horas}`, { headers: { accept: "application/json" } });
      const j = await r.json();
      const pts = j.posicoes ?? j.Posicoes ?? [];
      console.log(`\n=== RASTRO ${horas}h: status ${r.status}, ${pts.length} pontos ===`);
      if (pts[0]) console.log("campos do ponto:", chaves(pts[0]).join(" | "));
    } catch (e) {
      console.log(`rastro ${horas}h ERRO: ${e}`);
    }
  }

  // 4. STOPS — paradas com duracao
  for (const horas of [24, 96]) {
    try {
      const r = await fetch(`${BASE}/mapa_servicos/stops/${cv}/${horas}`, { headers: { accept: "application/json" } });
      const j = await r.json();
      const paradas = j.paradas ?? j.Paradas ?? [];
      console.log(`\n=== STOPS ${horas}h: status ${r.status}, ${paradas.length} paradas ===`);
      if (paradas[0]) console.log("campos da parada:", chaves(paradas[0]).join(" | "));
    } catch (e) {
      console.log(`stops ${horas}h ERRO: ${e}`);
    }
  }

  // 5. ALVOS — payload completo (raio do cliente!)
  const rAlvos = await fetch(`${BASE}/mapa_servicos/alvos`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify([cv]),
  });
  const alvosJ = await rAlvos.json();
  const alvos = alvosJ.alvos ?? [];
  console.log(`\n=== ALVOS do cv ${cv}: ${alvos.length} ===`);
  if (alvos[0]) {
    console.log("TODOS os campos de 1 alvo:");
    console.log(chaves(alvos[0]).join("\n"));
  }
  // distribuicao de pontoraio em TODA a frota
  const rAlvosTodos = await fetch(`${BASE}/mapa_servicos/alvos`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(cvs.slice(0, 100)),
  });
  const alvosTodos = (await rAlvosTodos.json()).alvos ?? [];
  const raios = alvosTodos.map((a) => Number(a.pontoraio)).filter((n) => Number.isFinite(n) && n > 0);
  raios.sort((a, b) => a - b);
  if (raios.length) {
    const q = (p) => raios[Math.floor((raios.length - 1) * p)];
    console.log(`\n=== pontoraio em ${raios.length} alvos: min=${raios[0]} p25=${q(0.25)} mediana=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} max=${raios[raios.length-1]} ===`);
  }
}

main().catch((e) => { console.error("FALHA:", e); process.exit(1); });
