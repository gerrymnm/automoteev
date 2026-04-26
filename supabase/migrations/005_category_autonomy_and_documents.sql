-- Migration 005: per-category autonomy + category on tasks + documents pipeline
-- Foundation for venture-scale "agent for financial life" expansion.
-- Applied 2026-04-25.

-- 1. Per-category autonomy levels
create table if not exists public.category_autonomy (
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  approved_count integer not null default 0,
  level integer not null default 1 check (level between 1 and 3),
  unlocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

create index if not exists category_autonomy_user_idx on public.category_autonomy(user_id);
alter table public.category_autonomy enable row level security;
drop policy if exists category_autonomy_owner_all on public.category_autonomy;
create policy category_autonomy_owner_all on public.category_autonomy
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create trigger category_autonomy_updated_at
  before update on public.category_autonomy
  for each row execute function public.set_updated_at();

-- 2. Category column on tasks
alter table public.vehicle_tasks
  add column if not exists category text not null default 'general';

create index if not exists vehicle_tasks_category_idx
  on public.vehicle_tasks(user_id, category);

-- 3. Documents table
create table if not exists public.uploaded_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vehicle_id uuid references public.vehicles(id) on delete cascade,
  document_kind text not null check (document_kind in (
    'insurance_dec_page', 'loan_statement', 'lease_agreement',
    'registration', 'recall_notice', 'service_record',
    'sale_paperwork', 'other'
  )),
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  byte_size bigint not null,
  extraction_status text not null default 'pending' check (extraction_status in (
    'pending', 'processing', 'completed', 'failed'
  )),
  extracted_data jsonb,
  extraction_error text,
  uploaded_at timestamptz not null default now(),
  extracted_at timestamptz
);

create index if not exists uploaded_documents_user_idx on public.uploaded_documents(user_id, uploaded_at desc);
create index if not exists uploaded_documents_vehicle_idx on public.uploaded_documents(vehicle_id, uploaded_at desc);
alter table public.uploaded_documents enable row level security;
drop policy if exists uploaded_documents_owner_all on public.uploaded_documents;
create policy uploaded_documents_owner_all on public.uploaded_documents
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 4. Storage bucket for uploaded documents
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-documents', 'user-documents', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "user_documents_owner_select" on storage.objects;
create policy "user_documents_owner_select" on storage.objects
  for select using (
    bucket_id = 'user-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "user_documents_owner_insert" on storage.objects;
create policy "user_documents_owner_insert" on storage.objects
  for insert with check (
    bucket_id = 'user-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "user_documents_owner_delete" on storage.objects;
create policy "user_documents_owner_delete" on storage.objects
  for delete using (
    bucket_id = 'user-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- 5. Backfill task categories
update public.vehicle_tasks set category =
  case
    when task_type in ('service', 'recall_check', 'recall_repair', 'maintenance_quote') then 'service'
    when task_type in ('insurance_quote', 'insurance_review') then 'insurance'
    when task_type in ('refinance', 'lease_end', 'payoff_request') then 'lending'
    when task_type in ('sell_vehicle', 'trade_in') then 'sale'
    else 'general'
  end
where category = 'general';

-- 6. MCP connections table
create table if not exists public.mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_name text not null,
  client_id text,
  scopes text[] not null default '{}',
  access_token_hash text not null,
  refresh_token_hash text,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_connections_user_idx on public.mcp_connections(user_id);
create index if not exists mcp_connections_token_idx on public.mcp_connections(access_token_hash);
alter table public.mcp_connections enable row level security;
drop policy if exists mcp_connections_owner_select on public.mcp_connections;
create policy mcp_connections_owner_select on public.mcp_connections
  for select using ((select auth.uid()) = user_id);
