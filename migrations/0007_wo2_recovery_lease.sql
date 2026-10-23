-- 0007_wo2_recovery_lease.sql — WO-2 correction: lease-owner column for the
-- recovery claim path. claimed_by records which claimant holds a 'claimed'
-- lease so claimForRecovery can distinguish a provable retry (same claimant
-- re-acquiring its own dead attempt) from an unrelated caller, which must
-- wait out the lease-exclusion window regardless of the cutoff it passes.
-- Same additive/idempotent style as 0006: duplicate-column is already-applied.
ALTER TABLE follow_ups ADD COLUMN claimed_by TEXT;  -- lease owner token (workflow instanceId); NULL = anonymous claim
