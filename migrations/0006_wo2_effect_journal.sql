-- 0006_wo2_effect_journal.sql — WO-2 claim/effect failure-recovery ledger.
-- Same additive/idempotent style as 0004: ALTER ADD COLUMN is treated as
-- already-applied on duplicate-column, and each file applies once.
-- effect_state tracks the post-claim lifecycle separately from status so a
-- crashed/failed/unknown send is never indistinguishable from a completed one.
ALTER TABLE follow_ups ADD COLUMN effect_state TEXT;  -- claimed | attempted | accepted | unknown | reconciled | dismissed; NULL = pre-ledger row
ALTER TABLE follow_ups ADD COLUMN effect_at TEXT;     -- when the current effect_state was stamped (lease timestamp)
ALTER TABLE follow_ups ADD COLUMN effect_note TEXT;   -- idempotency key, receipt id, error or dismissal reason
