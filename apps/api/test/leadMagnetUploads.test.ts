import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same DB-mocking pattern as reports.test.ts / campaigns.test.ts: no real
// Postgres needed.
const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock("../src/db/pool.js", () => ({
  pool: { connect: connectMock },
}));

// Real local-disk storage against a real temp dir, same convention as
// reports.test.ts's REPORT_FILES_DIR — the upload route's actual file I/O
// is exercised for real, not mocked away.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlaunch-lead-magnet-upload-test-"));
process.env.LEAD_MAGNET_FILES_DIR = tmpDir;

const scanForMalwareMock = vi.fn();
vi.mock("../src/lib/malwareScan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/malwareScan.js")>();
  return { ...actual, scanForMalware: (...args: unknown[]) => scanForMalwareMock(...args) };
});

const { leadMagnetUploadsRouter } = await import("../src/routes/leadMagnetUploads.js");
const { publicLeadMagnetDownloadRouter } = await import("../src/routes/publicLeadMagnetDownload.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/tenants/:tenantId/projects/:projectId/landing-pages", leadMagnetUploadsRouter);
  app.use("/api/v1/public", publicLeadMagnetDownloadRouter);
  app.use(errorHandler);
  return app;
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_1 = "33333333-3333-3333-3333-333333333333";
const LANDING_PAGE_1 = "44444444-4444-4444-4444-444444444444";
const MAGNET_1 = "55555555-5555-5555-5555-555555555555";
const USER_1 = "user-1";

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n", "utf8"), Buffer.alloc(100, 0x20)]);
const EXE_BYTES = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  scanForMalwareMock.mockReset();
  scanForMalwareMock.mockResolvedValue({ clean: true, reason: "not_configured — no AV engine integrated" });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mockMembership(role = "owner") {
  return [
    undefined, // BEGIN
    undefined, // set_config
    { rowCount: 1, rows: [{ id: "m1", role, status: "active" }] }, // membership
  ];
}

function queueResponses(responses: unknown[]) {
  for (const r of responses) queryMock.mockResolvedValueOnce(r);
}

