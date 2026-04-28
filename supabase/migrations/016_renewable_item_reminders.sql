-- ===========================================================================
-- Migration 016: renewable_item_reminders — dedupe push notifications
-- ===========================================================================
-- Surfacing renewal cards on Home is idempotent (we just compute "is this
-- due_soon?" on every fetch), but push notifications are not — sending the
-- same "AAA expires in 30 days" push twice in one day is annoying, and
-- sending it every cron tick for a week is unforgivable.
--
-- This table records that we sent a push for a given (item, threshold)
-- pair so the daily cron can skip ones we've already notified on. The
-- thresholds we fire at are 30/14/7/1 days before expiration, plus a
-- one-shot on the day of expiration itself.
--
-- Cleanup: rows for past expirations stay around as audit (the table is
-- tiny — at most ~5 rows per item). Deleting the renewable_items row
-- cascades and removes its reminder log via FK.

CREATE TABLE public.renewable_item_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  renewable_item_id UUID NOT NULL REFERENCES public.renewable_items(id) ON DELETE CASCADE,

  -- Which threshold we fired at: 30, 14, 7, 1, or 0 (day-of-expiration).
  -- Stored as days-before so the cron's "should we send for this item now"
  -- check is a simple equality on the current days_until value.
  threshold_days INTEGER NOT NULL,

  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Carry the title/body we sent so a future "your reminder history"
  -- view doesn't have to recompute it.
  notification_title TEXT,
  notification_body TEXT,

  CONSTRAINT renewable_item_reminders_threshold_check
    CHECK (threshold_days IN (30, 14, 7, 1, 0)),

  -- Hard dedupe: at most one reminder row per (item, threshold). Prevents
  -- two cron runs in the same minute from racing into a double-send.
  CONSTRAINT renewable_item_reminders_unique_threshold
    UNIQUE (renewable_item_id, threshold_days)
);

-- Read pattern: "for this user's items, which thresholds have we already
-- fired?" — the cron queries this in bulk per user.
CREATE INDEX idx_renewable_item_reminders_user
  ON public.renewable_item_reminders(user_id, sent_at DESC);

-- ---------------- RLS ----------------
ALTER TABLE public.renewable_item_reminders ENABLE ROW LEVEL SECURITY;

-- Owner-only access. Inlining auth.uid() per the perf advisor pattern.
CREATE POLICY renewable_item_reminders_owner ON public.renewable_item_reminders
  FOR ALL
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
