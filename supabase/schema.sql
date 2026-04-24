create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  zip_code text not null,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vin text not null,
  year int,
  make text,
  model text,
  trim text,
  mileage int not null check (mileage >= 0),
  ownership_type text not null check (ownership_type in ('owned', 'financed', 'leased')),
  estimated_value_cents int,
  overall_status text not null default 'action_recommended' check (overall_status in ('all_good', 'action_recommended', 'action_needed')),
  next_service_due_miles int,
  recall_status text default 'unknown',
  last_obd_sync_at timestamptz,
  obd_mileage int,
  diagnostic_codes text[],
  battery_status text,
  service_prediction text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, vin)
);

create table public.vehicle_cost_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade unique,
  monthly_payment_cents int,
  insurance_premium_cents int,
  maintenance_monthly_cents int,
  total_monthly_cost_cents int,
  annual_cost_cents int,
  missing_fields text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.loan_lease_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade unique,
  lender_name text,
  apr_bps int,
  balance_cents int,
  monthly_payment_cents int,
  lease_maturity_date date,
  encrypted_account_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.insurance_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade unique,
  carrier_name text,
  premium_cents int,
  renewal_date date,
  encrypted_policy_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vehicle_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  alert_type text not null,
  severity text not null check (severity in ('info', 'recommended', 'urgent')),
  title text not null,
  body text not null,
  is_resolved boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.providers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  provider_type text not null,
  location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vehicle_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  task_type text not null,
  title text not null,
  description text,
  status text not null default 'created' check (status in ('created', 'needs_user_approval', 'approved', 'in_progress', 'waiting_on_provider', 'completed', 'cancelled', 'failed')),
  approval_summary text,
  external_contacts text[] not null default '{}',
  shared_fields text[] not null default '{}',
  approved_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.vehicle_tasks(id) on delete cascade,
  provider_id uuid references public.providers(id) on delete set null,
  to_email text not null,
  from_email text not null,
  subject text not null,
  body_text text not null,
  status text not null,
  provider_message_id text,
  created_at timestamptz not null default now()
);

create table public.task_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.vehicle_tasks(id) on delete cascade,
  vehicle_id uuid references public.vehicles(id) on delete cascade,
  event_type text not null,
  summary text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.vehicle_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  event_type text not null,
  summary text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid references public.vehicles(id) on delete cascade,
  task_id uuid references public.vehicle_tasks(id) on delete set null,
  storage_path text not null,
  document_type text not null,
  created_at timestamptz not null default now()
);

create index on public.vehicles(user_id);
create index on public.vehicle_alerts(user_id, is_resolved);
create index on public.vehicle_tasks(user_id, status);
create index on public.task_audit_logs(user_id, task_id);
create index on public.task_emails(user_id, task_id);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles',
    'vehicles',
    'vehicle_cost_profiles',
    'loan_lease_accounts',
    'insurance_accounts',
    'vehicle_alerts',
    'providers',
    'vehicle_tasks',
    'task_emails',
    'task_audit_logs',
    'vehicle_events',
    'documents'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end $$;

create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "vehicles_select_own" on public.vehicles for select using (auth.uid() = user_id);
create policy "vehicles_insert_own" on public.vehicles for insert with check (auth.uid() = user_id);
create policy "vehicles_update_own" on public.vehicles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "vehicles_delete_own" on public.vehicles for delete using (auth.uid() = user_id);

create policy "vehicle_cost_profiles_owner_all" on public.vehicle_cost_profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "loan_lease_accounts_owner_all" on public.loan_lease_accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "insurance_accounts_owner_all" on public.insurance_accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "vehicle_alerts_owner_all" on public.vehicle_alerts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "providers_owner_all" on public.providers for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "vehicle_tasks_owner_all" on public.vehicle_tasks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "task_emails_owner_all" on public.task_emails for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "task_audit_logs_owner_select" on public.task_audit_logs for select using (auth.uid() = user_id);
create policy "task_audit_logs_owner_insert" on public.task_audit_logs for insert with check (auth.uid() = user_id);
create policy "vehicle_events_owner_all" on public.vehicle_events for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "documents_owner_all" on public.documents for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger vehicles_updated_at before update on public.vehicles for each row execute function public.set_updated_at();
create trigger vehicle_cost_profiles_updated_at before update on public.vehicle_cost_profiles for each row execute function public.set_updated_at();
create trigger loan_lease_accounts_updated_at before update on public.loan_lease_accounts for each row execute function public.set_updated_at();
create trigger insurance_accounts_updated_at before update on public.insurance_accounts for each row execute function public.set_updated_at();
create trigger providers_updated_at before update on public.providers for each row execute function public.set_updated_at();
create trigger vehicle_tasks_updated_at before update on public.vehicle_tasks for each row execute function public.set_updated_at();