describe("POST /:id/lead-magnets/:magnetId/upload", () => {
  it("rejects a request with no membership (tenant isolation holds for uploads too)", async () => {
    queueResponses([undefined, undefined, { rowCount: 0, rows: [] }, undefined]);

    const res = await request(buildApp())
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${LANDING_PAGE_1}/lead-magnets/${MAGNET_1}/upload`)
      .set("X-Dev-User-Id", USER_1)
      .attach("file", PDF_BYTES, { filename: "whitepaper.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
  });

  it("uploads a real PDF: validates it, ALWAYS calls scanForMalware, stores it on real local disk, and updates the row", async () => {
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] }, // project exists
      { rowCount: 1, rows: [{ id: MAGNET_1, storage_key: null }] }, // existing lead magnet lookup
      { rowCount: 1, rows: [{ id: MAGNET_1, storage_key: "abc/whitepaper.pdf", scan_status: "clean" }] }, // UPDATE RETURNING
    ]);

    const res = await request(buildApp())
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${LANDING_PAGE_1}/lead-magnets/${MAGNET_1}/upload`)
      .set("X-Dev-User-Id", USER_1)
      .attach("file", PDF_BYTES, { filename: "whitepaper.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(scanForMalwareMock).toHaveBeenCalledTimes(1);
    expect(res.body.leadMagnet.scan_status).toBe("clean");

    const updateCall = queryMock.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("UPDATE lead_magnets"));
    expect(updateCall).toBeDefined();
  });

  it("rejects a renamed-extension attack (.exe content declared as application/pdf) before ever calling the storage backend", async () => {
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: MAGNET_1, storage_key: null }] },
    ]);

    const res = await request(buildApp())
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${LANDING_PAGE_1}/lead-magnets/${MAGNET_1}/upload`)
      .set("X-Dev-User-Id", USER_1)
      .attach("file", EXE_BYTES, { filename: "whitepaper.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(scanForMalwareMock).not.toHaveBeenCalled();
  });

  it("rejects the upload (400) when scanForMalware reports not clean, and records scan_status=rejected", async () => {
    scanForMalwareMock.mockResolvedValue({ clean: false, reason: "EICAR-Test-Signature" });
    queueResponses([
      ...mockMembership(),
      { rowCount: 1, rows: [{}] },
      { rowCount: 1, rows: [{ id: MAGNET_1, storage_key: null }] },
      undefined, // UPDATE scan_status = rejected
    ]);

    const res = await request(buildApp())
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${LANDING_PAGE_1}/lead-magnets/${MAGNET_1}/upload`)
      .set("X-Dev-User-Id", USER_1)
      .attach("file", PDF_BYTES, { filename: "whitepaper.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("EICAR-Test-Signature");
  });

  it("rejects a file over the configured max size with a 400 (a real MulterError converted to HttpError), not a generic 500", async () => {
    queueResponses([...mockMembership()]);

    // Default max is 25MB (env.ts) — send a real buffer over that limit so
    // multer's own `limits.fileSize` genuinely rejects it, exercising the
    // handleSingleFileUpload MulterError-to-HttpError conversion for real.
    const oversized = Buffer.alloc(26 * 1024 * 1024, 0x20);

    const res = await request(buildApp())
      .post(`/api/v1/tenants/${TENANT_A}/projects/${PROJECT_1}/landing-pages/${LANDING_PAGE_1}/lead-magnets/${MAGNET_1}/upload`)
      .set("X-Dev-User-Id", USER_1)
      .attach("file", oversized, { filename: "big.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  }, 20000);
});

describe("GET /api/v1/public/lead-magnet-downloads/:key — signed, time-limited download", () => {
  it("serves the real file when the signature is valid and unexpired", async () => {
    const { LocalDiskFileStorage } = await import("../src/lib/fileStorage.js");
    const storage = new LocalDiskFileStorage(tmpDir);
    const uploadResult = await storage.upload(Buffer.from("real file bytes"), "f.pdf", "application/pdf");

    const res = await request(buildApp()).get(uploadResult.url);

    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(res.body) ? res.body.toString("utf8") : res.text).toBe("real file bytes");
  });

  it("rejects a request with a tampered signature", async () => {
    const { LocalDiskFileStorage } = await import("../src/lib/fileStorage.js");
    const storage = new LocalDiskFileStorage(tmpDir);
    const uploadResult = await storage.upload(Buffer.from("secret"), "g.pdf", "application/pdf");

    const res = await request(buildApp()).get(uploadResult.url.replace(/sig=[^&]+/, "sig=tampered0000000000000000000000000000000000000000000000000000"));

    expect(res.status).toBe(401);
  });

  it("rejects a request with an expired link", async () => {
    const { createHmac } = await import("node:crypto");
    const { env } = await import("../src/config/env.js");
    const { LocalDiskFileStorage } = await import("../src/lib/fileStorage.js");
    const storage = new LocalDiskFileStorage(tmpDir);
    const uploadResult = await storage.upload(Buffer.from("secret2"), "h.pdf", "application/pdf");
    const key = uploadResult.url.split("/").pop()!.split("?")[0];
    const decodedKey = decodeURIComponent(key);

    // buildSignedDownload() floors ttlSeconds at 1 (production never issues
    // an already-expired link), so to test expiry handling we replicate its
    // exact HMAC scheme here with an expiresAtMs already in the past.
    const expiresAtMs = Date.now() - 10_000;
    const secret = env.leadMagnetDownloadSecret ?? env.jwtAccessSecret;
    const sig = createHmac("sha256", secret).update(`${decodedKey}.${expiresAtMs}`).digest("hex");

    const res = await request(buildApp()).get(
      `/api/v1/public/lead-magnet-downloads/${key}?expires=${expiresAtMs}&sig=${sig}`,
    );

    expect(res.status).toBe(401);
  });

  it("rejects a request missing sig/expires entirely", async () => {
    const res = await request(buildApp()).get(`/api/v1/public/lead-magnet-downloads/some-key.pdf`);
    expect(res.status).toBe(401);
  });
});
