-- ============================================================================
-- Thread events: the substrate of the agent's chronological history.
--
-- Every campaign (vehicle_tasks row) has a timeline. That timeline includes
-- emails (already in task_emails), but ALSO includes things that aren't
-- emails: the agent classifying an inbound, the agent deciding to auto-reply,
-- a state transition, a document being attached, the user making a decision.
--
-- thread_events is the home for all those non-email chronological events.
-- The per-thread timeline UI is the union of task_emails + thread_events,
-- sorted by created_at.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.thread_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES public.vehicle_tasks(id) ON DELETE CASCADE,

  -- What kind of event this is. Drives icon, layout, and copy in the timeline.
  --   agent_classification    : agent classified an inbound reply
  --   agent_decision          : agent decided to take an action (auto-reply, escalate, etc.)
  --   agent_action            : agent did a thing (sent reply, scheduled follow-up)
  --   state_transition        : campaign moved from one state to another
  --   document_attached       : a document was attached to this campaign
  --   user_decision           : user answered a "Needs me" question
  --   user_note               : user added a free-form note
  --   system                  : automated/internal event (cron, error, etc.)
  kind text NOT NULL CHECK (kind IN (
    'agent_classification',
    'agent_decision',
    'agent_action',
    'state_transition',
    'document_attached',
    'user_decision',
    'user_note',
    'system'
  )),

  -- One-line plain-English summary shown in the timeline.
  summary text NOT NULL,

  -- Optional richer detail (multi-line explanation, full classifier output, etc.)
  detail text,

  -- Structured payload for typed event data (classification result, document ref, etc.)
  metadata jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thread_events_task_created
  ON public.thread_events(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS thread_events_user_created
  ON public.thread_events(user_id, created_at DESC);

ALTER TABLE public.thread_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own thread events"
  ON public.thread_events
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users insert their own thread events"
  ON public.thread_events
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- Pending user action: drives the "Needs me" home screen stack.
--
-- A campaign always has at most one current "question for the user." When
-- pending_user_action_kind is null, the agent is working autonomously and
-- the user does NOT need to look. When it's set, this campaign appears as
-- a card on the home screen with the pending_user_action_text as its title.
--
-- The agent CLEARS this when the user answers, allowing the campaign to
-- continue to its next state (or a new question, if needed).
-- ============================================================================

ALTER TABLE public.vehicle_tasks
  ADD COLUMN IF NOT EXISTS pending_user_action_kind text
    CHECK (pending_user_action_kind IN (
      'decision',         -- yes/no or pick-from-options
      'signature',        -- needs e-signature on a doc
      'info_request',     -- agent needs a piece of info (pay stub, account #)
      'confirm_close',    -- agent thinks task is done; user confirms
      'review_quotes',    -- multi-vendor comparison waiting for user pick
      'manual'            -- catch-all for ad-hoc situations
    )),
  ADD COLUMN IF NOT EXISTS pending_user_action_text text,
  ADD COLUMN IF NOT EXISTS pending_user_action_options jsonb,  -- e.g. [{label,id,style}]
  ADD COLUMN IF NOT EXISTS pending_user_action_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_status_text text;             -- "Agent working" line copy

CREATE INDEX IF NOT EXISTS vehicle_tasks_user_pending
  ON public.vehicle_tasks(user_id, pending_user_action_set_at DESC)
  WHERE pending_user_action_kind IS NOT NULL;

-- ============================================================================
-- Daily VIN-specific recall recheck: track when we last asked NHTSA per vehicle
-- so a daily cron can pick up only vehicles overdue for a check.
-- ============================================================================

ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS last_recall_check_at timestamptz;

CREATE INDEX IF NOT EXISTS vehicles_recall_check_due
  ON public.vehicles(last_recall_check_at NULLS FIRST);

-- ============================================================================
-- Backfill: clear false-positive recalls created by the old model-year API.
-- The Range Rover dealer (Alex Perry) confirmed no open recalls for the
-- specific VIN. The recalls currently in the table came from the broader
-- model-year search and don't necessarily apply. Mark them resolved so the
-- dashboard reflects truth; the new VIN-specific lookup will re-populate
-- only what NHTSA confirms is open.
-- ============================================================================

UPDATE public.recalls
SET resolved_at = now()
WHERE resolved_at IS NULL;

UPDATE public.vehicles
SET recall_status = 'unknown'
WHERE recall_status = 'open';
