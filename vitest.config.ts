import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // isolatedStorage snapshots the storage dir per test file; miniflare's
        // R2 sqlite WAL sidecars (*.sqlite-shm) break that diff — a known
        // upstream quirk. Storage is in-memory per run regardless, and tests
        // use unique users, so isolation isn't load-bearing here.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
    setupFiles: ["./tests/setup.ts"],
    // Test files share one in-memory D1 (isolatedStorage is off above), so
    // parallel files contend on the same sqlite — serial files keep runs
    // deterministic at the cost of a few extra seconds.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
