import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fixa a raiz do Turbopack neste projeto. Sem isso o Next infere a raiz
  // pelo lockfile de C:\Users\media e quebra os manifests ("Manifest file is empty").
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
