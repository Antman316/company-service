// Augment the generated Env with bindings that are provisioned outside
// wrangler.jsonc vars (secrets) or that tests mock.
interface Env {
  /** Cloudflare secret used to encrypt connection credentials at rest. */
  SECRET_KEY?: string;
}
