import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireTenantMembership } from "../middleware/tenant.js";
import { Errors } from "../lib/httpError.js";
import { env } from "../config/env.js";
import { validateUploadedFile } from "../lib/fileValidation.js";
import { scanForMalware } from "../lib/malwareScan.js";
import { buildFileStorage, type FileStorage } from "../lib/fileStorage.js";
import { logger } from "../lib/logger.js";

/**
 * Real lead-magnet file uploads (Milestone 3) — closes the gap
 * 265_create_lead_magnets.sql's own comment documents: `file_url` was a
 * client-supplied-URL stub, with no actual upload pipeline.
 *
 * Mounted at the SAME prefix as routes/landingPages.ts
 * (/api/v1/tenants/:tenantId/projects/:projectId/landing-pages) — as its
 * OWN router, in a NEW file, rather than extending landingPages.ts
 * directly: that file is untracked and under active concurrent edit in
 * this session's repo (confirmed via `git status` before starting this
 * work), so touching it risked a collision with the other session's
 * in-flight changes. Express supports multiple routers mounted at the same
 * path prefix with disjoint sub-paths without conflict (see app.ts's
 * existing `dealHealthRouter`/`dealsRouter` both mounted at
 * `.../deals`) — this router only adds
 * `POST /:id/lead-magnets/:magnetId/upload` and
 * `POST /:id/lead-magnets/:magnetId/download-link`, neither of which
 * landingPages.ts defines.
 *
 * Wiring note for app.ts (not edited this round, per instructions):
 *   import { leadMagnetUploadsRouter } from "./routes/leadMagnetUploads.js";
 *   app.use("/api/v1/tenants/:tenantId/projects/:projectId/landing-pages", mainCors, leadMagnetUploadsRouter);
 * (placed anywhere after the existing `landingPagesRouter` mount line is fine.)
 *
 * The actual public, unauthenticated file download
 * (`GET /api/v1/public/lead-magnet-downloads/:key`) lives in
 * routes/publicLeadMagnetDownload.ts — see that file's wiring note.
 */
export const leadMagnetUploadsRouter = Router({ mergeParams: true });
leadMagnetUploadsRouter.use(requireAuth, requireTenantMembership);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.leadMagnetMaxFileSizeBytes },
});

/** Converts a MulterError (e.g. file-too-large) into this codebase's standard HttpError shape, instead of a generic 500. */
function handleSingleFileUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof MulterError) {
      next(Errors.badRequest(`Upload rejected: ${err.message}`));
      return;
    }
    next(err);
  });
}

function paramId(req: Request, name: string): string {
  return z.string().uuid().parse((req.params as Record<string, string>)[name]);
}

async function assertProjectInTenant(req: Request, projectId: string): Promise<void> {
  const r = await req.tenantDb!.query("SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2", [
    projectId,
    req.tenantId,
  ]);
  if (r.rowCount === 0) throw Errors.notFound("Project not found");
}

async function loadLeadMagnetOr404(req: Request, landingPageId: string, leadMagnetId: string) {
  const r = await req.tenantDb!.query(
    `SELECT * FROM lead_magnets WHERE id = $1 AND tenant_id = $2 AND landing_page_id = $3`,
    [leadMagnetId, req.tenantId, landingPageId],
  );
  if (r.rowCount === 0) throw Errors.notFound("Lead magnet not found");
  return r.rows[0];
}

/**
 * POST /:id/lead-magnets/:magnetId/upload — multipart/form-data, field
 * name "file". Real pipeline: multer buffers the upload in memory (bounded
 * by env.leadMagnetMaxFileSizeBytes) -> magic-byte + MIME-allowlist
 * validation (fileValidation.ts, never trusts the declared Content-Type
 * alone) -> malware scan (malwareScan.ts — ALWAYS called, honestly
 * `not_configured` today, never silently skipped) -> real local-disk
 * storage (fileStorage.ts). The lead_magnets row's `file_url` column is
 * kept populated (NOT NULL, per the original migration) with a
 * human-readable canonical reference; the REAL, fetchable artifact is the
 * `storage_key` this uploads to — a fresh signed, time-limited download URL
 * must be minted per request via POST .../download-link (below), never a
 * static forever-valid link.
 */
