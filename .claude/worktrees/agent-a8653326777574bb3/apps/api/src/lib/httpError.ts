export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  unauthorized: (message = "Authentication required") => new HttpError(401, "unauthorized", message),
  forbidden: (message = "Not allowed to access this resource") => new HttpError(403, "forbidden", message),
  notFound: (message = "Not found") => new HttpError(404, "not_found", message),
  conflict: (message = "Conflict") => new HttpError(409, "conflict", message),
  badRequest: (message = "Bad request", details?: unknown) => new HttpError(400, "bad_request", message, details),
  // Used for subscription-plan quota enforcement (see src/lib/quota.ts).
  // 402 "Payment Required" is the closest standard status for "you've hit
  // your plan's limit" — note this never means a real payment was
  // attempted/processed; there is no payment processor in this codebase.
  paymentRequired: (message = "Plan limit reached") => new HttpError(402, "plan_limit_exceeded", message),
  tooManyRequests: (message = "Too many requests") => new HttpError(429, "rate_limited", message),
  internal: (message = "Internal server error") => new HttpError(500, "internal_error", message),
  badGateway: (message = "Upstream source failed") => new HttpError(502, "bad_gateway", message),
};
