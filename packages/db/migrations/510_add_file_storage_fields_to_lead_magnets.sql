-- Up Migration
--
-- Milestone 3 — real lead-magnet file uploads (closes the gap
-- 265_create_lead_magnets.sql's own comment documents: `file_url` was a
-- client-supplied-URL stub, with no file-upload/object-storage infra).
-- Purely additive: `file_url` itself is untouched (still NOT NULL, still
-- populated on upload — see routes/leadMagnetUploads.ts) so no existing
-- row or code path is broken. These new, nullable columns record the real
-- artifact of a platform-handled upload (apps/api/src/lib/fileStorage.ts):
--   storage_key       — opaque key passed back into FileStorage.delete()/
--                        getSignedDownloadUrl(). NULL until a real upload
--                        has happened (a lead magnet created with only the
--                        old client-supplied file_url has no storage_key).
--   storage_provider  — which FileStorage backend holds it. 'external'
--                        (the default, back-compat value) means file_url
--                        is a client-supplied URL, not a platform upload.
--   content_type      — the real, sniffed-and-validated MIME type (see
--                        apps/api/src/lib/fileValidation.ts), not just the
--                        client's declared Content-Type header.
--   file_size_bytes   — real byte size of the uploaded file.
--   original_filename — the client's original filename, for
--                        Content-Disposition on download.
--   scan_status       — apps/api/src/lib/malwareScan.ts's outcome.
--                        'not_scanned' is the pre-upload default;
--                        'clean'/'rejected' are only ever set by the real
--                        upload route, which ALWAYS calls scanForMalware()
--                        before accepting a file.
--   scan_reason       — the scan provider's human-readable reason (today,
--                        always the honest NotConfiguredScanProvider
--                        message — never fabricated).
ALTER TABLE lead_magnets
  ADD COLUMN storage_key text,
  ADD COLUMN storage_provider text NOT NULL DEFAULT 'external'
    CHECK (storage_provider IN ('external', 'local_disk', 's3')),
  ADD COLUMN content_type text,
  ADD COLUMN file_size_bytes bigint,
  ADD COLUMN original_filename text,
  ADD COLUMN scan_status text NOT NULL DEFAULT 'not_scanned'
    CHECK (scan_status IN ('not_scanned', 'clean', 'rejected')),
  ADD COLUMN scan_reason text;

-- Down Migration

ALTER TABLE lead_magnets
  DROP COLUMN IF EXISTS storage_key,
  DROP COLUMN IF EXISTS storage_provider,
  DROP COLUMN IF EXISTS content_type,
  DROP COLUMN IF EXISTS file_size_bytes,
  DROP COLUMN IF EXISTS original_filename,
  DROP COLUMN IF EXISTS scan_status,
  DROP COLUMN IF EXISTS scan_reason;
