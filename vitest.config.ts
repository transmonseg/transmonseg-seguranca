import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Ate 23/08 o projeto rodava vitest sem config nenhuma, e por isso os testes
// de rota so' conseguiam importar modulos "@/..." que eles proprios
// mockavam -- qualquer import real com esse prefixo estourava
// "Cannot find package '@/...'". Isso empurrava codigo compartilhado pra ser
// duplicado dentro da rota (ou mockado no teste, que e' pior: o teste passa
// a validar o mock em vez da regra).
//
// So' o alias, de proposito: nada de mexer em include/environment pra nao
// mudar quais arquivos de teste o vitest acha hoje (os .test.ts de src e os
// .test.mjs de scripts continuam iguais). Espelha o "@/*": ["./src/*"] do
// tsconfig.json -- se um dia mudar la, muda aqui.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
