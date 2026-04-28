-- ===========================================================================
-- Migration 013: per-VIN document folders
-- ===========================================================================
-- The current storage layout is flat per-user: `<userId>/<docId>.<ext>`. That
-- works for upload + extraction but doesn't let us answer "what do I have on
-- this car?" without scanning every doc and filtering by vehicle_id.
--
-- New layout: `vehicles/<vehicle_id>/<category>/<docId>.<ext>` so per-vehicle
-- listing is a single bucket prefix, and per-category listing within a vehicle
-- is also a prefix. Backfill not needed — uploaded_documents has 0 rows. The
-- bucket itself stays the same (user-documents); only the path scheme changes.
--
-- We store category explicitly (rather than always re-deriving from
-- document_kind) so the user can re-categorize a misclassified upload later
-- without losing the original kind.

ALTER TABLE public.uploaded_documents
  ADD COLUMN category TEXT;

-- Constrain to known categories. Keep "other" as the catch-all so an unknown
-- document_kind upload still has a valid storage prefix.
ALTER TABLE public.uploaded_documents
  ADD CONSTRAINT uploaded_documents_category_check
  CHECK (category IS NULL OR category IN (
    'insurance', 'loan', 'registration', 'recall', 'service', 'sale', 'other'
  ));

-- Fast per-vehicle listing + per-category filter within a vehicle.
CREATE INDEX idx_uploaded_documents_vehicle_category
  ON public.uploaded_documents(vehicle_id, category, uploaded_at DESC)
  WHERE vehicle_id IS NOT NULL;
