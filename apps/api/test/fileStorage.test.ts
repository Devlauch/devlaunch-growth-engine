import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDiskFileStorage, NotConfiguredS3FileStorage, NotConfiguredError } from "../src/lib/fileStorage.js";
import { verifySignedDownload } from "../src/lib/signedDownloadUrl.js";

// Real filesystem I/O against a real temp directory — same "exercise the
// real local-disk path for real, don't mock it away" posture as
// reports.test.ts's REPORT_FILES_DIR temp-dir pattern.
let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlaunch-lead-magnet-files-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("LocalDiskFileStorage", () => {
  it("writes a real file to disk and reads the exact same bytes back", async () => {
    const storage = new LocalDiskFileStorage(makeTmpDir());
    const buffer = Buffer.from("%PDF-1.4 fake pdf content for a test", "utf8");

    const result = await storage.upload(buffer, "whitepaper.pdf", "application/pdf");

    expect(result.key).toContain("whitepaper.pdf");
    expect(result.url).toContain("/api/v1/public/lead-magnet-downloads/");

    const readBack = await storage.readFile(result.key);
    expect(readBack.equals(buffer)).toBe(true);
  });

  it("sanitizes a malicious filename rather than allowing path traversal", async () => {
    const storage = new LocalDiskFileStorage(makeTmpDir());
    const buffer = Buffer.from("content", "utf8");

    const result = await storage.upload(buffer, "../../../etc/passwd", "application/pdf");

    // basename() strips any directory components before sanitizing, so the
    // key can never escape the storage root.
    expect(result.key).not.toContain("..");
    const readBack = await storage.readFile(result.key);
    expect(readBack.toString("utf8")).toBe("content");
  });

  it("two uploads of the same original filename never collide/overwrite each other", async () => {
    const storage = new LocalDiskFileStorage(makeTmpDir());
    const first = await storage.upload(Buffer.from("first"), "same-name.pdf", "application/pdf");
    const second = await storage.upload(Buffer.from("second"), "same-name.pdf", "application/pdf");

    expect(first.key).not.toBe(second.key);
    expect((await storage.readFile(first.key)).toString()).toBe("first");
    expect((await storage.readFile(second.key)).toString()).toBe("second");
  });

  it("delete() really removes the file from disk", async () => {
    const storage = new LocalDiskFileStorage(makeTmpDir());
    const result = await storage.upload(Buffer.from("x"), "f.pdf", "application/pdf");

    await storage.delete(result.key);

    await expect(storage.readFile(result.key)).rejects.toThrow();
  });

  it("getSignedDownloadUrl produces a URL whose signature verifies for real against signedDownloadUrl.ts", async () => {
    const storage = new LocalDiskFileStorage(makeTmpDir());
    const url = await storage.getSignedDownloadUrl("some/key.pdf", 3600);

    const parsed = new URL(url, "http://localhost");
    const key = decodeURIComponent(parsed.pathname.split("/").pop()!);
    const expires = parsed.searchParams.get("expires")!;
    const sig = parsed.searchParams.get("sig")!;

    expect(key).toBe("some/key.pdf");
    expect(verifySignedDownload(key, expires, sig)).toBe(true);
    // A different key must not validate against this signature (no cross-key replay).
    expect(verifySignedDownload("different/key.pdf", expires, sig)).toBe(false);
  });
});

describe("NotConfiguredS3FileStorage", () => {
  it("honestly throws NotConfiguredError rather than fabricating a successful upload", async () => {
    const storage = new NotConfiguredS3FileStorage();
    await expect(storage.upload(Buffer.from("x"), "f.pdf", "application/pdf")).rejects.toThrow(NotConfiguredError);
    await expect(storage.getSignedDownloadUrl("k", 60)).rejects.toThrow(NotConfiguredError);
    await expect(storage.delete("k")).rejects.toThrow(NotConfiguredError);
  });
});
