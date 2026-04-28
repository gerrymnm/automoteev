-- ===========================================================================
-- Migration 014: drivers_license document_kind + identity category
-- ===========================================================================
-- Most users carry their DL but not a printed dec page or loan statement —
-- everything is paperless. Adding DL upload to the dropzone collapses the
-- just-in-time DLPromptModal for insurance dispatch and gets the data on
-- file the same way insurance / loan extraction works.
--
-- DL is user-scoped (not vehicle-scoped) so storage path falls back to
-- `users/<userId>/identity/<docId>.<ext>`. The category check constraint
-- must accept 'identity' alongside the existing seven values, and the
-- document_kind constraint must accept 'drivers_license'.

-- 1. Extend the document_kind constraint to include drivers_license.
-- The original constraint was created in 005_category_autonomy_and_documents
-- and didn't enumerate this kind. POST /api/documents accepts it so the
-- DB constraint must too.
ALTER TABLE public.uploaded_documents
  DROP CONSTRAINT IF EXISTS uploaded_documents_document_kind_check;

ALTER TABLE public.uploaded_documents
  ADD CONSTRAINT uploaded_documents_document_kind_check
  CHECK (document_kind IN (
    'insurance_dec_page',
    'loan_statement',
    'lease_agreement',
    'registration',
    'recall_notice',
    'service_record',
    'sale_paperwork',
    'drivers_license',
    'other'
  ));

-- 2. Extend the category constraint to include 'identity'.
ALTER TABLE public.uploaded_documents
  DROP CONSTRAINT IF EXISTS uploaded_documents_category_check;

ALTER TABLE public.uploaded_documents
  ADD CONSTRAINT uploaded_documents_category_check
  CHECK (category IS NULL OR category IN (
    'insurance', 'loan', 'registration', 'recall', 'service', 'sale',
    'identity', 'other'
  ));
