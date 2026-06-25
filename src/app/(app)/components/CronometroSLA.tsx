"use client";

import { useEffect, useState } from "react";

function minutosDecorridos(desde: string): number {
  return Math.floor((Date.now() - new Date(desde).getTime()) / 60000);
}

export default function CronometroSLA({ desde }: { desde: string }) {
  const [minutos, setMinutos] = useState(() => minutosDecorridos(desde));

  useEffect(() => {
    const id = setInterval(() => setMinutos(minutosDecorridos(desde)), 30_000);
    return () => clearInterval(id);
  }, [desde]);

  let label: string;
  let cor: string;
  let pulsar = false;

  if (minutos < 5) {
    label = `GR0 · ${minutos}min`;
    cor = "#64748b";
  } else if (minutos < 15) {
    label = `GR1 · ${minutos}min · Escalar supervisor`;
    cor = "#f97316";
  } else {
    label = `GR2 · ${minutos}min · Escalar cliente`;
    cor = "#ef4444";
    pulsar = true;
  }

  return (
    <span
      className={pulsar ? "animate-pulse" : ""}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        fontWeight: 700,
        padding: "2px 7px",
        borderRadius: 6,
        backgroundColor: cor + "18",
        border: `1px solid ${cor}44`,
        color: cor,
        fontFamily: "var(--font-geist-mono, monospace)",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}
