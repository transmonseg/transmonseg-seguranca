// Diagnóstico: o payload do /api/favelas tem mesmo geometria fora da capital?
const url = process.argv[2] || "https://transmonseg-seguranca.vercel.app/api/favelas";
const r = await fetch(url);
const j = await r.json();
console.log("features:", j.features.length);

const tipos = {};
let capital = 0, resto = 0, semGeom = 0, vazias = 0;
const regioes = { metropolitana: 0, lagos_norte_leste: 0, sul_oeste: 0, outro: 0 };

function primeiroPar(coords) {
  let p = coords;
  while (Array.isArray(p) && Array.isArray(p[0])) p = p[0];
  return Array.isArray(p) ? p : null;
}

for (const f of j.features) {
  const g = f.geometry;
  if (!g) { semGeom++; continue; }
  tipos[g.type] = (tipos[g.type] || 0) + 1;
  if (!g.coordinates || g.coordinates.length === 0) { vazias++; continue; }
  const p = primeiroPar(g.coordinates);
  if (!p) { vazias++; continue; }
  const [lng, lat] = p;
  // capital do Rio aprox: lat -23.05..-22.75, lng -43.8..-43.1
  const naCapital = lat <= -22.75 && lat >= -23.08 && lng >= -43.8 && lng <= -43.05;
  if (naCapital) capital++; else resto++;
  if (lng > -42.5) regioes.lagos_norte_leste++;
  else if (lng < -43.9) regioes.sul_oeste++;
  else if (naCapital) regioes.metropolitana++;
  else regioes.outro++;
}
console.log("tipos de geometria:", tipos);
console.log("sem geometria:", semGeom, "| coords vazias:", vazias);
console.log("na capital:", capital, "| resto do estado:", resto);
console.log("distribuicao:", regioes);
