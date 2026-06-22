"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Atualiza a tela sozinha: revalida os dados do servidor a cada N segundos,
// sem o operador precisar dar refresh. (Tempo real via Realtime virá na fase de Auth.)
export default function AutoRefresh({ segundos = 30 }: { segundos?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), segundos * 1000);
    return () => clearInterval(id);
  }, [router, segundos]);
  return null;
}
