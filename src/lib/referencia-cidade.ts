// Ponto de referencia da cidade/bairro do endereco, carregado do cache em lote.
//
// GEO3-02/03 (auditoria 03/11): a referencia era montada em dois lugares e
// nos dois faltava num caminho:
//   - processar-geocode montava so' para as linhas reivindicadas no ciclo; a
//     retentativa das linhas "falhou" (orfas e com veiculo) rodava SEM
//     referencia e aceitava a primeira rua homonima do pais (Mage -> MG, 684 km);
//   - a ponte do KPI pulava a referencia quando o CNEFE/OSM nao tinha
//     candidato -- justo quando o Photon decide (Paraty -> PE, 1.867 km).
// Agora os tres caminhos usam esta mesma carga: 1 SELECT em lote no cache
// (CIDADE:/BAIRRO:), e so' o que falta vai ao Nominatim (quem chama decide se
// pode e se grava).
import { escolherPontoReferencia, type PontoReferencia } from "./romaneio-geocode";
import { extrairCidadeDoEndereco, expandirCidadeTruncada, extrairBairroDoEndereco, municipioCodigoIbge, termoBuscaCidade } from "./romaneio-geocode-local";

export type Ponto = { lat: number; lng: number };

export function chaveCidade(cidade: string): string {
  return `CIDADE:${termoBuscaCidade(cidade).toUpperCase()}`;
}

export function chaveBairro(bairro: string, cidade: string): string {
  return `BAIRRO:${bairro.toUpperCase()}:${termoBuscaCidade(cidade).toUpperCase()}`;
}

export function localDoEndereco(endereco: string): { cidade: string | null; bairro: string | null; municipioCodigo: string | null } {
  const bruta = extrairCidadeDoEndereco(endereco);
  const cidade = bruta ? expandirCidadeTruncada(bruta) : null;
  return { cidade, bairro: extrairBairroDoEndereco(endereco), municipioCodigo: cidade ? municipioCodigoIbge(cidade) : null };
}

export type DepsReferencias = {
  /** Le varias chaves CIDADE:/BAIRRO: do romaneio_geocode_cache de uma vez. */
  lerCacheEmLote: (chaves: string[]) => Promise<Map<string, Ponto>>;
  /** Nominatim (com throttle/retentativa) para o que nao esta no cache. Sem
   *  ele, so' o cache vale. */
  resolverExterno?: (termo: string) => Promise<Ponto | null>;
  /** So' o cron (processar-geocode) grava; a ponte e' so' leitura. */
  salvar?: (chave: string, ponto: Ponto) => Promise<void>;
  prazoEsgotado?: () => boolean;
  /** GEO3-04: codigo IBGE do poligono que contem o ponto (null = nenhum).
   *  Sem ele a referencia nao e' validada (comportamento antigo). */
  municipioDaCoordenada?: (lat: number, lng: number) => Promise<string | null>;
};

// GEO3-04 (auditoria 03/11): CIDADE:/BAIRRO: vinham do Nominatim sem checagem
// e o cache nunca expira -- "CIDADE:QUISSAMA, RJ, BRASIL" e' o bairro Quissama
// de Petropolis (179 km), 57 bairros em municipio errado (36 viravam regua).
// Cidade: descartada quando cai em OUTRO municipio (fora da malha fica, com
// log: o centro da cidade do Nominatim fica em terra). Bairro: so' vale dentro
// do proprio municipio. A linha ruim do cache NAO e' regravada aqui (limpeza
// com OK do dono, scripts/diagnostico/pontos-fora-do-municipio.mjs).
const memoMunicipio = new Map<string, string | null>();
const avisados = new Set<string>();

function avisarUmaVez(chave: string, msg: string): void {
  if (avisados.has(chave)) return;
  avisados.add(chave);
  console.warn(msg);
}

export type OpcoesCarga = {
  /** Cidade fora do cache vai ao Nominatim? Padrao: sim. */
  resolverCidadeExterno?: (endereco: string, municipioCodigo: string | null) => boolean;
  /** Bairro fora do cache vai ao Nominatim? Padrao: sim. */
  resolverBairroExterno?: (endereco: string) => boolean;
};

