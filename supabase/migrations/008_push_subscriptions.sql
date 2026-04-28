-- Per-device push notification subscriptions for ambient agent updates.
-- One row per (user, device endpoint). When a dealer replies to an outbound
-- email, the inbound webhook handler fires a push to all of the user's
-- subscriptions so the notification lands wherever they are - phone lock
-- screen, desktop notification tray, etc - without needing to open the app.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The full push subscription endpoint URL (FCM, Mozilla autopush, Apple).
  -- Unique because the same endpoint always belongs to the same device.
  endpoint text not null unique,
  -- Encryption keys provided by the browser when the user subscribes.
  -- Required for the web-push library to encrypt payloads.
  p256dh_key text not null,
  auth_key text not null,
  -- For debugging which device subscribed (e.g. "iPhone, Safari 17").
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  -- When a push delivery permanently fails (410 Gone, 404), we mark the
  -- row failed so we can prune later or skip it without retrying.
  failed_at timestamptz,
  failure_reason text
);

create index if not exists idx_push_subs_user on public.push_subscriptions(user_id);
create index if not exists idx_push_subs_active
  on public.push_subscriptions(user_id) where failed_at is null;

alter table public.push_subscriptions enable row level security;

-- Users can only see/manage their own subscriptions. The webhook code uses
-- the service role to bypass RLS when sending pushes triggered by inbound
-- email replies (it knows the user_id from the task lookup).
create policy "users manage own push subscriptions"
  on public.push_subscriptions
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
