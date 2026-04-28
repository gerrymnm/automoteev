-- ===========================================================================
-- Migration 017: storage policies match new path scheme
-- ===========================================================================
-- The old user-documents bucket policies (created in migration 005) expected
-- the first folder segment to equal auth.uid(): `<userId>/<docId>.<ext>`.
-- Migration 013 changed the path scheme to either:
--   vehicles/<vehicle_id>/<category>/<docId>.<ext>   (vehicle-scoped uploads)
--   users/<user_id>/<category>/<docId>.<ext>         (user-scoped uploads, e.g. DL)
--
-- Today this mismatch is masked because every upload, download, and signed-
-- URL operation goes through supabaseAdmin (service role bypasses RLS). But
-- the policy is misleading and would silently break any future move toward
-- direct-from-browser uploads with the user's anon JWT.
--
-- New policies allow a user to read/write their own objects under either:
--   - users/<auth.uid()>/...
--   - vehicles/<vehicle_id>/...  where vehicle_id is owned by auth.uid()
--
-- INSERT only allows the user's own user-folder; vehicle-folder uploads
-- continue to go through the admin client (the API does the ownership
-- check on POST /api/documents). DELETE/UPDATE follow the same shape.

DROP POLICY IF EXISTS user_documents_owner_select ON storage.objects;
DROP POLICY IF EXISTS user_documents_owner_insert ON storage.objects;
DROP POLICY IF EXISTS user_documents_owner_delete ON storage.objects;

-- SELECT: user can read either their own user-scoped path OR any vehicle
-- path whose vehicle_id resolves to their user_id.
CREATE POLICY user_documents_owner_select ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'user-documents'
    AND (
      -- users/<auth.uid()>/...
      ((storage.foldername(name))[1] = 'users'
        AND (storage.foldername(name))[2] = (SELECT auth.uid())::text)
      OR
      -- vehicles/<vehicle_id>/...  where vehicle_id is owned by the caller.
      -- The cast assumes the second segment is always a UUID; non-UUID
      -- segments simply fail the EXISTS lookup and are denied.
      ((storage.foldername(name))[1] = 'vehicles'
        AND EXISTS (
          SELECT 1 FROM public.vehicles v
          WHERE v.id::text = (storage.foldername(name))[2]
            AND v.user_id = (SELECT auth.uid())
        ))
    )
  );

-- INSERT: only allow the user-scoped folder under direct user JWT. Vehicle-
-- scoped uploads continue to flow through the admin client (which bypasses
-- RLS) so the API can run its ownership check first.
CREATE POLICY user_documents_owner_insert ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'user-documents'
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
  );

-- DELETE: same dual scheme as SELECT.
CREATE POLICY user_documents_owner_delete ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'user-documents'
    AND (
      ((storage.foldername(name))[1] = 'users'
        AND (storage.foldername(name))[2] = (SELECT auth.uid())::text)
      OR
      ((storage.foldername(name))[1] = 'vehicles'
        AND EXISTS (
          SELECT 1 FROM public.vehicles v
          WHERE v.id::text = (storage.foldername(name))[2]
            AND v.user_id = (SELECT auth.uid())
        ))
    )
  );
