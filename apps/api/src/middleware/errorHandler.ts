import type { Request, Response, NextFunction } from "express";
import * as Sentry from "@sentry/node";
import { ZodError } from "zod";
import { HttpError } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path}` } });
}

// Reports every unhandled/5xx-and-above error to Sentry BEFORE the existing
// logging/response-shape logic below runs. A validation error (ZodError,
// handled as a 400) is an expected client mistake, not reported. When
// SENTRY_DSN is unset, Sentry.init() was never called (see index.ts) and
// Sentry's own SDK makes captureException() a safe no-op in that case — but
// we still only ever call it for genuine 500s/unhandled errors, never for
// expected 4xx responses.
function reportToSentry(err: unknown): void {
  Sentry.captureException(err);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "validation_error", message: "Request validation failed", details: err.flatten() },
    });
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) {
      reportToSentry(err);
      logger.error({ err, path: req.path }, "request failed");
    }
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  reportToSentry(err);
  logger.error({ err, path: req.path }, "unhandled error");
  res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
}
