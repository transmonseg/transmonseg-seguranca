// Parser puro do romaneio "Escala do Pão" / "Programação Congelado" --
// formato TABULAR por carro, completamente diferente do romaneio da Nutry
// Max (romaneio.ts, que e' texto corrido "PLACA/MOTORISTA: .../CARGA/
// DESTINO: ..."). So trabalha em cima do TEXTO ja extraido do PDF via
// pdf-parse (mesmo padrao dos outros parsers de romaneio) -- nao depende de
// I/O, totalmente testavel com fixture de texto.
//
// Achado real 24-25/08 (grupo "DESVIO DE ROTA", cliente manda esse arquivo
// quase todo dia com nomes diferentes -- "PROGRAMAÇÃO...CONGELADO",
// "Romaneio de entrega" -- mas SEMPRE o mesmo layout): ate' 25/08 esse
// documento so' tinha um caminho generico via IA (Ollama/Mistral, ver
// romaneio-llm-extrator.ts) -- caro, lento (18-23s por geracao) e, pior,
// dependente de infra que se mostrou nao-confiavel (Ollama travando por
// horas seguidas). Como o layout e' 100% consistente (confirmado em pelo
// menos 2 arquivos reais de dias diferentes, 21/08 e 25/08, campo por
// campo identico), da' pra parsear deterministicamente -- zero dependencia
// de IA, zero custo, zero risco de timeout.
//
// Formato real (pdf-parse v2, linear, preserva colunas separadas por TAB
// pra esse gerador especifico de PDF):
//   DATA \t<dd/mm/yyyy>
//   ROMANEIO \t<numero> \tMOTORISTA \tAJUDANTE
//   CARRO \t<codigo> \t<PLACA> \t<motorista> \t<ajudante ou "-">
//   ORDEM \tNOTA FISCAL \tCLIENTE \tENDEREÇO \tBAIRRO \tQTD CAIXAS \tPESO BRUTO \tPESO LÍQUIDO \tVALOR BRUTO
//   <ordem> \t<nf> \t<cliente> \t<endereco> \t<bairro> \t<qtdCaixas> \t<pesoBruto> \t<pesoLiquido> \t<valorBruto>[\tR$]
//   ... (repete uma linha por NF)
//   <totalCaixas> \t<totalPesoBruto> \t<totalPesoLiquido> \t<totalValor>[\tR$]   <- linha de totais, SO' 4-5 campos
//   ROMANEIO \t<proximo numero> ...   <- repete pro proximo carro
export type LinhaRomaneioTabular = {
  placaBruta: string;
  nf: string;
  clienteNome: string;
  enderecoBruto: string;
};

// Linha de dado real tem 9 campos (ORDEM..VALOR BRUTO) as vezes com um 10º
// campo solto "R$" -- a linha de totais (mesmo formato numerico no inicio)
// so' tem 4-5. >= 8 distingue as duas sem ambiguidade nos arquivos reais
// vistos ate' agora.
const MIN_CAMPOS_LINHA_DADO = 8;
const REGEX_SO_DIGITOS = /^\d+$/;

/** "DATA\t25/08/2026" (SEM horario, ao contrario do cabecalho da Nutry Max
 *  em romaneio.ts -- por isso um extrator proprio, nao reusa
 *  extrairDataRomaneio) -> "2026-08-25". */
export function extrairDataTabular(textoCompleto: string): string | null {
  const m = textoCompleto.match(/DATA\s*[\t ]+(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Devolve null quando o texto claramente NAO e' desse formato (nenhuma
 *  linha CARRO reconhecida) -- sinal pro chamador tentar outro caminho
 *  (LLM). Array vazio (nunca acontece na pratica se ha CARRO reconhecido
 *  sem nenhuma linha de dado, mas nao e' erro) tambem cai nesse mesmo
 *  tratamento no route.ts (fonte alternativa some' se >0). */
export function parseRomaneioTabular(textoCompleto: string): LinhaRomaneioTabular[] | null {
  const linhas = textoCompleto.split("\n").map((l) => l.trim()).filter(Boolean);
  const resultado: LinhaRomaneioTabular[] = [];
  let placaAtual: string | null = null;
  let viuCarro = false;

  for (const linha of linhas) {
    const campos = linha.split("\t").map((c) => c.trim());
    if (campos.length === 0) continue;

    const rotulo = campos[0].toUpperCase();
    if (rotulo === "CARRO" && campos.length >= 3) {
      placaAtual = campos[2];
      viuCarro = true;
      continue;
    }
    if (rotulo === "ROMANEIO" || rotulo === "ORDEM" || rotulo === "DATA") {
      continue; // marcadores de secao/cabecalho, sem dado de entrega
    }

    // Linha de dado: campos[0]=ordem (digitos), campos[1]=nf (digitos),
    // pelo menos MIN_CAMPOS_LINHA_DADO campos no total (distingue de uma
    // linha de totais, que tem so' 4-5 campos com o mesmo formato numerico
    // no inicio).
    if (
      placaAtual &&
      campos.length >= MIN_CAMPOS_LINHA_DADO &&
      REGEX_SO_DIGITOS.test(campos[0]) &&
      REGEX_SO_DIGITOS.test(campos[1])
    ) {
      const nf = campos[1];
      const clienteNome = campos[2] ?? "";
      const endereco = campos[3] ?? "";
      const bairro = campos[4] ?? "";
      if (!clienteNome || !endereco) continue; // linha incompleta -- pula, nao inventa
      resultado.push({
        placaBruta: placaAtual,
        nf,
        clienteNome,
        enderecoBruto: bairro ? `${endereco}, ${bairro}` : endereco,
      });
    }
  }

  return viuCarro ? resultado : null;
}
