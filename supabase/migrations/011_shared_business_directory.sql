-- ===========================================================================
-- Migration 011: shared business directory + verified contacts pool
-- ===========================================================================
-- Up to now, every provider was per-user. When user A learned that Alex Perry
-- replies for Range Rover service at Land Rover Marin, that learning lived
-- only on user A's row. User B onboarding next month would re-discover Land
-- Rover Marin from scratch and start cold.
--
-- This migration introduces a shared directory keyed on Google Places place_id
-- so every successful interaction seeds future users in the same area. The
-- per-user `providers` table remains as the local relationship layer; it now
-- links to the shared `businesses` row via business_id.
--
-- Privacy: per-product-direction, verified emails are shareable. They are
-- typically published on the dealer's website anyway. Sharing them across
-- users that would otherwise contact the same business is exactly the kind
-- of "friend tells you who to ask for" network effect we want.

-- 1. businesses — single shared row per real-world business.
CREATE TABLE public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id TEXT,                              -- Google Places ID; nullable for legacy backfill rows
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  website TEXT,
  latitude DECIMAL(9,6),
  longitude DECIMAL(9,6),
  provider_type TEXT,
  published_email TEXT,                       -- email scraped from website during discovery
  rating DECIMAL(2,1),
  rating_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- place_id is the canonical identity. Unique when present so we never duplicate.
-- Legacy rows backfilled from existing providers carry NULL place_id until
-- discovery re-runs and refills it.
CREATE UNIQUE INDEX idx_businesses_place_id ON public.businesses(place_id) WHERE place_id IS NOT NULL;
CREATE INDEX idx_businesses_provider_type ON public.businesses(provider_type);
-- Backfill matching needs case-insensitive name+address lookup
CREATE INDEX idx_businesses_name_address 
  ON public.businesses(LOWER(TRIM(name)), LOWER(COALESCE(TRIM(address), '')));

-- 2. business_contacts — verified emails at a business, shared across all users.
-- Same email/dept combo can exist at one business; UNIQUE prevents dupes when
-- multiple users learn the same address.
CREATE TABLE public.business_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  dept TEXT NOT NULL,                         -- service, sales, finance, claims, general
  contact_name TEXT,                          -- "Alex Perry" when known; NULL otherwise
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  verified_by_user_id UUID,                   -- audit trail (first user to learn); NOT used for access control
  success_count INTEGER DEFAULT 1,
  last_success_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, email, dept)
);
CREATE INDEX idx_business_contacts_lookup 
  ON public.business_contacts(business_id, dept, last_success_at DESC);

-- 3. Link existing per-user providers to the shared directory.
-- Going forward, every newly-discovered provider gets place_id stored, and
-- business_id is set to the matching businesses row.
ALTER TABLE public.providers ADD COLUMN business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;
ALTER TABLE public.providers ADD COLUMN place_id TEXT;
CREATE INDEX idx_providers_business_id ON public.providers(business_id);
CREATE INDEX idx_providers_place_id ON public.providers(place_id);

-- 4. RLS — directory tables are service-role only.
-- All reads and writes go through the API which uses supabaseAdmin; no
-- direct user policies needed. This avoids accidentally leaking the directory
-- to unauthenticated clients.
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_contacts ENABLE ROW LEVEL SECURITY;
-- (No CREATE POLICY statements = deny-all by default for authenticated/anon.
--  Service role bypasses RLS automatically.)

-- 5. Backfill businesses from existing providers, dedupe by (name, address).
-- DISTINCT ON keeps the most recent row when there are dupes (the test data
-- has SF Federal Credit Union three times — we want one businesses row).
INSERT INTO public.businesses (name, address, phone, published_email, provider_type)
SELECT name, location, phone, email, provider_type
FROM (
  SELECT DISTINCT ON (LOWER(TRIM(name)), LOWER(COALESCE(TRIM(location), '')))
    name, location, email, phone, provider_type, created_at
  FROM public.providers
  WHERE name IS NOT NULL
  ORDER BY LOWER(TRIM(name)), LOWER(COALESCE(TRIM(location), '')), created_at DESC
) src;

-- 6. Link existing providers to their businesses row by name+address match.
UPDATE public.providers p
SET business_id = b.id
FROM public.businesses b
WHERE 
  LOWER(TRIM(p.name)) = LOWER(TRIM(b.name))
  AND LOWER(COALESCE(TRIM(p.location), '')) = LOWER(COALESCE(TRIM(b.address), ''))
  AND p.business_id IS NULL;

-- 7. Backfill business_contacts from providers.contacts JSONB.
-- This pulls the existing per-user learned contacts (e.g. Alex Perry at
-- Land Rover Marin) into the shared pool so future users benefit immediately.
INSERT INTO public.business_contacts (business_id, email, dept, verified_by_user_id, verified_at, last_success_at, success_count)
SELECT 
  p.business_id,
  contact.value AS email,
  contact.key AS dept,
  p.user_id,
  COALESCE(p.updated_at, p.created_at),
  COALESCE(p.updated_at, p.created_at),
  1
FROM public.providers p
CROSS JOIN LATERAL jsonb_each_text(p.contacts) AS contact(key, value)
WHERE 
  p.business_id IS NOT NULL
  AND p.contacts IS NOT NULL
  AND jsonb_typeof(p.contacts) = 'object'
  AND contact.value IS NOT NULL
  AND contact.value != ''
ON CONFLICT (business_id, email, dept) DO NOTHING;
