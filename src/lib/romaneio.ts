// Parser puro do romaneio diario de entrega (Nutry Max, PDF). So trabalha em
// cima do TEXTO ja extraido do PDF via pdf-parse (ver rota de upload) --
// nao depende de nada de I/O, totalmente testavel com fixture de texto.
//
// Formato real (confirmado extraindo o texto do romaneio de 15/07/2026 com
// pdf-parse v2 -- NAO bate com a ordem visual do PDF renderizado):
//   PLACA/MOTORISTA: <placa> / <motorista><TAB>CARGA/DESTINO: <codigo> / <nome>
//   AJUDANTE(S): ...
//   <nf> / <codigoCliente> - <nomeCliente>
//   <endereco>
//   NF / CLIENTE:                              <- rotulo solto, sobra da proxima linha
//   <nf> / <codigoCliente> - <nomeCliente>
//   <endereco>
//   ...
//   Total de N clientes
// O rotulo "NF / CLIENTE:" e as linhas "-- N of M --" (marcador de pagina do
// pdf-parse) e "Total de N clientes" nao batem em nenhum dos 2 regexes
// abaixo, entao sao ignoradas naturalmente pelo loop -- nao precisam de
// filtro explicito.
import type { PontoEntrega } from "./unitrac";

export type LinhaRomaneio = {
  placaBruta: string;
  motorista: string;
  cargaDestinoCodigo: string;
  cargaDestinoNome: string;
  nf: string;
  clienteCodigo: string;
  clienteNome: string;
  enderecoBruto: string;
};

// Placas com erro de digitacao NA FONTE (o proprio documento da Nutry Max
// traz a placa errada, confirmado 20-21/08: "RGU-5G33" aparece todo dia no
// romaneio deles, mas o carro real -- confirmado na API Unitrac -- e'
// RQU-5G33; nao existe nenhum RGU-* na frota). Correcao fixa aplicada
// DEPOIS da normalizacao de formato, chaveada pela placa ja normalizada.
// So adicionar aqui erro CONFIRMADO contra a Unitrac (placa errada nao
// existe na frota + placa certa existe e bate com a rota) -- nunca chute.
const PLACA_CORRECOES_FONTE: Record<string, string> = {
  "RGU-5G33": "RQU-5G33",
};

// Placa do romaneio vem sem hifen (ex. "TUL1C38"); o banco usa com hifen
// (ex. "TUL-1C38", padrao Mercosul letra-letra-letra-numero-letra-numero-
// numero). So mexe quando bate exatamente o formato esperado (7 chars, sem
// hifen) -- caso contrario devolve como veio, pra nao mascarar um formato
// inesperado.
export function normalizarPlaca(placaBruta: string): string {
  const limpa = placaBruta.trim().toUpperCase();
  const normalizada = limpa.includes("-") || limpa.length !== 7
    ? limpa
    : `${limpa.slice(0, 3)}-${limpa.slice(3)}`;
  return PLACA_CORRECOES_FONTE[normalizada] ?? normalizada;
}

