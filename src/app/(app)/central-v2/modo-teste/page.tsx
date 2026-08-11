"use client";

// Comparacao lado a lado: alertas de PRODUCAO (motor real) vs alertas de
// MODO TESTE (motor rodando em paralelo, dados de romaneio_pontos com
// modo_teste=true) para o mesmo cliente, mais as marcacoes por endereco
// do romaneio de teste pra uma placa especifica. Primeira versao e' so
// lista (nao mapa) -- ver nota de escopo no brief da Task 8.
import { useEffect, useState } from "react";

type PontoTeste = {
  lat: number;
  lng: number;
  nome: string;
  enderecoBruto: string;
  feito: boolean;
  romaneioId: string;
};

type Alerta = {
  id: string;
  veiculo_id: string;
  motivo: string | null;
  score: number | null;
  desde: string;
};

export default function ModoTestePage() {
  const [placa, setPlaca] = useState("");
  const [pontosTeste, setPontosTeste] = useState<PontoTeste[]>([]);
  const [alertasTeste, setAlertasTeste] = useState<Alerta[]>([]);
  const [alertasReais, setAlertasReais] = useState<Alerta[]>([]);
  const [cliente, setCliente] = useState<string | null>(null);

  useEffect(() => {
    setCliente(new URLSearchParams(window.location.search).get("cliente"));
  }, []);

  useEffect(() => {
    if (!placa) { setPontosTeste([]); return; }
    fetch(`/api/alvos-teste?placa=${encodeURIComponent(placa)}`)
      .then((r) => (r.ok ? r.json() : { pontos: [] }))
      .then((d: { pontos?: PontoTeste[] }) => setPontosTeste(d.pontos ?? []))
      .catch(() => setPontosTeste([]));
  }, [placa]);

  useEffect(() => {
    if (!cliente) return;
    const carregar = () => {
      fetch(`/api/alertas?cliente=${encodeURIComponent(cliente)}&modoTeste=true`)
        .then((r) => (r.ok ? r.json() : { alertas: [] }))
        .then((d: { alertas?: Alerta[] }) => setAlertasTeste(d.alertas ?? []))
        .catch(() => setAlertasTeste([]));
      fetch(`/api/alertas?cliente=${encodeURIComponent(cliente)}`)
        .then((r) => (r.ok ? r.json() : { alertas: [] }))
        .then((d: { alertas?: Alerta[] }) => setAlertasReais(d.alertas ?? []))
        .catch(() => setAlertasReais([]));
    };
    carregar();
    const id = setInterval(carregar, 30_000);
    return () => clearInterval(id);
  }, [cliente]);

  return (
    <div style={{ display: "flex", gap: 24, padding: 24, fontFamily: "monospace" }}>
      <div style={{ flex: 1 }}>
        <h2>Produção (real)</h2>
        {!cliente && <p>Faltou o parâmetro ?cliente= na URL.</p>}
        <ul>
          {alertasReais.map((a) => (
            <li key={a.id}>
              {a.motivo ?? "?"} — score {a.score ?? "?"} — {new Date(a.desde).toLocaleTimeString("pt-BR")}
            </li>
          ))}
        </ul>
      </div>
      <div style={{ flex: 1 }}>
        <h2>Modo teste</h2>
        <input
          placeholder="Placa"
          value={placa}
          onChange={(e) => setPlaca(e.target.value)}
        />
        <h3>Marcações por endereço</h3>
        <ul>
          {pontosTeste.map((p) => (
            <li key={p.romaneioId}>
              {p.nome} — {p.enderecoBruto} — {p.feito ? "entregue" : "pendente"}
            </li>
          ))}
        </ul>
        <h3>Alertas de teste</h3>
        <ul>
          {alertasTeste.map((a) => (
            <li key={a.id}>
              {a.motivo ?? "?"} — score {a.score ?? "?"} — {new Date(a.desde).toLocaleTimeString("pt-BR")}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
