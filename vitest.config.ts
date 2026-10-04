import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30000,
  },
});
