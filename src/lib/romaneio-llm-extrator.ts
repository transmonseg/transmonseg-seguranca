// Extrator generico de romaneio via IA -- caminho de generalizacao pra
// formato desconhecido (nao Nutry Max) ou Excel/CSV, ver design em
// docs/superpowers/specs/2026-08-12-romaneio-generico-llm-design.md. So
// entra em acao quando parseRomaneio() (regex Nutry Max) nao reconhece o
// formato -- NAO substitui o parser existente.
//
// A IA aqui so' LE O LAYOUT do documento (qual texto e' placa, qual e'
// endereco) -- nunca decide coordenada. Geocodificacao (romaneio-geocode.ts)
// continua 100% deterministica, sem IA, chamada depois desse extrator.
//
// Cascata local-primeiro-depois-nuvem, mesmo padrao que geocodificarEndereco
// ja usa (CNEFE/OSM local antes de Google/Nominatim): Ollama local (gratis,
// privado, ja instalado no transmonseg-vps -- ver scripts/observador-ia-
// desvio.mjs, mesmo modelo qwen2.5:7b) tentado primeiro; Mistral cloud e' o
// fallback se o local falhar ou devolver algo que nao valida.

export type LinhaRomaneioExtraida = {
  placaBruta: string;
  enderecoBruto: string;
  clienteNome: string;
  nf?: string;
  clienteCodigo?: string;
};

type Deps = {
  chamarOllama: (prompt: string) => Promise<string>;
  chamarMistral: (prompt: string) => Promise<string>;
};

const PROMPT_SISTEMA = `Voce extrai linhas de entrega de um romaneio de transporte (PDF ou planilha, formato desconhecido). Devolva APENAS um objeto JSON no formato exato, sem nenhum texto antes ou depois:
{"linhas": [{"placaBruta": "...", "enderecoBruto": "...", "clienteNome": "...", "nf": "...", "clienteCodigo": "..."}]}

Regras:
- Uma entrada por parada de entrega (uma linha por endereco/cliente distinto).
- "placaBruta": a placa do veiculo responsavel por aquela entrega, como aparece no documento.
- "enderecoBruto": o endereco de entrega completo (rua, numero, bairro, cidade se disponivel).
- "clienteNome": nome do cliente/destinatario daquela entrega.
- "nf" e "clienteCodigo" sao opcionais -- inclua so se o documento tiver essa informacao claramente.
- Se uma linha nao tiver endereco reconhecivel ou placa identificavel, inclua mesmo assim com o campo ausente/vazio -- NAO pule a linha nem invente dado que nao esta no texto.
- Ignore cabecalhos, rodapes, totalizadores e qualquer texto que nao seja uma linha de entrega.`;

function validarLinhas(parsed: unknown): LinhaRomaneioExtraida[] | null {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("linhas" in parsed) ||
    !Array.isArray((parsed as { linhas: unknown }).linhas)
  ) {
    return null;
  }
  const linhasBrutas = (parsed as { linhas: unknown[] }).linhas;
  const linhas: LinhaRomaneioExtraida[] = [];
  for (const l of linhasBrutas) {
    if (typeof l !== "object" || l === null) continue;
    const obj = l as Record<string, unknown>;
    const placaBruta = typeof obj.placaBruta === "string" ? obj.placaBruta : "";
    const enderecoBruto = typeof obj.enderecoBruto === "string" ? obj.enderecoBruto : "";
    const clienteNome = typeof obj.clienteNome === "string" ? obj.clienteNome : "";
    const nf = typeof obj.nf === "string" && obj.nf.length > 0 ? obj.nf : undefined;
    const clienteCodigo = typeof obj.clienteCodigo === "string" && obj.clienteCodigo.length > 0 ? obj.clienteCodigo : undefined;
    linhas.push({ placaBruta, enderecoBruto, clienteNome, nf, clienteCodigo });
  }
  return linhas;
}

type Provedor = "ollama" | "mistral";

// Nunca loga a resposta bruta nem qualquer credencial (MISTRAL_API_KEY) --
// so' o nome do provedor e a mensagem de erro, pra dar visibilidade de qual
// caminho falhou/salvou sem vazar segredo em log.
async function tentarExtrair(
  textoCompleto: string,
  chamar: (prompt: string) => Promise<string>,
  provedor: Provedor
): Promise<LinhaRomaneioExtraida[] | null> {
  let resposta: string;
  try {
    resposta = await chamar(textoCompleto);
  } catch (e) {
    console.error(`[romaneio-llm-extrator] ${provedor} falhou:`, e instanceof Error ? e.message : String(e));
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resposta);
  } catch (e) {
    console.error(`[romaneio-llm-extrator] ${provedor} devolveu JSON invalido:`, e instanceof Error ? e.message : String(e));
    return null;
  }
  const linhas = validarLinhas(parsed);
  if (!linhas) {
    console.error(`[romaneio-llm-extrator] ${provedor} devolveu formato inesperado (sem campo 'linhas' valido)`);
  }
  return linhas;
}

export type ResultadoExtracaoLLM = {
  linhas: LinhaRomaneioExtraida[];
  fonte: Provedor;
};

export async function extrairRomaneioViaLLM(
  textoCompleto: string,
  deps: Deps
): Promise<ResultadoExtracaoLLM | null> {
  const local = await tentarExtrair(textoCompleto, deps.chamarOllama, "ollama");
  // local pode ser um array VALIDO porem vazio ([]) quando o modelo local
  // nao reconhece o documento mas ainda devolve {"linhas": []} -- [] e'
  // truthy em JS, entao "if (local)" sozinho travaria aqui e nunca cairia
  // pro Mistral (o fallback existe exatamente pra esse caso). So aceita o
  // resultado local se tiver pelo menos uma linha extraida de verdade.
  if (local && local.length > 0) return { linhas: local, fonte: "ollama" };
  const cloud = await tentarExtrair(textoCompleto, deps.chamarMistral, "mistral");
  if (cloud) return { linhas: cloud, fonte: "mistral" };
  return null;
}

// ─── Chamadas HTTP reais -- SEM cache/fallback (isso fica por conta de
// extrairRomaneioViaLLM acima). Nao testadas por teste automatizado
// (chamada de rede real).

const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const OLLAMA_MODEL = "qwen2.5:7b";
// CPU-only no transmonseg-vps -- calibracao anterior desse mesmo modelo
// (scripts/observador-ia-desvio.mjs, 27/07) mediu 10-40s por chamada.
// 35s (nao 45s) pra que o pior caso combinado com o timeout do Mistral
// (30s) fique em 65s -- confortavel sob o maxDuration=120 da rota e sob
// defaults comuns de proxy/gateway.
const OLLAMA_TIMEOUT_MS = 35000;

export async function chamarOllama(prompt: string): Promise<string> {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      system: PROMPT_SISTEMA,
      prompt,
      stream: false,
      format: "json",
      options: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status}`);
  const data = (await res.json()) as { response?: string };
  if (!data.response) throw new Error("Ollama nao devolveu conteudo");
  return data.response;
}

export async function chamarMistral(prompt: string): Promise<string> {
  const chave = process.env.MISTRAL_API_KEY;
  if (!chave) throw new Error("MISTRAL_API_KEY nao configurada");
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${chave}`,
    },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: PROMPT_SISTEMA },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Mistral respondeu ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const conteudo = data.choices?.[0]?.message?.content;
  if (!conteudo) throw new Error("Mistral nao devolveu conteudo");
  return conteudo;
}
