import { env } from "../config/env.js";

/**
 * Booking-provider abstraction for the Sales Conversion Agent's "Booking
 * integration" roadmap item.
 *
 * The one real, always-available path for getting a meeting onto the
 * `meetings` table (packages/db/migrations/280_create_meetings.sql) is
 * manual entry: a sales rep records a scheduled meeting themselves via
 * POST .../meetings with bookingProvider omitted/"manual" — that path
 * needs no provider at all and is handled directly in
 * apps/api/src/routes/meetings.ts.
 *
 * This module exists ONLY for the other path: a real Calendly-style
 * external booking integration, which this codebase does not have
 * credentials for in any environment it has been run in (no
 * CALENDLY_API_KEY, here or anywhere else — see src/routes/integrations.ts
 * for the same "registry, not a working connection" idiom applied to
 * Twenty/Mautic/Postiz/etc). Exactly one implementation exists today:
 * NotConfiguredBookingProvider, which never fabricates a real booking and
 * always says so honestly. getBookingProvider() is the single place that
 * decides which implementation a caller gets, so that decision is never
 * duplicated across routes.
 *
 * If a real CALENDLY_API_KEY is ever configured, a real
 * CalendlyBookingProvider belongs here, built against Calendly's actual
 * API — NOT invented blind in this change (there is no reviewed API
 * contract or test fixture for it in this codebase), so for now a
 * configured key still yields an honest "integration not implemented yet"
 * provider rather than a provider that silently pretends to talk to
 * Calendly. This is the same conservative choice meetings.ts's manual path
 * documents: never claim an external booking happened without real,
 * verified provider code behind it.
 */
export interface BookingProviderStatus {
  provider: "manual" | "calendly";
  configured: boolean;
  status: "available" | "not_configured" | "not_implemented";
  note: string;
}

export interface BookingProvider {
  readonly name: "manual" | "calendly";
  describe(): BookingProviderStatus;
  /**
   * Attempts to create a real booking via this provider. The manual path
   * never calls this (it writes directly to `meetings`); only an external
   * provider implementation would. Throws for every implementation that
   * exists today — see class docs.
   */
  createBooking(): Promise<never>;
}

/**
 * The manual path is not a "provider" in the external-API sense — it is
 * documented here only so callers have one place to ask "is anything
 * configured for X" without special-casing 'manual'.
 */
export class ManualBookingProvider implements BookingProvider {
  readonly name = "manual" as const;

  describe(): BookingProviderStatus {
    return {
      provider: "manual",
      configured: true,
      status: "available",
      note: "Manual entry: a sales rep records a scheduled meeting directly. No external credentials required.",
    };
  }

  async createBooking(): Promise<never> {
    throw new Error(
      "ManualBookingProvider.createBooking() should never be called — record a meeting directly via POST .../meetings instead.",
    );
  }
}

/**
 * Honest stub for the Calendly-style integration. Used whenever
 * env.calendlyApiKey is not set (every environment this codebase has run
 * in so far). Never fabricates a booking, an event id, or a scheduling
 * link.
 */
export class NotConfiguredBookingProvider implements BookingProvider {
  readonly name = "calendly" as const;

  describe(): BookingProviderStatus {
    return {
      provider: "calendly",
      configured: false,
      status: "not_configured",
      note: "No CALENDLY_API_KEY (or equivalent) is configured in this environment. Use the manual meeting-entry path (POST .../meetings) instead — this stub never fabricates a real external booking.",
    };
  }

  async createBooking(): Promise<never> {
    throw new Error(
      "Calendly booking provider is not configured (missing CALENDLY_API_KEY). Record the meeting manually instead.",
    );
  }
}

/**
 * Placeholder for when a CALENDLY_API_KEY IS present. Deliberately still
 * refuses to perform a real booking — see this module's header comment for
 * why a configured key alone is not sufficient to safely implement a real
 * integration here. Upgrading this to a real CalendlyBookingProvider is
 * future, reviewed work.
 */
export class NotImplementedBookingProvider implements BookingProvider {
  readonly name = "calendly" as const;

  describe(): BookingProviderStatus {
    return {
      provider: "calendly",
      configured: true,
      status: "not_implemented",
      note: "CALENDLY_API_KEY is set, but no real Calendly API integration has been implemented in this codebase yet. Use the manual meeting-entry path (POST .../meetings) instead — this stub still never fabricates a real external booking.",
    };
  }

  async createBooking(): Promise<never> {
    throw new Error(
      "Calendly booking provider has a key configured but is not yet implemented. Record the meeting manually instead.",
    );
  }
}

/** The single place that decides which external booking-provider implementation a caller gets. */
export function getBookingProvider(): BookingProvider {
  if (!env.calendlyApiKey) return new NotConfiguredBookingProvider();
  return new NotImplementedBookingProvider();
}
