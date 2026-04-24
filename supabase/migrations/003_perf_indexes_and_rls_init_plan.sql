-- Migration 003: performance hardening (applied 2026-04-24)
-- 1. Add covering indexes for every foreign key
-- 2. Rewrite all RLS policies to use (select auth.uid()) for initplan optimization
-- Safe to re-run.

-- ===== 1. Foreign-key covering indexes =====
create index if not exists documents_task_id_idx on public.documents(task_id);
create index if not exists documents_user_id_idx on public.documents(user_id);
create index if not exists documents_vehicle_id_idx on public.documents(vehicle_id);
create index if not exists insurance_accounts_user_id_idx on public.insurance_accounts(user_id);
create index if not exists loan_lease_accounts_user_id_idx on public.loan_lease_accounts(user_id);
create index if not exists maintenance_items_vehicle_id_idx on public.maintenance_items(vehicle_id);
create index if not exists obd_readings_user_id_idx on public.obd_readings(user_id);
create index if not exists obd_readings_vehicle_id_idx on public.obd_readings(vehicle_id);
create index if not exists providers_user_id_idx on public.providers(user_id);
create index if not exists recalls_user_id_idx on public.recalls(user_id);
create index if not exists task_audit_logs_task_id_idx on public.task_audit_logs(task_id);
create index if not exists task_audit_logs_vehicle_id_idx on public.task_audit_logs(vehicle_id);
create index if not exists task_emails_provider_id_idx on public.task_emails(provider_id);
create index if not exists task_emails_task_id_idx on public.task_emails(task_id);
create index if not exists user_agreements_user_id_idx on public.user_agreements(user_id);
create index if not exists vehicle_alerts_vehicle_id_idx on public.vehicle_alerts(vehicle_id);
create index if not exists vehicle_cost_profiles_user_id_idx on public.vehicle_cost_profiles(user_id);
create index if not exists vehicle_events_user_id_idx on public.vehicle_events(user_id);
create index if not exists vehicle_events_vehicle_id_idx on public.vehicle_events(vehicle_id);
create index if not exists vehicle_tasks_vehicle_id_idx on public.vehicle_tasks(vehicle_id);

-- ===== 2. RLS initplan fix: wrap auth.uid() in (select ...) so it's evaluated once per query =====

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select_own on public.profiles for select using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles for insert with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update using ((select auth.uid()) = id);

drop policy if exists vehicles_select_own on public.vehicles;
drop policy if exists vehicles_insert_own on public.vehicles;
drop policy if exists vehicles_update_own on public.vehicles;
drop policy if exists vehicles_delete_own on public.vehicles;
create policy vehicles_select_own on public.vehicles for select using ((select auth.uid()) = user_id);
create policy vehicles_insert_own on public.vehicles for insert with check ((select auth.uid()) = user_id);
create policy vehicles_update_own on public.vehicles for update using ((select auth.uid()) = user_id);
create policy vehicles_delete_own on public.vehicles for delete using ((select auth.uid()) = user_id);

drop policy if exists vehicle_cost_profiles_owner_all on public.vehicle_cost_profiles;
create policy vehicle_cost_profiles_owner_all on public.vehicle_cost_profiles
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists loan_lease_accounts_owner_all on public.loan_lease_accounts;
create policy loan_lease_accounts_owner_all on public.loan_lease_accounts
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists insurance_accounts_owner_all on public.insurance_accounts;
create policy insurance_accounts_owner_all on public.insurance_accounts
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists vehicle_alerts_owner_all on public.vehicle_alerts;
create policy vehicle_alerts_owner_all on public.vehicle_alerts
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists providers_owner_all on public.providers;
create policy providers_owner_all on public.providers
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists vehicle_tasks_owner_all on public.vehicle_tasks;
create policy vehicle_tasks_owner_all on public.vehicle_tasks
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists task_emails_owner_all on public.task_emails;
create policy task_emails_owner_all on public.task_emails
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists task_audit_logs_owner_select on public.task_audit_logs;
drop policy if exists task_audit_logs_owner_insert on public.task_audit_logs;
create policy task_audit_logs_owner_select on public.task_audit_logs
  for select using ((select auth.uid()) = user_id);
create policy task_audit_logs_owner_insert on public.task_audit_logs
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists vehicle_events_owner_all on public.vehicle_events;
create policy vehicle_events_owner_all on public.vehicle_events
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists documents_owner_all on public.documents;
create policy documents_owner_all on public.documents
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists subs_owner_select on public.subscriptions;
create policy subs_owner_select on public.subscriptions
  for select using ((select auth.uid()) = user_id);

drop policy if exists maint_owner_all on public.maintenance_items;
create policy maint_owner_all on public.maintenance_items
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists recalls_owner_all on public.recalls;
create policy recalls_owner_all on public.recalls
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists pii_owner_all on public.user_pii;
create policy pii_owner_all on public.user_pii
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists onboarding_owner_all on public.onboarding_prompts;
create policy onboarding_owner_all on public.onboarding_prompts
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists agreements_owner_all on public.user_agreements;
create policy agreements_owner_all on public.user_agreements
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists obd_owner_all on public.obd_reservations;
create policy obd_owner_all on public.obd_reservations
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists obd_readings_owner_all on public.obd_readings;
create policy obd_readings_owner_all on public.obd_readings
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists email_events_owner_select on public.email_events;
create policy email_events_owner_select on public.email_events
  for select using (
    exists (
      select 1 from public.task_emails te
      where te.id = email_events.task_email_id
      and te.user_id = (select auth.uid())
    )
  );
