import { describe, it, expect } from "vitest";
import { reposicionarPorAncoraMaisProxima } from "./romaneio-geocode-ancoras";

describe("reposicionarPorAncoraMaisProxima", () => {
  const ancoraCampoGrande = { lat: -22.9028, lng: -43.5606 };

  it("sem candidatos: null", () => {
    expect(reposicionarPorAncoraMaisProxima([], [ancoraCampoGrande])).toBeNull();
  });

  it("sem ancoras: null (nada pra comparar)", () => {
    expect(reposicionarPorAncoraMaisProxima([{ lat: -22.9, lng: -43.56 }], [])).toBeNull();
  });

  it("candidato dentro do raio: reposiciona", () => {
    const candidato = { lat: -22.905, lng: -43.562 }; // ~500m da ancora
    expect(reposicionarPorAncoraMaisProxima([candidato], [ancoraCampoGrande])).toEqual(candidato);
  });

  it("candidato longe demais (fora do raio): null, nao arrisca", () => {
    const candidatoLonge = { lat: -22.9068, lng: -43.1729 }; // Centro do Rio, ~40km
    expect(reposicionarPorAncoraMaisProxima([candidatoLonge], [ancoraCampoGrande])).toBeNull();
  });

  it("varios candidatos: escolhe o mais proximo de QUALQUER ancora", () => {
    const perto = { lat: -22.903, lng: -43.561 };
    const longe = { lat: -22.95, lng: -43.6 };
    expect(reposicionarPorAncoraMaisProxima([longe, perto], [ancoraCampoGrande])).toEqual(perto);
  });

  it("varias ancoras: usa a mais proxima do candidato, nao a primeira da lista", () => {
    const ancoraLonge = { lat: -22.7, lng: -43.9 };
    const candidato = { lat: -22.904, lng: -43.559 }; // perto de ancoraCampoGrande, longe de ancoraLonge
    expect(reposicionarPorAncoraMaisProxima([candidato], [ancoraLonge, ancoraCampoGrande])).toEqual(candidato);
  });
});
