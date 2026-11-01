import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeAll } from "vitest";

// @cloudflare/vitest-plugin types `env` as Cloudflare.Env (generated from
// wrangler.jsonc). The test-only bindings from wrangler.test.jsonc and the
// secrets the suites read are declared here so the suites type-check.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      INBOUND_ADDRESS?: string;
      SECRET_KEY?: string;
    }
  }
}

// Apply every migration to the local (miniflare) D1 once per suite.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
