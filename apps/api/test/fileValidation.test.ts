import { describe, it, expect } from "vitest";
import { validateUploadedFile, sniffFileFamily } from "../src/lib/fileValidation.js";

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const EXE_BYTES = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // "MZ" (PE/EXE header)

describe("sniffFileFamily", () => {
  it("sniffs a real PDF signature", () => {
    expect(sniffFileFamily(PDF_BYTES)).toBe("pdf");
  });
  it("sniffs a real PNG signature", () => {
    expect(sniffFileFamily(PNG_BYTES)).toBe("png");
  });
  it("reports unknown for an executable's signature", () => {
    expect(sniffFileFamily(EXE_BYTES)).toBe("unknown");
  });
});

describe("validateUploadedFile", () => {
  const options = { maxSizeBytes: 1000 };

  it("accepts a real PDF declared as application/pdf", () => {
    const result = validateUploadedFile(PDF_BYTES, "application/pdf", options);
    expect(result.valid).toBe(true);
    expect(result.sniffedFamily).toBe("pdf");
  });

  it("rejects an empty file", () => {
    expect(validateUploadedFile(Buffer.alloc(0), "application/pdf", options).valid).toBe(false);
  });

  it("rejects a file over the max size", () => {
    const big = Buffer.concat([PDF_BYTES, Buffer.alloc(2000)]);
    const result = validateUploadedFile(big, "application/pdf", options);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });

  it("rejects a Content-Type not on the allowlist", () => {
    const result = validateUploadedFile(PDF_BYTES, "application/x-msdownload", options);
    expect(result.valid).toBe(false);
  });

  it("catches a renamed-extension attack: an .exe relabeled as application/pdf", () => {
    const result = validateUploadedFile(EXE_BYTES, "application/pdf", options);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match any allowed file signature/);
  });

  it("catches a mismatched declared type vs real content (PNG bytes declared as PDF)", () => {
    const result = validateUploadedFile(PNG_BYTES, "application/pdf", options);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/renamed-extension/);
  });
});
