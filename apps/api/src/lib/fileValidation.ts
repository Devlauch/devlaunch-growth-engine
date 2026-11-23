/**
 * Real file-upload validation for lead-magnet uploads (Milestone 3): a
 * MIME-type allowlist, a configurable max-size check, and magic-byte
 * ("file signature") sniffing of the actual bytes — never trusting the
 * client-supplied `Content-Type` header alone, which is exactly what a
 * renamed-extension attack (e.g. `malware.exe` uploaded as
 * `whitepaper.pdf` with `Content-Type: application/pdf`) relies on.
 *
 * This is deliberately a small, explicit allowlist of common lead-magnet
 * document/image formats, not a generic "detect any file type" library —
 * every entry here is a format this platform is willing to serve back to
 * an anonymous visitor via the public download link.
 */

export type AllowedLeadMagnetMimeType =
  | "application/pdf"
  | "application/msword"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.ms-excel"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.ms-powerpoint"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/** The declared Content-Type values this platform will accept at all. */
export const ALLOWED_LEAD_MAGNET_MIME_TYPES: readonly AllowedLeadMagnetMimeType[] = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * Coarse "sniffed family" a magic-byte signature maps to. Modern Office
 * formats (.docx/.xlsx/.pptx) are all ZIP containers — the signature alone
 * can't tell them apart (that requires inspecting the ZIP's internal
 * `[Content_Types].xml`, which this deliberately does not do, to keep this
 * a real-but-bounded check) — so "zip_office" is accepted as consistent
 * with any of the three declared Office MIME types in that family. Legacy
 * binary Office formats (.doc/.xls/.ppt) share the OLE2 compound-file
 * signature for the same reason ("ole2_office").
 */
type SniffedFamily = "pdf" | "png" | "jpeg" | "gif" | "webp" | "zip_office" | "ole2_office" | "unknown";

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** Sniffs the real file family from its leading bytes. Never trusts a declared Content-Type. */
export function sniffFileFamily(buffer: Buffer): SniffedFamily {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // "%PDF-"
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return "gif"; // "GIF8"
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp"; // "RIFF"....."WEBP"
  }
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])) {
    return "zip_office"; // "PK\x03\x04" (or an empty-archive "PK\x05\x06")
  }
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole2_office";
  return "unknown";
}

const FAMILY_TO_ALLOWED_MIME_TYPES: Record<Exclude<SniffedFamily, "unknown">, AllowedLeadMagnetMimeType[]> = {
  pdf: ["application/pdf"],
  png: ["image/png"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  zip_office: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ole2_office: ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"],
};

export interface FileValidationResult {
  valid: boolean;
  reason?: string;
  sniffedFamily?: SniffedFamily;
}

export interface FileValidationOptions {
  maxSizeBytes: number;
}

/**
 * Validates an uploaded file buffer against the declared Content-Type: size
 * limit, MIME-type allowlist, AND that the real magic-byte signature of the
 * bytes is consistent with the declared type — a file renamed/relabeled to
 * impersonate an allowed type (e.g. an .exe saved as "report.pdf" with a
 * spoofed Content-Type) is rejected here, not just by extension/header
 * trust.
 */
export function validateUploadedFile(
  buffer: Buffer,
  declaredContentType: string,
  options: FileValidationOptions,
): FileValidationResult {
  if (buffer.length === 0) {
    return { valid: false, reason: "File is empty" };
  }
  if (buffer.length > options.maxSizeBytes) {
    return { valid: false, reason: `File exceeds the ${options.maxSizeBytes}-byte maximum` };
  }
  if (!ALLOWED_LEAD_MAGNET_MIME_TYPES.includes(declaredContentType as AllowedLeadMagnetMimeType)) {
    return { valid: false, reason: `Content-Type "${declaredContentType}" is not an allowed file type` };
  }

  const family = sniffFileFamily(buffer);
  if (family === "unknown") {
    return { valid: false, reason: "File content does not match any allowed file signature", sniffedFamily: family };
  }

  const allowedForFamily = FAMILY_TO_ALLOWED_MIME_TYPES[family];
  if (!allowedForFamily.includes(declaredContentType as AllowedLeadMagnetMimeType)) {
    return {
      valid: false,
      reason: `Declared Content-Type "${declaredContentType}" does not match the file's real content (sniffed as ${family}) — possible renamed-extension attack`,
      sniffedFamily: family,
    };
  }

  return { valid: true, sniffedFamily: family };
}
