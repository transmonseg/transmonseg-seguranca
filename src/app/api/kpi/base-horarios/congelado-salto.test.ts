import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { removerTrechoCongeladoComSalto, derivarParadas, acharVisitasPorPonto } from "./route";

// F2-08 (KN-07, plano mestre 23/10): posicao identica com atraso baixo seguida
// de salto impossivel. Caso real RQV9B26 22/10 (posicoes_historico, 03:00Z a
// 12:45Z): das 11:39:38Z as 12:19:38Z (08:39-09:19 BRT) a mesma coordenada
// (-22.823922, -43.277958) com atraso 0-1 e v=0; as 12:20:15Z o ponto pula
// 13,5 km (Churrasco do Ricardo) em 36 s. Depois, das 12:25:09Z as 12:39:38Z,
// parada real no Primos/Churrasco (atraso subindo 0 -> 7, ignicao desligada)
// seguida de 2,2 km em 37 s -- pelo instante do GPS (criado_em - atraso) sao
// ~6 min, 22 km/h: possivel, a parada fica.
function lerFixture(nome: string) {
  const linhas = readFileSync(join(__dirname, "__fixtures__", nome), "utf8").trim().split("\n").slice(1);
  return linhas.map((l) => {
    const [criado_em, lat, lng, velocidade, atraso_min] = l.split(",");
    return { criado_em, lat: Number(lat), lng: Number(lng), velocidade: Number(velocidade), atraso_min: Number(atraso_min) };
  });
}
const PENHA = { lat: -22.815896899530625, lng: -43.27780385194278 };
const CHURRASCO = { id: "2438539", lat: -22.703473, lng: -43.276858 };
const t = (iso: string) => Date.parse(iso);

describe("F2-08: trecho congelado seguido de salto impossivel (RQV9B26 22/10)", () => {
  const posicoes = lerFixture("rqv9b26-2026-10-22-manha.csv");

  it("descarta o trecho 08:39-09:19 BRT inteiro e so' ele", () => {
    const limpas = removerTrechoCongeladoComSalto(posicoes);
    const removidas = posicoes.filter((p) => !limpas.includes(p));
    expect(removidas.length).toBe(81);
    expect(removidas[0].criado_em).toBe("2026-10-22T11:39:38.462Z");
    expect(removidas[removidas.length - 1].criado_em).toBe("2026-10-22T12:19:38.978Z");
    expect(removidas.every((p) => p.lat === -22.823922 && p.lng === -43.277958)).toBe(true);
  });

  it("sem o trecho, nao sai parada em Penha entre 08:40 e 09:25 BRT; a parada real das 09:23-09:39 continua", () => {
    const antes = derivarParadas(posicoes, [PENHA]);
    expect(antes.some((p) => p.lat < -22.8 && t(p.chegada) < t("2026-10-22T12:25:00Z") && t(p.saida) > t("2026-10-22T11:40:00Z"))).toBe(true);
    const depois = derivarParadas(removerTrechoCongeladoComSalto(posicoes), [PENHA]);
    expect(depois.some((p) => p.lat < -22.8 && t(p.chegada) < t("2026-10-22T12:25:00Z") && t(p.saida) > t("2026-10-22T11:40:00Z"))).toBe(false);
    expect(depois.some((p) => p.chegada === "2026-10-22T12:23:38.972Z" && p.saida === "2026-10-22T12:39:38.804Z")).toBe(true);
  });

  it("Churrasco do Ricardo: visita a partir de 09:20 BRT (12:20:15Z)", () => {
    const [v] = acharVisitasPorPonto(removerTrechoCongeladoComSalto(posicoes), [CHURRASCO], [PENHA]);
    expect(v.chegada).toBe("2026-10-22T12:20:15.032Z");
  });

  it("salto que volta em ate 4 leituras e' glitch do ponto, nao do trecho: nada sai", () => {
    const base = Array.from({ length: 6 }, (_, i) => ({ lat: -22.9, lng: -43.2, criado_em: new Date(Date.UTC(2026, 9, 22, 12, 0, i * 30)).toISOString(), velocidade: 0, atraso_min: 0 }));
    const glitch = { lat: -22.7, lng: -43.2, criado_em: "2026-10-22T12:03:00.000Z", velocidade: 0, atraso_min: 0 };
    const volta = { lat: -22.9, lng: -43.2, criado_em: "2026-10-22T12:03:30.000Z", velocidade: 0, atraso_min: 0 };
    const pos = [...base, glitch, volta];
    expect(removerTrechoCongeladoComSalto(pos)).toEqual(pos);
  });

  it("deslocamento possivel pelo instante do GPS (atraso alto antes do salto) nao descarta nada", () => {
    const parada = Array.from({ length: 10 }, (_, i) => ({ lat: -22.9, lng: -43.2, criado_em: new Date(Date.UTC(2026, 9, 22, 12, 0, i * 30)).toISOString(), velocidade: 0, atraso_min: i }));
    const depois = { lat: -22.88, lng: -43.2, criado_em: "2026-10-22T12:05:10.000Z", velocidade: 50, atraso_min: 0 };
    const pos = [...parada, depois];
    expect(removerTrechoCongeladoComSalto(pos)).toEqual(pos);
  });
});