leadMagnetUploadsRouter.post("/:id/lead-magnets/:magnetId/upload", handleSingleFileUpload, async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    const magnetId = paramId(req, "magnetId");
    const existing = await loadLeadMagnetOr404(req, landingPageId, magnetId);

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) throw Errors.badRequest('No file uploaded — expected multipart/form-data with field "file"');

    const validation = validateUploadedFile(file.buffer, file.mimetype, {
      maxSizeBytes: env.leadMagnetMaxFileSizeBytes,
    });
    if (!validation.valid) {
      throw Errors.badRequest(`Invalid file: ${validation.reason}`);
    }

    const scanResult = await scanForMalware(file.buffer);
    if (!scanResult.clean) {
      await req.tenantDb!.query(
        `UPDATE lead_magnets SET scan_status = 'rejected', scan_reason = $1 WHERE id = $2 AND tenant_id = $3`,
        [scanResult.reason ?? "rejected by malware scan", magnetId, req.tenantId],
      );
      throw Errors.badRequest(`File rejected by malware scan: ${scanResult.reason ?? "unknown reason"}`);
    }

    const storage: FileStorage = buildFileStorage();

    // Replace any previously-uploaded file for this lead magnet (re-upload
    // overwrites, it never accumulates orphaned files on disk).
    if (existing.storage_key) {
      try {
        await storage.delete(existing.storage_key);
      } catch (err) {
        logger.warn({ err, magnetId }, "failed to delete previous lead-magnet file during re-upload; continuing");
      }
    }

    const uploadResult = await storage.upload(file.buffer, file.originalname, file.mimetype);

    const result = await req.tenantDb!.query(
      `UPDATE lead_magnets
         SET storage_key = $1, storage_provider = 'local_disk', content_type = $2, file_size_bytes = $3,
             original_filename = $4, scan_status = 'clean', scan_reason = $5,
             file_url = $6
       WHERE id = $7 AND tenant_id = $8 AND landing_page_id = $9
       RETURNING *`,
      [
        uploadResult.key,
        file.mimetype,
        file.size,
        file.originalname,
        scanResult.reason ?? null,
        `/api/v1/public/lead-magnets/${magnetId}/download (signed link required — generate via POST .../download-link)`,
        magnetId,
        req.tenantId,
        landingPageId,
      ],
    );

    res.status(200).json({ leadMagnet: result.rows[0], sniffedFamily: validation.sniffedFamily });
  } catch (err) {
    next(err);
  }
});

const downloadLinkSchema = z.object({
  expirySeconds: z.number().int().positive().max(7 * 24 * 60 * 60).optional(),
});

/**
 * POST /:id/lead-magnets/:magnetId/download-link — mints a fresh,
 * real HMAC-SHA256-signed, time-limited download URL
 * (routes/publicLeadMagnetDownload.ts verifies it). Default TTL 1 hour,
 * capped at 7 days. This is the real integration point a future
 * lead-capture-form success response (routes/publicLandingPages.ts, not
 * edited this round — see that file's own concurrent-edit note) should
 * call once a visitor has qualified for the magnet, instead of handing out
 * a permanent link.
 */
leadMagnetUploadsRouter.post("/:id/lead-magnets/:magnetId/download-link", async (req, res, next) => {
  try {
    const projectId = paramId(req, "projectId");
    await assertProjectInTenant(req, projectId);
    const landingPageId = paramId(req, "id");
    const magnetId = paramId(req, "magnetId");
    const leadMagnet = await loadLeadMagnetOr404(req, landingPageId, magnetId);
    const body = downloadLinkSchema.parse(req.body ?? {});

    if (!leadMagnet.storage_key) {
      throw Errors.badRequest("This lead magnet has no uploaded file yet — upload one first");
    }

    const storage: FileStorage = buildFileStorage();
    const url = await storage.getSignedDownloadUrl(leadMagnet.storage_key, body.expirySeconds ?? 3600);

    res.json({ url, expirySeconds: body.expirySeconds ?? 3600 });
  } catch (err) {
    next(err);
  }
});
