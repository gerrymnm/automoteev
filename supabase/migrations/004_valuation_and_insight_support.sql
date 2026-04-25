-- Migration 004: vehicle valuation columns + a couple of supporting tables/columns
-- for the always-something-to-show insight engine. Applied 2026-04-24.

-- 1. Vehicle valuation
alter table public.vehicles add column if not exists market_value_low_cents bigint;
alter table public.vehicles add column if not exists market_value_high_cents bigint;
alter table public.vehicles add column if not exists dealer_value_low_cents bigint;
alter table public.vehicles add column if not exists dealer_value_high_cents bigint;
alter table public.vehicles add column if not exists value_estimated_at timestamptz;

-- 2. Preferred provider flag
alter table public.providers add column if not exists is_preferred boolean not null default false;

-- 3. Fuel log
create table if not exists public.fuel_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  entry_date date not null,
  gallons numeric(7,3),
  total_cents bigint not null,
  odometer_miles integer,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists fuel_entries_vehicle_idx on public.fuel_entries(vehicle_id, entry_date desc);
create index if not exists fuel_entries_user_idx on public.fuel_entries(user_id, entry_date desc);
alter table public.fuel_entries enable row level security;
drop policy if exists fuel_entries_owner_all on public.fuel_entries;
create policy fuel_entries_owner_all on public.fuel_entries
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 4. Insurance shopping cadence
alter table public.insurance_accounts add column if not exists last_shopped_at timestamptz;
