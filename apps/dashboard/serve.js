// Zero-dependency static file server for the built dashboard (dist/),
// used in production/docker-compose instead of `vite preview` so the
// runtime image doesn't need Vite itself. Mirrors the old placeholder
// server's shape (including /healthz) but serves a real SPA build with a
// history-API fallback to index.html for client-side routes.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");
const port = process.env.PORT ?? 3000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

async function serveFile(res, filePath) {
  const body = await readFile(filePath);
  const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  const urlPath = (req.url ?? "/").split("?")[0];
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(distDir, safePath === "/" ? "index.html" : safePath);

  try {
    await serveFile(res, candidate);
  } catch {
    // Unknown path (e.g. a client-side route like /tenants/123): fall
    // back to index.html so React Router can handle it.
    try {
      await serveFile(res, join(distDir, "index.html"));
    } catch {
      res.writeHead(500);
      res.end("dashboard: failed to read dist/index.html — did the build run?");
    }
  }
});

server.listen(port, () => {
  console.log(`[dashboard] listening on :${port}`);
});
