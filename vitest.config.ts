import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      // isolatedStorage snapshots the storage dir per test file; miniflare's
      // R2 sqlite WAL sidecars (*.sqlite-shm) break that diff — a known
      // upstream quirk. Keep this test-only storage shared; suites that
      // assert initial seed state reset their own directory fixtures.
      isolatedStorage: false,
      // This pool needs singleWorker to serialize files sharing D1;
      // fileParallelism alone still allows overlapping global sweeps.
      singleWorker: true,
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Test files share one in-memory D1 (isolatedStorage is off above), so
    // parallel files contend on the same sqlite — serial files keep runs
    // deterministic at the cost of a few extra seconds.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
