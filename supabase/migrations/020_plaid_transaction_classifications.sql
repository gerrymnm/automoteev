-- Plaid transaction classifications.
--
-- The classifier in apps/api/src/services/transaction-classifier.ts scans
-- every imported Plaid transaction and decides whether it looks vehicle-
-- relevant: fuel, insurance, lender (auto loan/lease), service, parts,
-- registration/DMV, parking/toll, or a recurring subscription.
--
-- Why a separate table instead of denormalizing onto plaid_transactions:
--   1. The classifier evolves — new merchant patterns, new heuristics.
--      Storing each run as its own row lets us re-classify everything
--      without losing history and lets us A/B confidence thresholds.
--   2. A single transaction can have multiple plausible classifications
--      (e.g. a recurring Shell charge could be fuel OR a fuel-card
--      subscription). Multiple rows let us hold candidates ranked by
--      confidence.
--   3. The user can confirm/dismiss a classification (auto_logged_at /
--      dismissed_at). Once they confirm a fuel charge, we mint a
--      fuel_entries row and link it back via fuel_entry_id.
--
-- The class column mirrors what the classifier emits — no enum yet because
-- we expect to add classes (sublease, charge_point, etc.) without schema
-- churn.

create table if not exists public.plaid_transaction_classifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_transaction_id uuid not null references public.plaid_transactions(id) on delete cascade,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  -- What the classifier thinks this is. Constant set tracked in
  -- transaction-classifier.ts; not enforced as an enum so the service can
  -- add new classes (e.g. "ev_charging", "parts_oem") without a migration.
  class text not null,
  -- 0..1 — how confident the classifier is. 1.0 reserved for exact merchant
  -- matches like "STATE FARM" or "GEICO INS"; pattern matches land in 0.4-0.8.
  confidence numeric(4,3) not null default 0.000 check (confidence >= 0 and confidence <= 1),
  -- Free-form notes the classifier emits for the audit trail and the UI
  -- ("matched MCC 5541 'service stations'", "merchant name contains 'shell'").
  reason text,
  -- Provider this charge appears to belong to. Helpful for tying a State Farm
  -- charge to the user's insurance_accounts.carrier_name or a Chase Auto
  -- ACH to loan_lease_accounts.lender_name.
  matched_provider_id uuid references public.providers(id) on delete set null,
  matched_provider_name text,
  -- For subscription class: lets us suggest the user add it to renewable_items.
  is_recurring boolean not null default false,
  -- User actions on this classification:
  --   confirmed_at  -> user accepted; we may have logged a fuel_entry or
  --                    updated an insurance/loan record. fuel_entry_id
  --                    populated when the classifier minted one.
  --   dismissed_at  -> user said "no, this isn't a car charge"; we won't
  --                    surface it again.
  -- Both null = pending user review (lives on the Home Needs You stack).
  confirmed_at timestamptz,
  dismissed_at timestamptz,
  fuel_entry_id uuid references public.fuel_entries(id) on delete set null,
  -- Keep the raw classifier output for debugging when something looks wrong.
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The classifier writes one row per transaction per class. Re-running the
-- classifier upserts on (plaid_transaction_id, class) so the same charge
-- never produces duplicates.
create unique index if not exists ux_classifications_txn_class
  on public.plaid_transaction_classifications(plaid_transaction_id, class);

create index if not exists idx_classifications_user_class
  on public.plaid_transaction_classifications(user_id, class);

-- Pending classifications power the Home Needs You panel.
-- Partial index so we only pay the storage for the rows we actually scan.
create index if not exists idx_classifications_pending
  on public.plaid_transaction_classifications(user_id, created_at desc)
  where confirmed_at is null and dismissed_at is null;

alter table public.plaid_transaction_classifications enable row level security;

create policy "classifications_owner_all"
  on public.plaid_transaction_classifications
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop trigger if exists classifications_updated_at on public.plaid_transaction_classifications;
create trigger classifications_updated_at
  before update on public.plaid_transaction_classifications
  for each row execute function public.set_updated_at();
