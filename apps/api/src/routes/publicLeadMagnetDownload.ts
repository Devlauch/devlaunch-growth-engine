import { Router } from "express";
import { z } from "zod";
import { Errors } from "../lib/httpError.js";
import { verifySignedDownload } from "../lib/signedDownloadUrl.js";
import { LocalDiskFileStorage } from "../lib/fileStorage.js";

/**
 * Public, unauthenticated lead-magnet file download
 * (Milestone 3) — the real artifact a signed download link
 * (minted by POST .../lead-magnets/:magnetId/download-link in
 * routes/leadMagnetUploads.ts) actually resolves to. Intentionally NOT
 * behind requireAuth/requireTenantMembership — an anonymous website
 * visitor who filled out a lead-magnet form has no platform account — but
 * every request MUST carry a valid, unexpired HMAC signature over the
 * exact storage key being requested (signedDownloadUrl.ts), so this is
 * never an open file-listing/directory-traversal surface: an attacker
 * cannot enumerate or guess a working `key`+`sig`+`expires` triple.
 *
 * Wiring note for app.ts (not edited this round, per instructions):
 *   import { publicLeadMagnetDownloadRouter } from "./routes/publicLeadMagnetDownload.js";
 *   app.use("/api/v1/public", publicCors, publicLeadMagnetDownloadRouter);
 * (alongside the existing `app.use("/api/v1/public", publicCors, publicLandingPagesRouter)` line.)
 */
export const publicLeadMagnetDownloadRouter = Router();

const querySchema = z.object({
  expires: z.string().optional(),
  sig: z.string().optional(),
});

/** GET /api/v1/public/lead-magnet-downloads/:key?expires=...&sig=... */
publicLeadMagnetDownloadRouter.get("/lead-magnet-downloads/:key", async (req, res, next) => {
  try {
    const key = z.string().min(1).max(500).parse(req.params.key);
    const query = querySchema.parse(req.query);

    if (!verifySignedDownload(key, query.expires, query.sig)) {
      throw Errors.unauthorized("Invalid or expired download link");
    }

    const storage = new LocalDiskFileStorage();
    let buffer: Buffer;
    try {
      buffer = await storage.readFile(key);
    } catch {
      throw Errors.notFound("File not found");
    }

    const filename = key.split("/").pop() ?? "download";
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(buffer);
  } catch (err) {
    next(err);
  }
});
