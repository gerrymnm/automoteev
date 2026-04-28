-- ===========================================================================
-- Migration 014a: hotfix — extend document_kind check to include drivers_license
-- ===========================================================================
-- HOTFIX applied directly to production via Supabase MCP after audit caught
-- that the document_kind CHECK constraint in production still enumerated only
-- the original 8 kinds and did NOT include 'drivers_license'. POST
-- /api/documents accepts drivers_license at the validator layer (and the
-- documents service writes rows with that kind) so any actual DL upload
-- would have failed with a check_violation at insert time.
--
-- This file mirrors what was applied so the local repo + production stay
-- in sync. Subsequent migration 014 (identity category) was applied first
-- in production and only fixed the category column; this file fixes the
-- kind column.

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
