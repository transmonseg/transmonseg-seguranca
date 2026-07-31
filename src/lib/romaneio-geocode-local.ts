// Parsing/normalizacao de endereco do romaneio pra geocodificacao local
// via extrato OSM -- ver docs/superpowers/specs/2026-07-22-geocodificacao-local-romaneio-design.md.
// Funcoes PURAS, sem I/O.

// Formato real do romaneio (ver src/lib/romaneio.ts):
//   "<RUA>, <NUMERO> - <BAIRRO>, <CIDADE> - <SUFIXO>"
export function extrairRuaDoEndereco(enderecoBruto: string): string {
  const idx = enderecoBruto.indexOf(",");
  if (idx === -1) return enderecoBruto.trim();
  return enderecoBruto.slice(0, idx).trim();
}

export function extrairCidadeDoEndereco(enderecoBruto: string): string | null {
  const partes = enderecoBruto.split(",");
  if (partes.length < 3) return null;
  const ultimaParte = partes[partes.length - 1].trim();
  const cidade = ultimaParte.split(" - ")[0]?.trim();
  return cidade || null;
}

export function extrairNumeroDoEndereco(enderecoBruto: string): string | null {
  const partes = enderecoBruto.split(",");
  if (partes.length < 2) return null;
  const numero = partes[1].split(" - ")[0]?.trim();
  return numero || null;
}

export function extrairBairroDoEndereco(enderecoBruto: string): string | null {
  const partes = enderecoBruto.split(",");
  if (partes.length < 3) return null;
  const bairro = partes[1].split(" - ")[1]?.trim();
  return bairro || null;
}

// Municipios do RJ (fonte: IBGE) -- so usado pra EXPANDIR nome de cidade
// cortado no romaneio (achado real 31/07: o PDF de origem trunca o campo
// de cidade em ~15 caracteres, ex. "SAO PEDRO DA AL" em vez de "São Pedro
// da Aldeia", "SANTA MARIA MAD" em vez de "Santa Maria Madalena") --
// enviar o nome cortado pro Google/Nominatim direto falha quase sempre.
const MUNICIPIOS_RJ = [
  "Angra dos Reis", "Aperibé", "Araruama", "Areal", "Armação dos Búzios",
  "Arraial do Cabo", "Barra do Piraí", "Barra Mansa", "Belford Roxo",
  "Bom Jardim", "Bom Jesus do Itabapoana", "Cabo Frio", "Cachoeiras de Macacu",
  "Cambuci", "Campos dos Goytacazes", "Cantagalo", "Carapebus", "Cardoso Moreira",
  "Carmo", "Casimiro de Abreu", "Comendador Levy Gasparian", "Conceição de Macabu",
  "Cordeiro", "Duas Barras", "Duque de Caxias", "Engenheiro Paulo de Frontin",
  "Guapimirim", "Iguaba Grande", "Itaboraí", "Itaguaí", "Italva", "Itaocara",
  "Itaperuna", "Itatiaia", "Japeri", "Laje do Muriaé", "Macaé", "Macuco",
  "Magé", "Mangaratiba", "Maricá", "Mendes", "Mesquita", "Miguel Pereira",
  "Miracema", "Natividade", "Nilópolis", "Niterói", "Nova Friburgo",
  "Nova Iguaçu", "Paracambi", "Paraíba do Sul", "Parati", "Paty do Alferes",
  "Petrópolis", "Pinheiral", "Piraí", "Porciúncula", "Porto Real",
  "Quatis", "Queimados", "Quissamã", "Resende", "Rio Bonito", "Rio Claro",
  "Rio das Flores", "Rio das Ostras", "Rio de Janeiro", "Santa Maria Madalena",
  "Santo Antônio de Pádua", "São Fidélis", "São Francisco de Itabapoana",
  "São Gonçalo", "São João da Barra", "São João de Meriti", "São José de Ubá",
  "São José do Vale do Rio Preto", "São Pedro da Aldeia", "São Sebastião do Alto",
  "Sapucaia", "Saquarema", "Seropédica", "Silva Jardim", "Sumidouro",
  "Tanguá", "Teresópolis", "Trajano de Moraes", "Três Rios", "Valença",
  "Varre-Sai", "Vassouras", "Volta Redonda",
];

function semAcentoMaiusculo(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim().replace(/\s+/g, " ");
}