export function criarReferencias(deps: DepsReferencias) {
  async function municipioDe(p: Ponto): Promise<string | null | undefined> {
    if (!deps.municipioDaCoordenada) return undefined;
    const k = `${p.lat},${p.lng}`;
    if (memoMunicipio.has(k)) return memoMunicipio.get(k);
    try {
      const m = await deps.municipioDaCoordenada(p.lat, p.lng);
      memoMunicipio.set(k, m);
      return m;
    } catch (err) {
      console.error("[referencia-cidade] municipioDaCoordenada falhou -- referencia sem validar", err);
      return undefined;
    }
  }

  async function cidadeValida(chave: string, p: Ponto, esperado: string | null): Promise<boolean> {
    if (!esperado) return true;
    const real = await municipioDe(p);
    if (real === undefined) return true;
    if (real === null) {
      avisarUmaVez(`nulo|${chave}`, `[referencia-cidade] ${chave} fora da malha (${p.lat},${p.lng}) -- mantida`);
      return true;
    }
    if (real === esperado) return true;
    avisarUmaVez(`div|${chave}|${p.lat}`, `[referencia-cidade] ${chave} em ${p.lat},${p.lng} cai no municipio ${real}, esperado ${esperado} -- descartada`);
    return false;
  }

  async function bairroValido(chave: string, p: Ponto, esperado: string | null): Promise<boolean> {
    if (!esperado) return true;
    const real = await municipioDe(p);
    if (real === undefined || real === esperado) return true;
    avisarUmaVez(`div|${chave}|${p.lat}`, `[referencia-cidade] ${chave} em ${p.lat},${p.lng} fora do municipio ${esperado} (caiu em ${real ?? "nenhum"}) -- descartada, vale a da cidade`);
    return false;
  }

  const pontosCidade = new Map<string, Ponto>();
  const pontosBairro = new Map<string, Ponto>();
  const tentadas = new Set<string>();

  async function carregar(enderecos: string[], opcoes: OpcoesCarga = {}): Promise<void> {
    const cidades = new Map<string, string>(); // cidade -> 1o endereco (para as opcoes)
    const bairros = new Map<string, { bairro: string; cidade: string; endereco: string }>();
    for (const e of enderecos) {
      const { cidade, bairro } = localDoEndereco(e);
      if (!cidade) continue;
      if (!cidades.has(cidade)) cidades.set(cidade, e);
      if (bairro) {
        const k = `${bairro}|${cidade}`;
        if (!bairros.has(k)) bairros.set(k, { bairro, cidade, endereco: e });
      }
    }
    const novasCidades = [...cidades.keys()].filter((c) => !tentadas.has(`C|${c}`));
    const novosBairros = [...bairros.keys()].filter((k) => !tentadas.has(`B|${k}`));
    if (novasCidades.length === 0 && novosBairros.length === 0) return;
    for (const c of novasCidades) tentadas.add(`C|${c}`);
    for (const k of novosBairros) tentadas.add(`B|${k}`);

    const chaves = [
      ...novasCidades.map(chaveCidade),
      ...novosBairros.map((k) => chaveBairro(bairros.get(k)!.bairro, bairros.get(k)!.cidade)),
    ];
    const doCache = await deps.lerCacheEmLote([...new Set(chaves)]);

    for (const cidade of novasCidades) {
      const chave = chaveCidade(cidade);
      const esperado = municipioCodigoIbge(cidade);
      const p = doCache.get(chave);
      if (p && await cidadeValida(chave, p, esperado)) { pontosCidade.set(cidade, p); continue; }
      const endereco = cidades.get(cidade)!;
      const pode = opcoes.resolverCidadeExterno?.(endereco, esperado) ?? true;
      if (!pode || !deps.resolverExterno || deps.prazoEsgotado?.()) continue;
      const resolvido = await deps.resolverExterno(termoBuscaCidade(cidade));
      if (!resolvido || !await cidadeValida(chave, resolvido, esperado)) continue;
      pontosCidade.set(cidade, resolvido);
      // Linha ruim no cache: usa a nova so' em memoria (nao regrava por cima).
      if (!p) await deps.salvar?.(chave, resolvido);
    }

    for (const k of novosBairros) {
      const { bairro, cidade, endereco } = bairros.get(k)!;
      const chave = chaveBairro(bairro, cidade);
      const esperado = municipioCodigoIbge(cidade);
      const p = doCache.get(chave);
      if (p) {
        if (await bairroValido(chave, p, esperado)) pontosBairro.set(k, p);
        continue; // bairro ruim no cache: vale a da cidade (nao tenta de novo)
      }
      const pode = opcoes.resolverBairroExterno?.(endereco) ?? true;
      if (!pode || !deps.resolverExterno || deps.prazoEsgotado?.()) continue;
      const resolvido = await deps.resolverExterno(`${bairro}, ${termoBuscaCidade(cidade)}`);
      if (!resolvido || !await bairroValido(chave, resolvido, esperado)) continue;
      pontosBairro.set(k, resolvido);
      await deps.salvar?.(chave, resolvido);
    }
  }

  /** Bairro so' vale dentro da cidade (escolherPontoReferencia). */
  function referenciaDaCidade(cidade: string | null, bairro: string | null): PontoReferencia {
    if (!cidade) return null;
    return escolherPontoReferencia(
      (bairro && pontosBairro.get(`${bairro}|${cidade}`)) || null,
      pontosCidade.get(cidade) ?? null,
      municipioCodigoIbge(cidade),
    );
  }

  function referenciaDoEndereco(endereco: string): PontoReferencia {
    const { cidade, bairro } = localDoEndereco(endereco);
    return referenciaDaCidade(cidade, bairro);
  }

  return { carregar, referenciaDaCidade, referenciaDoEndereco, pontosCidade, pontosBairro };
}
