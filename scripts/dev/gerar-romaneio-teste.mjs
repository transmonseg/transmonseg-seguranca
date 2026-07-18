// scripts/dev/gerar-romaneio-teste.mjs
// Gera um PDF de romaneio de TESTE reutilizavel, no formato exato que
// src/lib/romaneio.ts sabe parsear (regexes REGEX_CABECALHO/REGEX_NF_CLIENTE)
// -- ver docs/superpowers/specs/2026-07-16-romaneio-modo-teste-design.md.
// So escreve o TEXTO que o pdf-parse extrai; nao replica o layout visual
// original do romaneio real.
//
// Uso: node scripts/dev/gerar-romaneio-teste.mjs <PLACA_REAL> [saida.pdf]
// Ex.: node scripts/dev/gerar-romaneio-teste.mjs TUL-1C38
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "node:fs";

const placa = process.argv[2];
if (!placa) {
  console.error("uso: node scripts/dev/gerar-romaneio-teste.mjs <PLACA_REAL> [saida.pdf]");
  process.exit(1);
}
const saida = process.argv[3] ?? "romaneio-teste.pdf";

const hoje = new Date();
const dataFormatada = `${String(hoje.getDate()).padStart(2, "0")}/${String(hoje.getMonth() + 1).padStart(2, "0")}/${hoje.getFullYear()} 06:00`;

// Enderecos reais de Natividade/Varre-Sai (RJ) -- mesma regiao da frota, pra
// geocode ter chance real de funcionar. Nomes de cliente marcados como TESTE
// de proposito, pra nunca serem confundidos com cliente de verdade numa
// consulta manual ao banco.
// Achado real na validacao da Task 6 (18/07): endereco de rua+numero
// inventado NAO geocodifica no Nominatim gratuito pra essas cidades do
// interior (mesmo problema ja documentado em romaneio-geocode.ts sobre o
// romaneio real de 15/07 -- confirmado direto contra a API, ver
// docs/plans/2026-07-18-romaneio-modo-teste.md). Bairro/distrito + cidade
// geocodifica bem; troquei pra esse nivel de granularidade.
const PONTOS_TESTE = [
  { nf: "TESTE-90001", clienteCodigo: "T001", clienteNome: "TESTE — Mercado Fictício 1", endereco: "Centro, Natividade - RJ" },
  { nf: "TESTE-90002", clienteCodigo: "T002", clienteNome: "TESTE — Mercado Fictício 2", endereco: "Centro, Varre-Sai - RJ" },
  { nf: "TESTE-90003", clienteCodigo: "T003", clienteNome: "TESTE — Mercado Fictício 3", endereco: "Boa Vista, Varre-Sai - RJ" },
];

const linhas = [];
linhas.push(`PLACA/MOTORISTA: ${placa} / TESTE MOTORISTA    CARGA/DESTINO: T000 / TESTE ROTA`);
linhas.push("AJUDANTE(S): ");
for (const p of PONTOS_TESTE) {
  linhas.push(`${p.nf} / ${p.clienteCodigo} - ${p.clienteNome}`);
  linhas.push(p.endereco);
}
linhas.push(`Total de ${PONTOS_TESTE.length} clientes`);
// Data no cabecalho -- extrairDataRomaneio pega a PRIMEIRA ocorrencia de
// dd/mm/aaaa hh:mm no texto inteiro, entao basta aparecer uma vez.
linhas.unshift(dataFormatada);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const pagina = doc.addPage([595, 842]); // A4
const tamanhoFonte = 10;
let y = 800;
for (const linha of linhas) {
  pagina.drawText(linha, { x: 40, y, size: tamanhoFonte, font });
  y -= tamanhoFonte + 6;
}

const bytes = await doc.save();
writeFileSync(saida, bytes);
console.log(`PDF de teste gerado: ${saida} (placa ${placa}, ${PONTOS_TESTE.length} pontos fictícios)`);
