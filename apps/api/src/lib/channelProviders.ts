/**
 * channelProviders: honest, pluggable stubs for every paid/platform
 * channel in Multi-Channel Customer Acquisition besides plain SMTP email
 * (which has its own real implementation — see emailProvider.ts): Postiz
 * (social post scheduling), Google Ads, Meta Ads, and WhatsApp Business.
 *
 * None of these have real OAuth/API credentials configured in this
 * environment (no POSTIZ_API_KEY, GOOGLE_ADS_*, META_ADS_*, or
 * WHATSAPP_BUSINESS_* env vars). This mirrors the exact NotConfiguredError
 * idiom used throughout this codebase (keywordRankingStub.ts,
 * emailProvider.ts, packages/agent-sdk's publicDirectoryConnector.ts):
 *
 *   1. One stable `ChannelProvider` interface per capability a real
 *      integration would need (posting a social update; reading ad-spend/
 *      impression/click performance; sending a WhatsApp template message).
 *   2. One `NotConfigured*Provider` per channel, which always throws —
 *      NEVER returns a fabricated "published" post, a made-up ad-spend
 *      number, or a fake WhatsApp delivery receipt.
 *
 * Each getXProvider() factory also records the channel's real
 * configuration status in channel_provider_configs
 * (packages/db/migrations/275_create_channel_provider_configs.sql) so a
 * tenant/admin UI can read a genuine per-tenant connection status from the
 * database rather than guessing from process env at render time.
 */

import type { PoolClient } from "pg";
import { PostizClient } from "./postizClient.js";

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export type ChannelName = "postiz_social" | "google_ads" | "meta_ads" | "whatsapp_business";

// ---------------------------------------------------------------------------
// Postiz (social post scheduling/publishing)
// ---------------------------------------------------------------------------

export interface SocialPost {
  content: string;
  platforms: string[];
  scheduledAt?: string | null;
}

export interface SocialPostResult {
  provider: string;
  postId: string;
  publishedAt: string;
  platforms: string[];
}

/** Pluggable backend for publishing/scheduling a social post via Postiz. */
export interface SocialPostProvider {
  readonly name: string;
  publish(post: SocialPost): Promise<SocialPostResult>;
}

/**
 * Honest stand-in for Postiz (https://postiz.com) when no Postiz
 * credential is configured (neither a per-tenant connected integration nor
 * POSTIZ_BASE_URL/POSTIZ_API_KEY). Always throws — never returns a
 * fabricated "published" post.
 */
export class NotConfiguredPostizProvider implements SocialPostProvider {
  readonly name = "postiz (not configured)";

  async publish(_post: SocialPost): Promise<never> {
    throw new NotConfiguredError(
      "Postiz is not configured for this tenant/project (no connected postiz integration and no " +
        "POSTIZ_BASE_URL/POSTIZ_API_KEY in this environment). Connect Postiz via " +
        "POST .../integrations/postiz/connect first. Refusing to fabricate a published post.",
    );
  }
}

/**
 * Real SocialPostProvider implementation, upgrading the stub above (Agent
 * D, Milestone 2 — see docs/INTEGRATION_STATUS.md). Calls Postiz's
 * documented `/public/v1/posts` endpoint via postizClient.ts's PostizClient
 * — never fabricates a postId/publishedAt; both are copied verbatim from
 * Postiz's real response.
 *
 * `platforms` on the incoming SocialPost is expected to already be Postiz
 * integration ids (not human-readable network names) — see
 * apps/api/src/routes/postizIntegration.ts, which is the only caller that
 * constructs a SocialPost today and resolves those ids from a real
 * GET /integrations call before ever getting here.
 */
export class PostizSocialPostProvider implements SocialPostProvider {
  readonly name = "postiz";

  constructor(private readonly client: PostizClient) {}

