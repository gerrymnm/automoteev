-- Spec alignment: 17 changes agreed 2026-04-24
-- Already applied to project euouyaarpowxpmbyzxmk on 2026-04-24.
-- Safe to re-run (idempotent with IF NOT EXISTS / DROP IF EXISTS guards).

-- 1. Autonomy gate state + per-user agent email alias
alter table public.profiles
  add column if not exists approved_email_count int not null default 0,
  add column if not exists autonomy_unlocked_at timestamptz,
  add column if not exists agent_email_local text,
  add column if not exists agent_email_domain text not null default 'mail.automoteev.com';

create unique index if not exists profiles_agent_email_local_uq
  on public.profiles (agent_email_local)
  where agent_email_local is not null;

-- 2. Loan amortization inputs
alter table public.loan_lease_accounts
  add column if not exists principal_cents int,
  add column if not exists term_months int,
  add column if not exists start_date date,
  add column if not exists first_payment_date date,
  add column if not exists rate_type text check (rate_type in ('fixed','variable'));

-- 3. Subscriptions table (Stripe + IAP)
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade unique,
  source text not null check (source in ('stripe','apple','google')),
  status text not null check (status in ('active','trialing','past_due','canceled','expired')),
  plan text not null check (plan in ('pro_monthly','pro_annual')),
  current_period_end timestamptz,
  external_subscription_id text,
  external_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists "subs_owner_select" on public.subscriptions;
create policy "subs_owner_select" on public.subscriptions for select using (auth.uid() = user_id);

drop trigger if exists subscriptions_updated_at on public.subscriptions;
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- 4. Maintenance items (schedule + completed events)
create table if not exists public.maintenance_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  item_type text not null,
  due_mileage int,
  due_date date,
  interval_miles int,
  interval_months int,
  last_performed_mileage int,
  last_performed_date date,
  status text not null default 'upcoming' check (status in ('upcoming','due','overdue','completed','skipped')),
  estimated_cost_cents int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.maintenance_items enable row level security;
drop policy if exists "maint_owner_all" on public.maintenance_items;
create policy "maint_owner_all" on public.maintenance_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists maintenance_items_updated_at on public.maintenance_items;
create trigger maintenance_items_updated_at before update on public.maintenance_items
  for each row execute function public.set_updated_at();

-- 5. Recalls history (NHTSA cron dedupe)
create table if not exists public.recalls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  nhtsa_campaign_id text not null,
  summary text,
  component text,
  consequence text,
  remedy text,
  reported_at date,
  resolved_at timestamptz,
  unique (vehicle_id, nhtsa_campaign_id)
);
alter table public.recalls enable row level security;
drop policy if exists "recalls_owner_all" on public.recalls;
create policy "recalls_owner_all" on public.recalls for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 6. task_emails: direction + threading + inbound metadata
alter table public.task_emails
  add column if not exists direction text not null default 'outbound'
    check (direction in ('outbound','inbound')),
  add column if not exists thread_id text,
  add column if not exists in_reply_to text,
  add column if not exists received_at timestamptz;

-- 7. user_pii (just-in-time, encrypted at rest by API layer)
create table if not exists public.user_pii (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone_encrypted text,
  street_address_encrypted text,
  city text,
  state text,
  dl_number_encrypted text,
  dl_state text,
  dl_collected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_pii enable row level security;
drop policy if exists "pii_owner_all" on public.user_pii;
create policy "pii_owner_all" on public.user_pii for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists user_pii_updated_at on public.user_pii;
create trigger user_pii_updated_at before update on public.user_pii
  for each row execute function public.set_updated_at();

-- 8. Onboarding nudge tracking (re-prompt cadence for skipped fields)
create table if not exists public.onboarding_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  field_name text not null,
  last_prompted_at timestamptz,
  prompt_count int not null default 0,
  dismissed boolean not null default false,
  completed boolean not null default false,
  unique (user_id, field_name)
);
alter table public.onboarding_prompts enable row level security;
drop policy if exists "onboarding_owner_all" on public.onboarding_prompts;
create policy "onboarding_owner_all" on public.onboarding_prompts for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 9. Insurance coverage detail (needed for apples-to-apples quote shopping)
alter table public.insurance_accounts
  add column if not exists coverage_type text
    check (coverage_type in ('liability','full','comprehensive','unknown')),
  add column if not exists deductible_cents int,
  add column if not exists liability_limits text,
  add column if not exists policy_number_encrypted text;

-- 10. Email deliverability events (Resend webhooks)
create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  task_email_id uuid references public.task_emails(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);
alter table public.email_events enable row level security;
drop policy if exists "email_events_owner_select" on public.email_events;
create policy "email_events_owner_select" on public.email_events for select
  using (
    exists (
      select 1 from public.task_emails te
      where te.id = email_events.task_email_id
        and te.user_id = auth.uid()
    )
  );
create index if not exists email_events_task_email_idx
  on public.email_events(task_email_id);

-- 11. Legal acceptance (TOS, privacy, autonomy consent)
create table if not exists public.user_agreements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agreement_type text not null
    check (agreement_type in ('tos','privacy','autonomy_consent')),
  version text not null,
  accepted_at timestamptz not null default now()
);
alter table public.user_agreements enable row level security;
drop policy if exists "agreements_owner_all" on public.user_agreements;
create policy "agreements_owner_all" on public.user_agreements for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 12. OBD reservation
create table if not exists public.obd_reservations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reserved_at timestamptz not null default now(),
  shipping_status text not null default 'reserved'
    check (shipping_status in ('reserved','queued','shipped','delivered','returned')),
  shipped_at timestamptz,
  tracking_number text
);
alter table public.obd_reservations enable row level security;
drop policy if exists "obd_owner_all" on public.obd_reservations;
create policy "obd_owner_all" on public.obd_reservations for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 13. OBD readings history
create table if not exists public.obd_readings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  reading_at timestamptz not null default now(),
  mileage int,
  dtc_codes text[] not null default '{}',
  battery_voltage numeric,
  raw_payload jsonb
);
alter table public.obd_readings enable row level security;
drop policy if exists "obd_readings_owner_all" on public.obd_readings;
create policy "obd_readings_owner_all" on public.obd_readings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 14. VIN format constraint (17-char, excludes I/O/Q)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vin_format') then
    alter table public.vehicles
      add constraint vin_format check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$');
  end if;
end $$;

-- 15. document_type whitelist
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_type_valid') then
    alter table public.documents
      add constraint document_type_valid check (document_type in
        ('loan_contract','insurance_dec','insurance_card','registration','title','photo','other'));
  end if;
end $$;

-- 16. Indexes for hot query paths
create index if not exists recalls_open_idx
  on public.recalls(vehicle_id) where resolved_at is null;
create index if not exists maintenance_due_idx
  on public.maintenance_items(user_id, status)
  where status in ('due','overdue');
create index if not exists task_emails_thread_idx
  on public.task_emails(thread_id);
create index if not exists subscriptions_user_status_idx
  on public.subscriptions(user_id, status);
create index if not exists onboarding_prompts_user_idx
  on public.onboarding_prompts(user_id, completed, dismissed);

-- 17. Hardening: stable search_path on set_updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
