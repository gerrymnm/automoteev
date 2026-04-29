-- Plaid Transactions Sync foundation.
-- Access tokens are encrypted server-side before storage. Raw Plaid payloads
-- are retained for later categorization and debugging, scoped by user_id.

create table if not exists public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_item_id text not null unique,
  access_token_encrypted text not null,
  institution_id text,
  institution_name text,
  products text[] not null default '{}',
  transactions_cursor text,
  status text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  last_synced_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plaid_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_item_id uuid not null references public.plaid_items(id) on delete cascade,
  plaid_account_id text not null unique,
  name text not null,
  official_name text,
  type text not null,
  subtype text,
  mask text,
  current_balance_cents int,
  available_balance_cents int,
  iso_currency_code text,
  raw jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plaid_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_item_id uuid not null references public.plaid_items(id) on delete cascade,
  plaid_account_id uuid references public.plaid_accounts(id) on delete set null,
  plaid_transaction_id text not null unique,
  name text not null,
  merchant_name text,
  amount_cents int not null,
  iso_currency_code text,
  date date not null,
  authorized_date date,
  category text[],
  payment_channel text,
  pending boolean not null default false,
  removed_at timestamptz,
  raw jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_plaid_items_user on public.plaid_items(user_id);
create index if not exists idx_plaid_accounts_user on public.plaid_accounts(user_id);
create index if not exists idx_plaid_transactions_user_date
  on public.plaid_transactions(user_id, date desc);
create index if not exists idx_plaid_transactions_merchant
  on public.plaid_transactions(user_id, merchant_name);

alter table public.plaid_items enable row level security;
alter table public.plaid_accounts enable row level security;
alter table public.plaid_transactions enable row level security;

create policy "plaid_items_owner_all"
  on public.plaid_items
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "plaid_accounts_owner_all"
  on public.plaid_accounts
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "plaid_transactions_owner_all"
  on public.plaid_transactions
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop trigger if exists plaid_items_updated_at on public.plaid_items;
create trigger plaid_items_updated_at
  before update on public.plaid_items
  for each row execute function public.set_updated_at();

drop trigger if exists plaid_accounts_updated_at on public.plaid_accounts;
create trigger plaid_accounts_updated_at
  before update on public.plaid_accounts
  for each row execute function public.set_updated_at();

drop trigger if exists plaid_transactions_updated_at on public.plaid_transactions;
create trigger plaid_transactions_updated_at
  before update on public.plaid_transactions
  for each row execute function public.set_updated_at();
