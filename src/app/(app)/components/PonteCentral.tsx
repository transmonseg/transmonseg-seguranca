"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Central Transmonseg (05/10): aberto dentro da Central, avisa em que página
// está pra barra de endereço da Central acompanhar. Fora da Central, nada.
const ORIGENS_CENTRAL = ["https://central.transmonseg.com.br", "https://kpi.transmonseg.com.br"];

function Ponte() {
  const pathname = usePathname() ?? "/";
  const busca = useSearchParams()?.toString() ?? "";
  useEffect(() => {
    if (window.self === window.top) return;
    const msg = { fonte: "monitoramento", tipo: "rota", caminho: pathname + (busca ? `?${busca}` : ""), titulo: document.title };
    for (const o of ORIGENS_CENTRAL) window.parent.postMessage(msg, o);
  }, [pathname, busca]);
  return null;
}

export default function PonteCentral() {
  return (
    <Suspense fallback={null}>
      <Ponte />
    </Suspense>
  );
}
