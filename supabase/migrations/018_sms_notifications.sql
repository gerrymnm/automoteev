-- SMS launch infrastructure: user notification preferences + outbound SMS log.
-- Phone numbers remain encrypted in user_pii. sms_messages stores only the
-- delivery target used for Twilio and the non-sensitive text body sent.

create table if not exists public.user_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sms_enabled boolean not null default false,
  email_enabled boolean not null default true,
  push_enabled boolean not null default true,
  quiet_hours_start time,
  quiet_hours_end time,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.vehicle_tasks(id) on delete set null,
  to_phone text,
  body_text text not null,
  direction text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  status text not null check (status in ('sent', 'queued', 'delivered', 'failed', 'skipped', 'received')),
  provider text not null default 'twilio',
  provider_message_id text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sms_messages_user_created
  on public.sms_messages(user_id, created_at desc);
create index if not exists idx_sms_messages_task
  on public.sms_messages(task_id, created_at desc);

alter table public.user_notification_preferences enable row level security;
alter table public.sms_messages enable row level security;

create policy "users manage own notification preferences"
  on public.user_notification_preferences
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "users view own sms messages"
  on public.sms_messages
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "users insert own sms messages"
  on public.sms_messages
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop trigger if exists notification_preferences_updated_at
  on public.user_notification_preferences;
create trigger notification_preferences_updated_at
  before update on public.user_notification_preferences
  for each row execute function public.set_updated_at();
