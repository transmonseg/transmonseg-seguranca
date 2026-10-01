import { describe, it, expect, vi } from "vitest";
import {
  buscarSimilaridadeLimitada,
  criarSemaforo,
  semaforoSimilaridadeGlobal,
  MAX_BUSCAS_SIMILARIDADE_SIMULTANEAS,
  TIMEOUT_BUSCA_SIMILARIDADE_MS,
} from "./cnefe-similaridade-limitada";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("buscarSimilaridadeLimitada", () => {
  it("constantes do incidente 01/10: no maximo 2 simultaneas, timeout de 20s", () => {
    expect(MAX_BUSCAS_SIMILARIDADE_SIMULTANEAS).toBe(2);
    expect(TIMEOUT_BUSCA_SIMILARIDADE_MS).toBe(20_000);
  });

  it("nada estoura: devolve exatamente o que a consulta devolveu", async () => {
    const dados = [{ lat: -22.9, lng: -43.2 }];
    const r = await buscarSimilaridadeLimitada(async () => dados, { semaforo: criarSemaforo(2) });
    expect(r).toEqual({ status: "ok", data: dados });
  });

  it("concorrencia nunca passa do limite, mesmo com muitas chamadas de origens diferentes", async () => {
    const semaforo = criarSemaforo(2);
    let ativas = 0;
    let pico = 0;
    const consulta = async () => {
      ativas++;
      pico = Math.max(pico, ativas);
      await esperar(5);
      ativas--;
      return [];
    };
    await Promise.all(Array.from({ length: 30 }, () => buscarSimilaridadeLimitada(consulta, { semaforo })));
    expect(pico).toBe(2);
  });

  it("o semaforo global e' um so' por processo (mesma instancia entre chamadas/modulos)", () => {
    expect(semaforoSimilaridadeGlobal()).toBe(semaforoSimilaridadeGlobal());
    expect(semaforoSimilaridadeGlobal().limite).toBe(MAX_BUSCAS_SIMILARIDADE_SIMULTANEAS);
  });

  it("timeout: devolve status 'timeout' (nao lanca, nao finge lista vazia) e loga aviso", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await buscarSimilaridadeLimitada(() => new Promise<never[]>(() => {}), {
      semaforo: criarSemaforo(2), timeoutMs: 10, abortoMs: 50, rotulo: "RUA X",
    });
    expect(r).toEqual({ status: "timeout" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("RUA X"));
    warn.mockRestore();
  });

  it("timeout nao libera a vaga antes da consulta de verdade terminar (o banco ainda esta trabalhando)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const semaforo = criarSemaforo(1);
    let terminar!: () => void;
    const lenta = () => new Promise<never[]>((r) => { terminar = () => r([]); });
    const r1 = await buscarSimilaridadeLimitada(lenta, { semaforo, timeoutMs: 5, abortoMs: 10_000 });
    expect(r1.status).toBe("timeout");
    expect(semaforo.emUso()).toBe(1);
    terminar();
    await esperar(0);
    expect(semaforo.emUso()).toBe(0);
    vi.restoreAllMocks();
  });

  it("aborto duro: depois de abortoMs o sinal e' abortado e a vaga volta", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const semaforo = criarSemaforo(1);
    const r = await buscarSimilaridadeLimitada(
      (sinal) => new Promise<never[]>((_, rej) => sinal.addEventListener("abort", () => rej(new Error("abortado")))),
      { semaforo, timeoutMs: 5, abortoMs: 20 },
    );
    expect(r.status).toBe("timeout");
    await esperar(40);
    expect(semaforo.emUso()).toBe(0);
    vi.restoreAllMocks();
  });

  it("pular=true: nao consulta o banco, devolve status 'pulado'", async () => {
    const consulta = vi.fn(async () => []);
    const r = await buscarSimilaridadeLimitada(consulta, { semaforo: criarSemaforo(2), pular: true });
    expect(r).toEqual({ status: "pulado" });
    expect(consulta).not.toHaveBeenCalled();
  });

  it("erro da consulta segue como hoje: lista vazia (nao vira timeout)", async () => {
    const r = await buscarSimilaridadeLimitada(async () => { throw new Error("boom"); }, { semaforo: criarSemaforo(2) });
    expect(r).toEqual({ status: "ok", data: [] });
  });
});
