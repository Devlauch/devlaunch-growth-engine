import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/httpError.js";
import { logger } from "../lib/logger.js";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path}` } });
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
      logger.error({ err, path: req.path }, "request failed");
    }
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  logger.error({ err, path: req.path }, "unhandled error");
  res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
}
