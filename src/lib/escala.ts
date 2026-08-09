// Parser puro da escala de rota diaria (PDF, sem endereco -- so
// veiculo/cidade-regiao/contagem). So trabalha em cima do TEXTO ja
// extraido do PDF via pdf-parse (ver rota de upload), sem I/O, totalmente
// testavel com fixture de texto -- ver
// docs/superpowers/specs/2026-08-09-escala-rota-design.md.
//
// Formato real (confirmado extraindo o texto de Escala 04-08.pdf com
// pdf-parse v2): uma linha por carga --
//   <carga> <codigo curto> - <PLACA> <DESTINO[+indice]> <PESO ENT NF> <MOTORISTA[+ajudantes]> [\t <duplicado>]
// Linhas de rodape de comboio ("33.663\tComboio: 11 carga(s)"), marcador
// de pagina ("-- 1 of 3 --"), cabecalho de tabela ("COMBOIO 1\tCARGA
// VEICULO...") e total geral ("Geral: 83 carga(s) 277.505") nao batem no
// REGEX_LINHA_CARGA abaixo e sao ignoradas naturalmente.
//
// Achado real: as linhas de destino "JEITO CASEIRO" tem um numero A MAIS
// entre o destino e o nome do motorista do que as linhas normais (4
// numeros em vez de 3). Nao importa pro parser -- os ULTIMOS 2 numeros
// antes do nome sao sempre ENT e NF, em qualquer linha.
export type LinhaEscala = {
  cargaCodigo: string;
  placaBruta: string;
  destinoTexto: string;
  destinoNormalizado: string;
  entregas: number | null;
  nfs: number | null;
};

export function extrairDataEscala(textoCompleto: string): string | null {
  const m = textoCompleto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const REGEX_LINHA_CARGA = /^(\d+)\s+\d+\s*-\s*([A-Z0-9]{6,8})\s+(.+)$/;
const REGEX_PALAVRA_DESTINO = /^[\p{Lu}.]+$/u;
const REGEX_INDICE_SUBROTA = /^\d{1,2}$/;
const REGEX_NUMERO = /^[\d.]+$/;

export function parseEscala(textoCompleto: string): LinhaEscala[] {
  const linhas: LinhaEscala[] = [];
  const brutas = textoCompleto.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const bruta of brutas) {
    const cab = bruta.match(REGEX_LINHA_CARGA);
    if (!cab) continue;
    const [, cargaCodigo, placaBruta, resto] = cab;
    const tokens = resto.split(/\s+/);

    let i = 0;
    const palavrasDestino: string[] = [];
    while (i < tokens.length && REGEX_PALAVRA_DESTINO.test(tokens[i])) {
      palavrasDestino.push(tokens[i]);
      i++;
    }
    if (palavrasDestino.length === 0) continue;

    const destinoNormalizado = palavrasDestino.join(" ");
    let destinoTexto = destinoNormalizado;
    if (i < tokens.length && REGEX_INDICE_SUBROTA.test(tokens[i])) {
      destinoTexto = `${destinoNormalizado} ${tokens[i]}`;
      i++;
    }

    const numeros: string[] = [];
    while (i < tokens.length && REGEX_NUMERO.test(tokens[i])) {
      numeros.push(tokens[i]);
      i++;
    }
    const entregas = numeros.length >= 2 ? parseInt(numeros[numeros.length - 2], 10) : null;
    const nfs = numeros.length >= 1 ? parseInt(numeros[numeros.length - 1], 10) : null;

    linhas.push({ cargaCodigo, placaBruta, destinoTexto, destinoNormalizado, entregas, nfs });
  }
  return linhas;
}
