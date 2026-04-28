-- Inbound dealer replies don't always carry an In-Reply-To header (some
-- dealers click "compose new" or use CRMs that strip headers). When that
-- happens we still want to STORE the reply with task_id=null so it's
-- visible to the user; the webhook then attempts a fallback match by
-- sender domain to backfill the link.
--
-- Also relaxes the constraint so manual inbound entries (e.g., user
-- forwarding a reply) don't bounce off the schema.

ALTER TABLE public.task_emails ALTER COLUMN task_id DROP NOT NULL;

-- Useful index for the new fallback matching strategy: find most recent
-- outbound emails by sender domain quickly.
CREATE INDEX IF NOT EXISTS task_emails_user_direction_created
  ON public.task_emails(user_id, direction, created_at DESC);