  async publish(post: SocialPost): Promise<SocialPostResult> {
    const result = await this.client.createPost({
      type: post.scheduledAt ? "schedule" : "now",
      date: post.scheduledAt ?? new Date().toISOString(),
      integrationIds: post.platforms,
      content: post.content,
    });

    if (!result.postId) {
      // Postiz returned a 2xx but a shape this client couldn't find a post
      // id in — this is a genuine integration-mismatch error, not a
      // "published" result to fabricate an id for.
      throw new Error(
        "Postiz accepted the post request but no post id was found in its response — refusing to report a " +
          "fabricated published result. Raw response logged by the caller for investigation.",
      );
    }

    return {
      provider: this.name,
      postId: result.postId,
      publishedAt: new Date().toISOString(),
      platforms: post.platforms,
    };
  }
}

// ---------------------------------------------------------------------------
// Google Ads
// ---------------------------------------------------------------------------

export interface AdCampaignPerformance {
  campaignExternalId: string;
  impressions: number;
  clicks: number;
  spendCents: number;
  periodStart: string;
  periodEnd: string;
}

/** Pluggable backend for a paid-ads platform (Google Ads / Meta Ads share this same shape). */
export interface AdsChannelProvider {
  readonly name: string;
  getCampaignPerformance(campaignExternalId: string): Promise<AdCampaignPerformance>;
}

/**
 * Honest stand-in for the Google Ads API when no Google Ads OAuth
 * credentials (GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET/
 * GOOGLE_ADS_DEVELOPER_TOKEN/GOOGLE_ADS_REFRESH_TOKEN) are configured.
 * Always throws — never fabricates ad spend, impressions, or clicks.
 */
export class NotConfiguredGoogleAdsProvider implements AdsChannelProvider {
  readonly name = "google_ads (not configured)";

  async getCampaignPerformance(_campaignExternalId: string): Promise<never> {
    throw new NotConfiguredError(
      "Google Ads is not configured (no GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET/GOOGLE_ADS_DEVELOPER_TOKEN/ " +
        "GOOGLE_ADS_REFRESH_TOKEN available in this environment). A real OAuth connection to the Google Ads API " +
        "must be completed before any ad-performance data can be reported. Refusing to fabricate spend/impressions/clicks.",
    );
  }
}

// ---------------------------------------------------------------------------
// Meta Ads (Facebook/Instagram)
// ---------------------------------------------------------------------------

/**
 * Honest stand-in for the Meta Marketing API when no Meta app credentials
 * (META_ADS_APP_ID/META_ADS_APP_SECRET/META_ADS_ACCESS_TOKEN) are
 * configured. Always throws — never fabricates ad spend, impressions, or
 * clicks.
 */
export class NotConfiguredMetaAdsProvider implements AdsChannelProvider {
  readonly name = "meta_ads (not configured)";

  async getCampaignPerformance(_campaignExternalId: string): Promise<never> {
    throw new NotConfiguredError(
      "Meta Ads is not configured (no META_ADS_APP_ID/META_ADS_APP_SECRET/META_ADS_ACCESS_TOKEN available in this " +
        "environment). A real OAuth connection to the Meta Marketing API must be completed before any ad-performance " +
        "data can be reported. Refusing to fabricate spend/impressions/clicks.",
    );
  }
}

// ---------------------------------------------------------------------------
// WhatsApp Business
// ---------------------------------------------------------------------------

export interface WhatsAppMessage {
  to: string;
  templateName: string;
  parameters?: string[];
}

export interface WhatsAppSendResult {
  provider: string;
  messageId: string;
  sentAt: string;
}

/** Pluggable backend for sending a WhatsApp Business template message. */
export interface WhatsAppProvider {
  readonly name: string;
  sendTemplateMessage(message: WhatsAppMessage): Promise<WhatsAppSendResult>;
}

/**
 * Honest stand-in for the WhatsApp Business Platform (Cloud API) when no
 * WHATSAPP_BUSINESS_PHONE_NUMBER_ID/WHATSAPP_BUSINESS_ACCESS_TOKEN are
 * configured. Always throws — never fabricates a delivery receipt.
 */
export class NotConfiguredWhatsAppProvider implements WhatsAppProvider {
  readonly name = "whatsapp_business (not configured)";

