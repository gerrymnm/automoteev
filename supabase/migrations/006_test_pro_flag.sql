-- Test-Pro override flag for internal test users (separate from real Stripe subs).
-- Lets us grant Pro features to seeded test accounts without minting fake subscriptions.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_test_pro BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.profiles.is_test_pro IS
  'When true, isPro() returns true regardless of subscription state. For internal/test users only. Set via direct SQL or admin endpoint.';

CREATE INDEX IF NOT EXISTS idx_profiles_is_test_pro
  ON public.profiles(is_test_pro)
  WHERE is_test_pro = TRUE;
