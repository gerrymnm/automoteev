-- ===========================================================================
-- Migration 012: dismissed insights ("Not now" persistence)
-- ===========================================================================
-- Synthetic insight cards on Home need a way for the user to say "not now"
-- without committing to action. Until now the only CTA on a recommendation
-- card was "Approve & contact providers" — no escape valve. This table
-- persists per-user dismissals with a TTL so dismissed cards stay hidden
-- for a while but eventually re-surface (the underlying problem may still
-- be worth flagging weeks later).
--
-- Real `needs_user_approval` tasks already have a cancel path via
-- /api/tasks/:id/approval { approved: false } → status = 'cancelled'.
-- This table is ONLY for synthetic insight-driven cards (no task_id yet).

CREATE TABLE public.dismissed_insights (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vehicle_id UUID NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  insight_key TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ DEFAULT NOW(),
  dismissed_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, vehicle_id, insight_key)
);

CREATE INDEX idx_dismissed_insights_active
  ON public.dismissed_insights(user_id, vehicle_id, dismissed_until);

-- RLS: a user can read/insert/delete only their own dismissals.
ALTER TABLE public.dismissed_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own dismissals"
  ON public.dismissed_insights FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users insert own dismissals"
  ON public.dismissed_insights FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users update own dismissals"
  ON public.dismissed_insights FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users delete own dismissals"
  ON public.dismissed_insights FOR DELETE
  USING (auth.uid() = user_id);
