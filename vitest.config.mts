import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/**/*.d.ts"] },
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Migrations + module catalogue seed on the test database, once per run.
          globalSetup: ["tests/global-setup.ts"],
          // Empties tenant data before every test.
          setupFiles: ["tests/helpers/integration-setup.ts"],
          // All integration files share one database: run them one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
