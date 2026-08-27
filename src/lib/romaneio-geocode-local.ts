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
  // Achado real (cliente EMPORIO VALLEJU): o romaneio as vezes omite a
  // cidade por completo -- "RUA ,NUMERO, BAIRRO", sem " - " nenhum -- em
  // vez do formato normal "RUA, NUM - BAIRRO, CIDADE - SUFIXO". Sem essa
  // checagem, o bairro (unico dado real no ultimo segmento) era extraido
  // como se fosse cidade (ex: "NOGUEIRA", que e' bairro de Petropolis,
  // virava "cidade" -- geocode por sorte caiu perto, mas era coincidencia).
  if (!partes[1].includes(" - ")) return null;
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
  // Mesma variante sem cidade do achado EMPORIO VALLEJU (ver
  // extrairCidadeDoEndereco): sem " - " embutido em partes[1], o bairro de
  // verdade e' o ultimo segmento inteiro, nao o que viria depois de " - ".
  if (!partes[1].includes(" - ")) return partes[partes.length - 1].trim() || null;
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

// Auditoria 27/08 sobre o dado REAL (todos os romaneio_pontos dos ultimos
// 30 dias, 49.535 linhas / 157 valores distintos no campo de cidade): o
// match por PREFIXO ja resolve TODO truncamento de 15 caracteres que
// aparece de verdade -- inclusive "SANTO ANTONIO D" -> "Santo Antônio de
// Pádua", o caso que motivou este plano (325 linhas em 30 dias), que
// portanto NAO precisava de entrada nova. O que o prefixo NAO pegava, e
// esta tabela pega, sao as variantes em que o PDF de origem corrompe o
// nome em vez de so corta-lo (letra trocada/acentuada comida). Chaves na
// forma normalizada (sem acento, CAIXA ALTA, sem ruido de separador),
// contagem de linhas dos ultimos 30 dias entre parenteses.
const ALIASES_CIDADE: Record<string, string> = {
  // Grafia turistica corrente; o IBGE (e MUNICIPIOS_RJ) usa "Parati". (2)
  "PARATY": "Parati",
  // "ARMAÇÃO DOS BÚZIOS" perdendo o "DOS" (6) e perdendo as vogais
  // acentuadas -- "ARMAÇO DOS BZIO" (4). Este segundo e' o caso mais
  // grave achado na auditoria: sem cidade resolvida nao ha pontoCidade
  // nem municipioCodigo, e o endereco "RUA FLORES DE MAIO, 8200 -
  // MANGUINHOS, ARMAÇO DOS BZIO" caiu no bairro HOMONIMO Manguinhos do
  // Rio de Janeiro capital (-22.859149, -43.452133), ~160km do Manguinhos
  // de Búzios que era o destino real.
  "ARMACAO BUZIOS": "Armação dos Búzios",
  "ARMACO DOS BZIO": "Armação dos Búzios",
  // Truncado em 15 E com "GOYT" grafado "GOIT" -- o prefixo nao bate. (1)
  "CAMPOS DOS GOIT": "Campos dos Goytacazes",
  // "Paty do Alferes" grafado com "DE" no lugar do "DO". (1)
  "PATY DE ALFERE": "Paty do Alferes",
};

// Ruido de separador nas pontas do campo de cidade. Achado real da
// auditoria 27/08: 139 linhas em 30 dias vem com o hifen do separador
// grudado no nome ("ANGRA DOS REIS -", "RIO DE JANEIRO -", "GUAPIMIRIM -",
// "NOVA IGUACU -"), porque o endereco termina em " -" com o sufixo de
// complemento VAZIO -- o split(" - ") de extrairCidadeDoEndereco precisa
// do espaco DEPOIS do hifen pra cortar, e ele nao existe. Sem essa
// limpeza, cidade valida e comum nao batia com a lista de municipios: nao
// resolvia pontoCidade nem municipioCodigo, e a linha ia pro CNEFE/OSM
// sem NENHUM filtro de municipio e sem validacao de distancia.
function limparRuidoDeSeparador(s: string): string {
  return s.replace(/^[\s\-.,;/]+|[\s\-.,;/]+$/g, "").replace(/\s+/g, " ").trim();
}

