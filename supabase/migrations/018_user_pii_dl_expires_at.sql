-- Migration 018: structured DL expiration + issue date on user_pii.
--
-- Why: the DL expiration date currently lives in two places that aren't ideal:
--   1. uploaded_documents.extracted_data.expiration_date — JSON, hard to query
--   2. renewable_items (kind='drivers_license') — exists for the reminder
--      ladder, but optional (only created if extraction succeeded)
--
-- Neither is a clean "what's the user's DL expiration?" source of truth.
-- Adding structured columns on user_pii means:
--   - DLPromptModal can read it back to show "current DL on file, expires X"
--   - Insurance dispatch can include the expiration in the email if needed
--   - The user can manually correct an extraction without going through the
--     renewable_items table
--
-- Both columns are nullable because we may have a DL number without dates
-- (manual entry via DLPromptModal currently doesn't capture them, and OCR
-- can fail to read date fields cleanly).
--
-- dl_issued_date is bundled in the same migration to avoid a follow-up
-- schema change — the extraction prompt already pulls it, we just weren't
-- persisting it anywhere structured.

ALTER TABLE user_pii
  ADD COLUMN IF NOT EXISTS dl_expires_at date,
  ADD COLUMN IF NOT EXISTS dl_issued_date date;

COMMENT ON COLUMN user_pii.dl_expires_at IS
  'DL expiration date (YYYY-MM-DD). Populated from document extraction or manual PUT /api/pii. Source of truth for renewable_items DL rows.';
COMMENT ON COLUMN user_pii.dl_issued_date IS
  'DL issue date (YYYY-MM-DD). Populated from document extraction. Used to compute coverage history length for insurance carriers.';
