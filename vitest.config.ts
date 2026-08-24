import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Los tests nunca deben pegarle a ABSA net real: todo el HTTP se mockea
    // con nock. Si algo intenta salir a la red de verdad, mejor que falle
    // ruidosamente en vez de pegarle por accidente a produccion.
    testTimeout: 10_000,
  },
});
