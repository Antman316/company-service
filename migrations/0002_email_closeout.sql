-- V1 closeout: real email channel support.
-- channel_address: the concrete destination a coverage row reaches (merchant
-- support email, chat/portal URL). external_id: provider-side message id
-- (SMTP Message-ID, Resend/Gmail id) for dedup + In-Reply-To threading.
ALTER TABLE company_coverage ADD COLUMN channel_address TEXT;
ALTER TABLE external_messages ADD COLUMN external_id TEXT;
CREATE INDEX idx_messages_external_id ON external_messages(external_id);