const MUNICIPIOS_RJ_NORMALIZADOS = MUNICIPIOS_RJ.map(semAcentoMaiusculo);

// Comprimento minimo do prefixo pra tentar expandir -- curto demais (ex.
// "SAO") bate em varios municipios ao mesmo tempo (ambiguo demais pra
// arriscar). O achado real (15 caracteres) fica bem acima disso.
const EXPANSAO_CIDADE_PREFIXO_MINIMO = 10;

export function expandirCidadeTruncada(cidade: string): string {
  const normalizada = semAcentoMaiusculo(cidade);
  if (MUNICIPIOS_RJ_NORMALIZADOS.includes(normalizada)) return cidade;
  if (normalizada.length < EXPANSAO_CIDADE_PREFIXO_MINIMO) return cidade;
  const candidatos = MUNICIPIOS_RJ.filter((_, i) => MUNICIPIOS_RJ_NORMALIZADOS[i].startsWith(normalizada));
  return candidatos.length === 1 ? candidatos[0] : cidade;
}

// Monta uma string enxuta especificamente pra mandar pro Google/Nominatim
// -- SEM o sufixo de complemento de entrega (ex. "LOJA 02", "KM 270
// QUADRA F 101", "1 PISO PARTE UNIDADE DO SHOPPING 530AB"), que nao faz
// parte do endereco postal e so confunde o geocoder (achado real 31/07).
// NAO usar essa string pra `extrairRuaDoEndereco`/`extrairCidadeDoEndereco`
// -- o formato de saida (separado por virgula simples) nao e' compativel
// com o parsing dessas funcoes, que esperam o formato original do romaneio.
export function montarEnderecoParaGeocode(enderecoBruto: string): string {
  const rua = extrairRuaDoEndereco(enderecoBruto);
  const numero = extrairNumeroDoEndereco(enderecoBruto);
  const bairro = extrairBairroDoEndereco(enderecoBruto);
  const cidadeBruta = extrairCidadeDoEndereco(enderecoBruto);
  const cidade = cidadeBruta ? expandirCidadeTruncada(cidadeBruta) : null;
  const numeroValido = numero && !/^S\/?N$/i.test(numero) ? numero : null;
  const ruaComNumero = numeroValido ? `${rua}, ${numeroValido}` : rua;
  return [ruaComNumero, bairro, cidade, "RJ", "Brasil"]
    .filter((p): p is string => !!p)
    .join(", ");
}

// Tipos de via reconhecidos como PREFIXO do nome -- removidos por completo
// (nao canonicalizados) pra bater independente de qual abreviacao o
// romaneio ou o OSM usarem (ex.: "AV" vs "Avenida" viram a mesma coisa
// depois de remover o prefixo dos dois lados).
const PREFIXOS_VIA = new Set([
  "RUA", "R", "AV", "AVENIDA", "TRAVESSA", "TRAV", "ESTRADA", "EST",
  "RODOVIA", "ROD", "ALAMEDA", "AL", "PRACA", "PC", "LARGO",
]);

// Conectores -- removidos de QUALQUER posicao do nome (nao so prefixo),
// achado real 31/07: aparecem de forma INCONSISTENTE entre o romaneio e o
// OSM, nos dois sentidos -- "RUA EDITH DE CASTRO LEITE" (romaneio) vs
// "EDITH CASTRO LEITE" (OSM) tem "de" a mais no romaneio; "RUA JOAO LUIZ
// SIQUEIRA" (romaneio) vs "JOAO LUIZ DE SIQUEIRA" (OSM) tem "de" a mais no
// OSM. Sem geocode do Google (usuario decidiu nao vincular faturamento),
// esse e' o proximo lugar de ganho gratis -- ver migration 021
// (vias_nomes.nome_sem_conectores, mesma remocao aplicada aos dados ja
// armazenados via coluna gerada, sem precisar reingestao do GeoJSON
// original que ja nao existe mais em disco).
const CONECTORES = new Set(["DE", "DA", "DO", "DAS", "DOS"]);

export function normalizarNomeRua(rua: string): string {
  const semAcento = rua
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
  const tokens = semAcento.split(" ");
  const semPrefixo = tokens.length > 1 && PREFIXOS_VIA.has(tokens[0])
    ? tokens.slice(1)
    : tokens;
  const semConectores = semPrefixo.filter((t) => !CONECTORES.has(t));
  return semConectores.join(" ");
}
