-- Per-department learned contacts for each provider.
-- Schema: { service: "sarah@landrovermarin.com", sales: "mike@landrovermarin.com", ... }
-- Departments: 'service' | 'sales' | 'finance' | 'general'
-- Outbound picks contacts[dept] if present, else falls back to providers.email (the
-- originally-published / discovery address). Inbound reply-learning writes ONLY to
-- the dept that matches the originating task's category.
ALTER TABLE public.providers
  ADD COLUMN IF NOT EXISTS contacts JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.providers.contacts IS
  'Per-department learned email contacts. Keys: service, sales, finance, general. Populated by inbound reply-learning. Outbound picks contacts[dept] before falling back to providers.email.';

CREATE INDEX IF NOT EXISTS idx_providers_contacts_gin
  ON public.providers USING GIN (contacts);