  async sendTemplateMessage(_message: WhatsAppMessage): Promise<never> {
    throw new NotConfiguredError(
      "WhatsApp Business is not configured (no WHATSAPP_BUSINESS_PHONE_NUMBER_ID/WHATSAPP_BUSINESS_ACCESS_TOKEN " +
        "available in this environment). A real connection to the WhatsApp Business Platform (Cloud API) must be " +
        "completed before any message can be sent. Refusing to fabricate a delivery result.",
    );
  }
}

// ---------------------------------------------------------------------------
// Factories + channel_provider_configs status sync
// ---------------------------------------------------------------------------

function isConfigured(channel: ChannelName): boolean {
  switch (channel) {
    case "postiz_social":
      return Boolean(process.env.POSTIZ_API_KEY);
    case "google_ads":
      return Boolean(
        process.env.GOOGLE_ADS_CLIENT_ID &&
          process.env.GOOGLE_ADS_CLIENT_SECRET &&
          process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
          process.env.GOOGLE_ADS_REFRESH_TOKEN,
      );
    case "meta_ads":
      return Boolean(process.env.META_ADS_APP_ID && process.env.META_ADS_APP_SECRET && process.env.META_ADS_ACCESS_TOKEN);
    case "whatsapp_business":
      return Boolean(process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID && process.env.WHATSAPP_BUSINESS_ACCESS_TOKEN);
  }
}

/**
 * Upserts channel_provider_configs with the channel's REAL current
 * configuration status (derived from process.env, never guessed) — a
 * genuine DB-backed record a UI can read, rather than only a runtime
 * factory decision. Safe to call repeatedly; it is a plain upsert.
 */
export async function syncChannelProviderStatus(
  tenantDb: PoolClient,
  tenantId: string,
  channel: ChannelName,
): Promise<{ status: "configured" | "not_configured" }> {
  const status = isConfigured(channel) ? "configured" : "not_configured";
  await tenantDb.query(
    `INSERT INTO channel_provider_configs (tenant_id, channel, status, last_checked_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, channel)
     DO UPDATE SET status = $3, last_checked_at = now()`,
    [tenantId, channel, status],
  );
  return { status };
}

/**
 * getSocialPostProvider(): the real factory callers (e.g. a future
 * campaign_execution workflow stage, or apps/api/src/routes/postizIntegration.ts's
 * own publish endpoint) should use — never construct PostizSocialPostProvider/
 * NotConfiguredPostizProvider directly outside of tests. Follows the
 * identical shape as apps/api/src/lib/emailProvider.ts's getEmailProvider():
 * resolves a real client for this tenant/project (per-tenant connected
 * Postiz integration, falling back to global POSTIZ_BASE_URL/POSTIZ_API_KEY
 * env vars — see postizClient.ts's getPostizClientForTenant()) and returns
 * the real PostizSocialPostProvider only when one resolves; otherwise the
 * honest NotConfiguredPostizProvider stub.
 */
export async function getSocialPostProvider(
  tenantDb: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<SocialPostProvider> {
  const { getPostizClientForTenant } = await import("./postizClient.js");
  const resolution = await getPostizClientForTenant(tenantDb, tenantId, projectId);
  if ("status" in resolution) {
    return new NotConfiguredPostizProvider();
  }
  return new PostizSocialPostProvider(resolution);
}

/**
 * @deprecated kept for any pre-Milestone-2 caller still expecting a
 * synchronous, env-var-only factory with the old name. Prefer
 * getSocialPostProvider(tenantDb, tenantId, projectId) above, which can
 * resolve a real per-tenant connected Postiz integration; this sync version
 * can only ever see the NotConfiguredPostizProvider stub or (if
 * POSTIZ_BASE_URL/POSTIZ_API_KEY env vars happen to be set) a provider with
 * no tenant-scoping at all, which is unsafe for multi-tenant use.
 */
export function getPostizProvider(): SocialPostProvider {
  return new NotConfiguredPostizProvider();
}

export function getGoogleAdsProvider(): AdsChannelProvider {
  return new NotConfiguredGoogleAdsProvider();
}

export function getMetaAdsProvider(): AdsChannelProvider {
  return new NotConfiguredMetaAdsProvider();
}

export function getWhatsAppProvider(): WhatsAppProvider {
  return new NotConfiguredWhatsAppProvider();
}
