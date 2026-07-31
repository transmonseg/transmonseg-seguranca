import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fixa a raiz do Turbopack neste projeto. Sem isso o Next infere a raiz
  // pelo lockfile de C:\Users\media e quebra os manifests ("Manifest file is empty").
  turbopack: {
    root: __dirname,
  },
  // Achado real 31/07 (cliente Nutry Max, romaneio quebrado na Vercel): o
  // POST /api/romaneio/upload falhava com "ReferenceError: DOMMatrix is not
  // defined" -- pdf-parse (v2) usa pdfjs-dist por baixo, que precisa de
  // @napi-rs/canvas (pacote nativo, binario pre-compilado por plataforma)
  // pra fazer polyfill de DOMMatrix/ImageData/Path2D fora do browser. Sem
  // isso listado aqui, o bundler da Vercel tentava empacotar pdf-parse
  // normalmente e falhava (o binario nativo nao pode ser inlined). Nao
  // reproduzia no Contabo (processo Node comum, sem esse empacotamento) --
  // so quebrava no ambiente serverless da Vercel, que e' onde o cliente
  // realmente usa o sistema.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  // Garante que o binario nativo (especifico da plataforma -- linux-x64-gnu
  // no build da Vercel, darwin-arm64 em dev local no Mac, etc. -- o proprio
  // `npm install` ja escolhe o certo pra plataforma que roda o install)
  // seja copiado pro artefato de deploy da rota que precisa dele.
  outputFileTracingIncludes: {
    "/api/romaneio/upload": [
      "./node_modules/pdf-parse/**/*",
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/@napi-rs/canvas*/**/*",
    ],
  },
};

export default nextConfig;
