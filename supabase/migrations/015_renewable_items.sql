-- ===========================================================================
-- Migration 015: renewable_items — generic tracker for things that need renewal
-- ===========================================================================
-- Driver's licenses, insurance policies, vehicle registrations, warranties
-- (basic/powertrain/extended), prepaid maintenance, gap insurance, tire
-- protection, roadside assistance, AAA / memberships, subscriptions, etc.
--
-- One generic table instead of N specific tables because adding a new
-- category shouldn't require a new schema migration. The kind column +
-- check constraint enumerates current categories; new ones get added by
-- ALTERing the constraint, not adding a table.
--
-- Existing date fields on insurance_accounts.renewal_date and
-- loan_lease_accounts.lease_maturity_date stay where they are for now.
-- A future commit can UNION them into the renewals view if we want one
-- canonical "everything that needs renewing" list.

CREATE TABLE public.renewable_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- NULL for items that aren't vehicle-specific (DL, AAA membership,
  -- subscriptions). Set on items tied to a specific vehicle (warranty,
  -- registration, prepaid maintenance plan).
  vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,

  -- What kind of renewal this is. Drives icon, default reminder lead time,
  -- which "act on it" CTAs we surface, and category-level autonomy gates.
  kind TEXT NOT NULL,

  -- User-facing label. Defaults to a kind-derived value but the user can
  -- override (e.g., "Tesla bumper-to-bumper" vs "Honda factory warranty").
  label TEXT NOT NULL,

  -- Separate from `label` because we may want to dispatch outreach to this
  -- provider in the future (renew or shop replacement). e.g., "State Farm".
  provider_name TEXT,

  -- Encrypted at the app layer — same pattern as
  -- insurance_accounts.policy_number_encrypted.
  policy_number_encrypted TEXT,

  -- The renewal/expiration moment. At least one of expires_at /
  -- expires_at_mileage must be non-null. Some warranties expire whichever
  -- comes first, so both can be set.
  expires_at DATE,
  expires_at_mileage INTEGER,

  -- TRUE for things that auto-renew if you do nothing (insurance, AAA,
  -- streaming subscription). FALSE for things that LAPSE if you do
  -- nothing (DL, registration, one-time-paid extended warranty).
  auto_renews BOOLEAN NOT NULL DEFAULT FALSE,

  -- Optional cost data. Powers cost-profile and "savings on the table" math.
  cost_cents INTEGER,
  cost_period TEXT,

  -- How many days before expiration the agent surfaces a reminder card.
  -- 30 default; insurance shopping wants 45+, DL renewal can be 60+,
  -- subscriptions 7.
  reminder_days_before INTEGER NOT NULL DEFAULT 30,

  -- "Not now" snooze. Same pattern as dismissed_insights: when set, the
  -- item is hidden from the home stack until this timestamp passes.
  dismissed_until TIMESTAMPTZ,

  -- Provenance: when this row was created from a document extraction
  -- (e.g., DL upload populating the expiration date), keep the link so
  -- we can trace back / re-extract / re-apply.
  source_document_id UUID REFERENCES public.uploaded_documents(id) ON DELETE SET NULL,

  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One of the two expiration columns must be set, otherwise this row
  -- can't drive a reminder.
  CONSTRAINT renewable_items_has_expiration CHECK (
    expires_at IS NOT NULL OR expires_at_mileage IS NOT NULL
  ),

  -- Enumerated kinds. Add to this list (and the constraint) as new
  -- categories appear (e.g., 'home_warranty', 'gym_membership' if those
  -- want their own surface).
  CONSTRAINT renewable_items_kind_check CHECK (kind IN (
    'drivers_license',
    'insurance_policy',
    'vehicle_registration',
    'vehicle_warranty_basic',
    'vehicle_warranty_powertrain',
    'extended_warranty',
    'prepaid_maintenance',
    'gap_insurance',
    'tire_protection',
    'roadside_assistance',
    'aaa_membership',
    'membership',
    'subscription',
    'other'
  )),

  CONSTRAINT renewable_items_period_check CHECK (
    cost_period IS NULL OR cost_period IN ('one_time', 'monthly', 'annual', 'biennial')
  )
);

-- Fast "what's expiring soon for this user" query. Covers the main UI
-- read pattern: SELECT ... WHERE user_id = ? AND expires_at < now() + 90d
-- ORDER BY expires_at ASC.
CREATE INDEX idx_renewable_items_user_expires
  ON public.renewable_items(user_id, expires_at)
  WHERE expires_at IS NOT NULL;

-- Fast per-vehicle filter (for the per-VIN renewals subview later).
CREATE INDEX idx_renewable_items_vehicle_kind
  ON public.renewable_items(vehicle_id, kind)
  WHERE vehicle_id IS NOT NULL;

-- ---------------- RLS ----------------
ALTER TABLE public.renewable_items ENABLE ROW LEVEL SECURITY;

-- Owner-only access. Wrapping auth.uid() in a SELECT inlines the call so
-- PG only evaluates it once per query rather than per row.
CREATE POLICY renewable_items_owner ON public.renewable_items
  FOR ALL
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- ---------------- updated_at trigger ----------------
CREATE OR REPLACE FUNCTION public.tg_renewable_items_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_renewable_items_updated_at
  BEFORE UPDATE ON public.renewable_items
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_renewable_items_set_updated_at();

-- ---------------- Backfill from existing DL extractions ----------------
-- Any user who already uploaded a DL has the expiration date sitting in
-- uploaded_documents.extracted_data->>'expiration_date' but it was never
-- structured. Pull those forward.
INSERT INTO public.renewable_items (
  user_id,
  vehicle_id,
  kind,
  label,
  provider_name,
  expires_at,
  auto_renews,
  source_document_id,
  reminder_days_before
)
SELECT
  d.user_id,
  NULL,                                        -- DL is user-scoped, not vehicle
  'drivers_license',
  'Driver''s License',
  CASE
    WHEN d.extracted_data->>'dl_state' IS NOT NULL
      THEN (d.extracted_data->>'dl_state') || ' DMV'
    ELSE 'DMV'
  END,
  (d.extracted_data->>'expiration_date')::DATE,
  FALSE,                                        -- DLs don't auto-renew
  d.id,
  60                                            -- DL: longer lead, often need an in-person visit
FROM public.uploaded_documents d
WHERE d.document_kind = 'drivers_license'
  AND d.extraction_status = 'completed'
  AND d.extracted_data ? 'expiration_date'
  AND (d.extracted_data->>'expiration_date') ~ '^\d{4}-\d{2}-\d{2}$'
  AND NOT EXISTS (
    SELECT 1 FROM public.renewable_items r
    WHERE r.source_document_id = d.id
  );
