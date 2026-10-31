import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { signup, createTestCase, grantMandate, dbOne } from "./helpers";
import { scheduleFollowUp, markFired } from "../src/core/followups";

// WO-1 / AT-1 (pm-delivery-activation-1-cafcs_pm): PDP v0.3 line 174 notes the
// shipped claim test is sequential. This exercises N>=4 overlapping markFired
// attempts against ONE pending row and asserts exactly-once claim semantics,
// repeated on a second independent row to rule out row-specific luck.
describe("WO-1 same-ledger concurrent claim", () => {
  it.each(["wo1a@test.local", "wo1b@test.local"])(
    "8 overlapping markFired attempts yield exactly one winner (%s)",
    async (email) => {
      const c = await signup(email);
      const caseId = await createTestCase(c, `wo1 concurrent claim ${email}`);
      await grantMandate(c, caseId);
      const fupId = await scheduleFollowUp(
        env.DB,
        caseId,
        "first_contact",
        new Date(Date.now() - 1000).toISOString(),
        { via: "wo1-concurrency-test" },
      );

      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => markFired(env.DB, fupId)),
      );
      const winners = results.filter(Boolean).length;
      expect(winners).toBe(1);
      expect(results.filter((r) => !r).length).toBe(N - 1);

      const row = await dbOne<{ status: string; attempt: number }>(
        `SELECT status, attempt FROM follow_ups WHERE id = ?`,
        fupId,
      );
      expect(row?.status).toBe("fired");
      // Only the single winning statement may have incremented attempt.
      expect(row?.attempt).toBe(1);
    },
  );

  it("losers re-claiming after the win still observe 0 changed rows", async () => {
    const c = await signup("wo1c@test.local");
    const caseId = await createTestCase(c, "wo1 post-claim losers");
    await grantMandate(c, caseId);
    const fupId = await scheduleFollowUp(
      env.DB,
      caseId,
      "first_contact",
      new Date(Date.now() - 1000).toISOString(),
      { via: "wo1-concurrency-test" },
    );
    expect(await markFired(env.DB, fupId)).toBe(true);
    const retries = await Promise.all(
      Array.from({ length: 6 }, () => markFired(env.DB, fupId)),
    );
    expect(retries.every((r) => r === false)).toBe(true);
    const row = await dbOne<{ attempt: number }>(
      `SELECT attempt FROM follow_ups WHERE id = ?`,
      fupId,
    );
    expect(row?.attempt).toBe(1);
  });
});