// Data do romaneio vem do cabecalho impresso em CADA pagina (ex. "15/07/2026
// 06:17", canto superior direito) -- NUNCA da hora do upload, pra nao
// depender de quando exatamente a operacao sobe o arquivo. Pega a PRIMEIRA
// ocorrencia (todas as paginas do mesmo romaneio tem a mesma data).
export function extrairDataRomaneio(textoCompleto: string): string | null {
  const m = textoCompleto.match(/(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}:\d{2}/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const REGEX_CABECALHO = /PLACA\/MOTORISTA:\s*(\S+)\s*\/\s*(.+?)\s+CARGA\/DESTINO:\s*(\S+)\s*\/\s*(.+)/;
const REGEX_NF_CLIENTE = /^(\S+)\s*\/\s*(\S+)\s*-\s*(.+)$/;

// Extrai todas as linhas de entrega (uma por NF) do texto completo do
// romaneio (todas as paginas concatenadas, na ordem). Uma secao por veiculo
// -- o cabecalho PLACA/MOTORISTA+CARGA/DESTINO se repete no topo de cada
// pagina de continuacao da mesma secao, entao o parser so precisa lembrar
// do ULTIMO cabecalho visto, nao detectar limite de pagina.
export function parseRomaneio(textoCompleto: string): LinhaRomaneio[] {
  const linhas: LinhaRomaneio[] = [];
  let atual: { cargaDestinoCodigo: string; cargaDestinoNome: string; placaBruta: string; motorista: string } | null = null;

  const brutas = textoCompleto.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < brutas.length; i++) {
    const cab = brutas[i].match(REGEX_CABECALHO);
    if (cab) {
      atual = {
        placaBruta: cab[1].trim(),
        motorista: cab[2].trim(),
        cargaDestinoCodigo: cab[3].trim(),
        cargaDestinoNome: cab[4].trim(),
      };
      continue;
    }
    const nfMatch = brutas[i].match(REGEX_NF_CLIENTE);
    if (nfMatch && atual) {
      const enderecoBruto = brutas[i + 1] ?? "";
      linhas.push({
        placaBruta: atual.placaBruta,
        motorista: atual.motorista,
        cargaDestinoCodigo: atual.cargaDestinoCodigo,
        cargaDestinoNome: atual.cargaDestinoNome,
        nf: nfMatch[1].trim(),
        clienteCodigo: nfMatch[2].trim(),
        clienteNome: nfMatch[3].trim(),
        enderecoBruto,
      });
    }
  }
  return linhas;
}

export type LinhaRomaneioGeocodificada = {
  nf: string;
  clienteNome: string;
  // Nulos quando o geocode desta linha falhou (geocode_status <> 'ok') --
  // ver fallback pra coordenada da Unitrac em montarPontosDeRomaneio abaixo.
  lat: number | null;
  lng: number | null;
  // Achado real 15/07 (depois da spec anterior): a coordenada errada da
  // Unitrac afeta a CONFIRMACAO dela propria -- se o raio dela ta centrado
  // no ponto errado, uma entrega feita de verdade no endereco certo nunca
  // entra no raio dela, e a NF fica "pendente pra sempre". presencaConfirmadaEm
  // (setado pelo motor quando o dwell no NOSSO ponto, ja calculado pro
  // bypass_entrega, cruza 120s) e um sinal so INTERNO -- une com o status da
  // Unitrac, nunca substitui, nunca aparece pro operador como "entregue" (ver
  // docs/superpowers/specs/2026-07-15-presenca-confirmada-romaneio-design.md).
  presencaConfirmadaEm: string | null;
};

// Combina os pontos de HOJE vindos do romaneio (endereco/coordenada) com o
// status ao vivo que o motor JA busca da Unitrac todo ciclo (pontosUnitrac,
// ver route.ts `pontosPorPlaca`) -- casando por NF (`documento` ==
// `alvodocumento` da Unitrac, confirmado ao vivo em 15/07/2026 contra a API
// real). Zero chamada de rede extra: reusa o que o motor ja tem em maos
// naquele ciclo. NF sem alvo correspondente ainda (romaneio subiu antes da
// Unitrac sincronizar aquela entrega) fica pendente por padrao -- nunca
// assume "feito" sem confirmacao explicita da Unitrac.
//
// Fallback de coordenada por NF (pedido do usuario, 22/08, task-5-brief.md):
// 0,76% das linhas do romaneio (315 de 41.167 nos ultimos 30 dias) tem
// geocode_status <> 'ok' e por isso lat/lng nulos -- ANTES desta correcao, a
// query em route.ts filtrava essas linhas fora e a NF inteira sumia da lista
// de destinos do motor. E o mesmo modo de falha que este motor existe pra
// corrigir, em escala menor: caminhao indo pra um destino real que o motor
// nao enxerga -> "afastando de todos os pendentes" dispara -> falso
// positivo. Como o alvo da Unitrac deste mesmo ciclo ja e casado por NF
// (`alvo` abaixo) e traz coordenada propria, usamos ela SO quando a linha do
// romaneio nao tem coordenada usavel.
//
// Por que so por NF, nunca a uniao completa dos alvos Unitrac: um alvo da
// Unitrac cuja NF NAO esta no romaneio deste veiculo continua de fora.
// avaliarAfastandoDeTudo so dispara quando o veiculo se afasta de TODOS os
// pendentes -- cada destino a mais torna o alerta mais dificil de disparar.
// A Unitrac e justamente a fonte que erra endereco nesses carros; um destino
// fantasma dela esconderia desvio real. O fallback por NF e ganho puro
// (preenche um ponto que ja sabiamos existir no romaneio); a uniao completa
// trocaria falso positivo por falso negativo, o que a operacao nao aceita
// (ver [[feedback_desvio_priorizar_recall]]). NF do romaneio sem coordenada
// e sem alvo Unitrac correspondente continua fora -- nao ha de onde tirar
// coordenada.
export function montarPontosDeRomaneio(
  pontosRomaneio: LinhaRomaneioGeocodificada[],
  pontosUnitrac: PontoEntrega[]
): PontoEntrega[] {
  const porNf = new Map(pontosUnitrac.filter((p) => p.documento).map((p) => [p.documento as string, p]));
  return pontosRomaneio
    .map((l) => {
      const alvo = porNf.get(l.nf);
      // Romaneio e a verdade quando ele sabe: so cai pro fallback da
      // Unitrac quando a linha do romaneio nao trouxe coordenada usavel.
      const temCoordenadaRomaneio = l.lat != null && l.lng != null;
      const lat = temCoordenadaRomaneio ? l.lat : alvo?.lat ?? null;
      const lng = temCoordenadaRomaneio ? l.lng : alvo?.lng ?? null;
      if (lat == null || lng == null) return null;
      const ponto: PontoEntrega = {
        lat,
        lng,
        raio: alvo?.raio ?? 50,
        ordem: 0,
        nome: l.clienteNome,
        feito: (alvo?.feito ?? false) || l.presencaConfirmadaEm !== null,
        situacao: alvo?.situacao ?? 0,
        codigo: alvo?.codigo ?? null,
        pontoCodigo: alvo?.pontoCodigo ?? null,
        documento: l.nf,
        identificador: alvo?.identificador ?? null,
        dataInicio: alvo?.dataInicio ?? null,
        dataRealizado: alvo?.dataRealizado ?? null,
        observacoes: alvo?.observacoes ?? null,
        rota: alvo?.rota ?? null,
      };
      return ponto;
    })
    .filter((p): p is PontoEntrega => p !== null);
}
