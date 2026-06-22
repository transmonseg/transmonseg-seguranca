"use client";

import { useEffect, useState } from "react";

export default function RelogioAoVivo() {
  const [hora, setHora] = useState<string | null>(null);
  const [data, setData] = useState<string | null>(null);

  useEffect(() => {
    function atualizar() {
      const agora = new Date();
      setHora(
        agora.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      );
      setData(
        agora.toLocaleDateString("pt-BR", {
          weekday: "short",
          day: "2-digit",
          month: "short",
        })
      );
    }
    atualizar();
    const id = setInterval(atualizar, 1000);
    return () => clearInterval(id);
  }, []);

  if (!hora) return null;

  return (
    <div className="text-right">
      <p
        className="num-mono text-base font-semibold leading-none tracking-tight"
        style={{ color: "var(--text)", fontFamily: "var(--font-geist-mono, monospace)" }}
      >
        {hora}
      </p>
      <p
        className="text-xs leading-none mt-0.5 capitalize"
        style={{ color: "var(--text-muted)" }}
      >
        {data}
      </p>
    </div>
  );
}
