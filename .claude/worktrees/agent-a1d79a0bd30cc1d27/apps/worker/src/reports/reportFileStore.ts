import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where generated report PDFs are persisted. This environment has no
 * object storage (S3/etc) configured (checked docker-compose.yml and
 * .env.example — there isn't one), so files live on a local volume shared
 * between apps/worker (which writes them) and apps/api (which streams them
 * back via the authenticated GET .../reports/:id/download route — never a
 * public URL). See the `report_files` volume added to docker-compose.yml.
 */
export function reportFilesDir(): string {
  return process.env.REPORT_FILES_DIR ?? path.join(process.cwd(), "report_files");
}

/** Path stored in generated_reports.file_path — relative to reportFilesDir(), never absolute. */
export function reportRelativePath(tenantId: string, reportId: string): string {
  return path.posix.join(tenantId, `${reportId}.pdf`);
}

export async function saveReportFile(relativePath: string, buffer: Buffer): Promise<void> {
  const fullPath = path.join(reportFilesDir(), relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, buffer);
}
