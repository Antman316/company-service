// Static SPA bundle map.
//
// This stub is COMMITTED so a clean checkout compiles without any generation
// step. During deploy, `node scripts/gen-static.mjs` overwrites this file with
// the real inlined assets (part of `npm run deploy`). Do not commit the
// regenerated output — it is ~370 KB of base64 and changes every build.
export const STATIC_FILES: Record<string, { type: string; body: string }> = {};