// Hifen tratado como espaco nos DOIS lados da comparacao -- achado real da
// auditoria 27/08: "VARRE SAI" (127 linhas em 30 dias, o maior volume
// entre os nao resolvidos) e' o municipio "Varre-Sai" sem o hifen. E curto
// demais (9 caracteres) pra passar pelo piso de prefixo, entao so um match
// exato hifen-insensivel resolve. Nenhum outro municipio do RJ tem hifen,
// entao a comparacao nao cria ambiguidade nova.
function chaveSemHifen(s: string): string {
  return s.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

const MUNICIPIOS_RJ_CHAVES = MUNICIPIOS_RJ_NORMALIZADOS.map(chaveSemHifen);

export function expandirCidadeTruncada(cidade: string): string {
  const normalizada = semAcentoMaiusculo(cidade);
  // Bateu exato do jeito que veio: devolve o ORIGINAL, preservando o case
  // (comportamento de sempre, do qual municipioCodigoIbge depende -- ver
  // comentario dele mais abaixo).
  if (MUNICIPIOS_RJ_NORMALIZADOS.includes(normalizada)) return cidade;

  const limpa = limparRuidoDeSeparador(normalizada);
  if (!limpa) return cidade;

  const alias = ALIASES_CIDADE[limpa];
  if (alias) return alias;

  const chave = chaveSemHifen(limpa);
  const idxExato = MUNICIPIOS_RJ_CHAVES.indexOf(chave);
  if (idxExato !== -1) return MUNICIPIOS_RJ[idxExato];

  if (chave.length < EXPANSAO_CIDADE_PREFIXO_MINIMO) return cidade;
  const candidatos = MUNICIPIOS_RJ.filter((_, i) => MUNICIPIOS_RJ_CHAVES[i].startsWith(chave));
  return candidatos.length === 1 ? candidatos[0] : cidade;
}

// Codigo IBGE de 7 digitos por municipio (fonte: API oficial
// servicodados.ibge.gov.br/api/v1/localidades/estados/RJ/municipios,
// consultada 12/08) -- mesma cobertura de MUNICIPIOS_RJ (so RJ, mesmo
// escopo do CNEFE ja ingerido). Chave "Parati" (nao "Paraty", grafia
// oficial do IBGE) pra bater com a grafia ja usada em MUNICIPIOS_RJ acima.
// Achado real 12/08: usado pra filtrar CNEFE por municipio na consulta
// (nao so por proximidade depois) -- ver
// docs/superpowers/specs/2026-08-12-precisao-geocodificacao-romaneio-design.md.
const MUNICIPIO_CODIGO_IBGE: Record<string, string> = {
  "Angra dos Reis": "3300100",
  "Aperibé": "3300159",
  "Araruama": "3300209",
  "Areal": "3300225",
  "Armação dos Búzios": "3300233",
  "Arraial do Cabo": "3300258",
  "Barra do Piraí": "3300308",
  "Barra Mansa": "3300407",
  "Belford Roxo": "3300456",
  "Bom Jardim": "3300506",
  "Bom Jesus do Itabapoana": "3300605",
  "Cabo Frio": "3300704",
  "Cachoeiras de Macacu": "3300803",
  "Cambuci": "3300902",
  "Campos dos Goytacazes": "3301009",
  "Cantagalo": "3301108",
  "Carapebus": "3300936",
  "Cardoso Moreira": "3301157",
  "Carmo": "3301207",
  "Casimiro de Abreu": "3301306",
  "Comendador Levy Gasparian": "3300951",
  "Conceição de Macabu": "3301405",
  "Cordeiro": "3301504",
  "Duas Barras": "3301603",
  "Duque de Caxias": "3301702",
  "Engenheiro Paulo de Frontin": "3301801",
  "Guapimirim": "3301850",
  "Iguaba Grande": "3301876",
  "Itaboraí": "3301900",
  "Itaguaí": "3302007",
  "Italva": "3302056",
  "Itaocara": "3302106",
  "Itaperuna": "3302205",
  "Itatiaia": "3302254",
  "Japeri": "3302270",
  "Laje do Muriaé": "3302304",
  "Macaé": "3302403",
  "Macuco": "3302452",
  "Magé": "3302502",
  "Mangaratiba": "3302601",
  "Maricá": "3302700",
  "Mendes": "3302809",
  "Mesquita": "3302858",
  "Miguel Pereira": "3302908",
  "Miracema": "3303005",
  "Natividade": "3303104",
  "Nilópolis": "3303203",
  "Niterói": "3303302",
  "Nova Friburgo": "3303401",
  "Nova Iguaçu": "3303500",
  "Paracambi": "3303609",
  "Paraíba do Sul": "3303708",
  "Parati": "3303807",
  "Paty do Alferes": "3303856",
  "Petrópolis": "3303906",
  "Pinheiral": "3303955",
  "Piraí": "3304003",
  "Porciúncula": "3304102",
  "Porto Real": "3304110",
  "Quatis": "3304128",
  "Queimados": "3304144",
  "Quissamã": "3304151",
  "Resende": "3304201",
  "Rio Bonito": "3304300",
  "Rio Claro": "3304409",
  "Rio das Flores": "3304508",
  "Rio das Ostras": "3304524",
  "Rio de Janeiro": "3304557",
  "Santa Maria Madalena": "3304607",
  "Santo Antônio de Pádua": "3304706",
  "São Fidélis": "3304805",
  "São Francisco de Itabapoana": "3304755",
  "São Gonçalo": "3304904",
  "São João da Barra": "3305000",
  "São João de Meriti": "3305109",
  "São José de Ubá": "3305133",
  "São José do Vale do Rio Preto": "3305158",
  "São Pedro da Aldeia": "3305208",
  "São Sebastião do Alto": "3305307",
  "Sapucaia": "3305406",
  "Saquarema": "3305505",
  "Seropédica": "3305554",
  "Silva Jardim": "3305604",
  "Sumidouro": "3305703",
  "Tanguá": "3305752",
  "Teresópolis": "3305802",
  "Trajano de Moraes": "3305901",
  "Três Rios": "3306008",
  "Valença": "3306107",
  "Varre-Sai": "3306156",
  "Vassouras": "3306206",
  "Volta Redonda": "3306305",
};

const MUNICIPIO_CODIGO_IBGE_NORMALIZADOS: Record<string, string> = Object.fromEntries(
  Object.entries(MUNICIPIO_CODIGO_IBGE).map(([nome, codigo]) => [semAcentoMaiusculo(nome), codigo])
);

// Achado real 12/08: expandirCidadeTruncada preserva o case ORIGINAL do
// endereco quando a cidade ja bate direto sem precisar truncar/expandir
// (so normaliza pra Title Case no caso truncado) -- entao a entrada aqui
// pode chegar tanto "Rio de Janeiro" (truncado, ja expandido) quanto "RIO
// DE JANEIRO" (formato bruto do romaneio, CAIXA ALTA). Normaliza os dois
// lados (mesma funcao semAcentoMaiusculo ja usada por
// expandirCidadeTruncada) pra achar o codigo independente de qual forma
// chegou.
export function municipioCodigoIbge(cidadeExpandida: string): string | null {
  return MUNICIPIO_CODIGO_IBGE_NORMALIZADOS[semAcentoMaiusculo(cidadeExpandida)] ?? null;
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
// romaneio ou o OSM/CNEFE usarem (ex.: "AV" vs "Avenida" viram a mesma
// coisa depois de remover o prefixo dos dois lados). Lista expandida
// 31/07 (segunda rodada, apos CNEFE) com tipos achados nos enderecos que
// ainda falhavam: VILA, SERVIDAO, SITIO/SIT, AREA.
const PREFIXOS_VIA = new Set([
  "RUA", "R", "AV", "AVENIDA", "TRAVESSA", "TRAV", "ESTRADA", "EST",
  "RODOVIA", "ROD", "ALAMEDA", "AL", "PRACA", "PC", "LARGO",
  "VILA", "VL", "SERVIDAO", "SITIO", "SIT", "AREA", "LADEIRA", "BECO",
  "VIELA", "CAMINHO", "LOTEAMENTO",
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

// Titulos abreviados no romaneio que o CNEFE (e provavelmente o OSM) grava
// por extenso -- achado real 31/07 (segunda rodada): "PC DR ORLANDO
// OBERLAENDER" (romaneio) nao batia com "DOUTOR ORLANDO OBERLAENDER"
// (CNEFE, confirmado via query real). Expande pro lado do romaneio, nao
// canonicaliza pra abreviado, porque a fonte de dado (CNEFE) usa forma
// extensa de forma consistente.
const ABREVIACOES_TITULO = new Map([
  ["DR", "DOUTOR"], ["DRA", "DOUTORA"],
  ["PROF", "PROFESSOR"], ["PROFA", "PROFESSORA"],
  ["CEL", "CORONEL"], ["GEN", "GENERAL"],
  ["PRES", "PRESIDENTE"], ["ENG", "ENGENHEIRO"],
  ["CAP", "CAPITAO"], ["TEN", "TENENTE"],
  ["MONS", "MONSENHOR"], ["CMTE", "COMANDANTE"],
  ["MAJ", "MAJOR"], ["ALM", "ALMIRANTE"],
]);

export function normalizarNomeRua(rua: string): string {
  const semAcento = rua
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
  let tokens = semAcento.split(" ");
  // Loop, nao "if" unico -- achado real 31/07: o PDF de origem as vezes
  // repete o tipo abreviado E por extenso ("AV AVENIDA X", "R ESTRADA X",
  // "AREA AVENIDA X") -- um strip so deixava a segunda palavra do tipo
  // grudada no nome, nunca batia com o CNEFE/OSM.
  while (tokens.length > 1 && PREFIXOS_VIA.has(tokens[0])) {
    tokens = tokens.slice(1);
  }
  const semAbreviacoes = tokens.map((t) => ABREVIACOES_TITULO.get(t) ?? t);
  const semConectores = semAbreviacoes.filter((t) => !CONECTORES.has(t));
  return semConectores.join(" ");
}
