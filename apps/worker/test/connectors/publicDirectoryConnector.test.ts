import { describe, it, expect } from "vitest";
import {
  PublicDirectoryConnector,
  NotConfiguredDirectoryApiClient,
  NotConfiguredError,
  OverpassDirectoryApiClient,
  UnsupportedIndustryError,
  type DirectoryApiClient,
  type RawDirectoryListing,
} from "../../src/connectors/publicDirectoryConnector.js";
import type { ConnectorConfig } from "../../src/connectors/types.js";

const baseConfig: ConnectorConfig = {
  rateLimitPerMinute: 60,
  enabled: true,
  termsNote: "test",
};

describe("PublicDirectoryConnector honest-failure behavior", () => {
  it("throws NotConfiguredError rather than returning fake data when backed by the not-configured client", async () => {
    const connector = new PublicDirectoryConnector(new NotConfiguredDirectoryApiClient("Acme Licensed Directory"));

    await expect(
      connector.discover({ industry: "restaurant", geography: "Springfield" }, baseConfig),
    ).rejects.toThrow(NotConfiguredError);
  });

  it("never fabricates organizations on the not-configured path", async () => {
    const connector = new PublicDirectoryConnector(new NotConfiguredDirectoryApiClient());
    try {
      await connector.discover({ industry: "restaurant", geography: "Springfield" }, baseConfig);
      expect.fail("expected discover() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotConfiguredError);
    }
  });

  it("refuses to run when disabled for the tenant, even with a configured client", async () => {
    const fakeClient: DirectoryApiClient = {
      async search() {
        return [];
      },
    };
    const connector = new PublicDirectoryConnector(fakeClient);
    await expect(
      connector.discover(
        { industry: "restaurant", geography: "Springfield" },
        { ...baseConfig, enabled: false },
      ),
    ).rejects.toThrow(/disabled/);
  });

  it("rejects malformed input before calling the backend", async () => {
    const connector = new PublicDirectoryConnector(new NotConfiguredDirectoryApiClient());
    await expect(connector.discover({ industry: "restaurant" }, baseConfig)).rejects.toThrow();
  });

  it("declares its plug-in metadata and documents what's real vs. pluggable", () => {
    const connector = new PublicDirectoryConnector();
    expect(connector.id).toBe("public-directory");
    expect(connector.type).toBe("public_directory");
    expect(connector.termsNote.length).toBeGreaterThan(0);
    expect(connector.defaultRateLimitPerMinute).toBeGreaterThan(0);
  });
});

describe("PublicDirectoryConnector with a working (mocked) DirectoryApiClient", () => {
  it("maps RawDirectoryListing results into DiscoveredOrganization", async () => {
    const listings: RawDirectoryListing[] = [
      {
        name: "Springfield Diner",
        domain: "springfielddiner.example",
        sourceUrl: "https://springfielddiner.example",
        rawMetadata: { source: "test-fixture" },
      },
    ];
    const client: DirectoryApiClient = {
      async search() {
        return listings;
      },
    };
    const connector = new PublicDirectoryConnector(client);
    const result = await connector.discover(
      { industry: "restaurant", geography: "Springfield" },
      baseConfig,
    );

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]).toMatchObject({
      name: "Springfield Diner",
      domain: "springfielddiner.example",
      sourceUrl: "https://springfielddiner.example",
    });
    expect(result.organizations[0].discoveredAt).toBeTruthy();
    expect(result.contacts).toEqual({});
  });
});

describe("OverpassDirectoryApiClient (real client, network mocked for deterministic tests)", () => {
  it("rejects an unsupported industry without making a network call", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const client = new OverpassDirectoryApiClient("https://overpass-api.de/api/interpreter", fakeFetch);
    await expect(
      client.search({ industry: "spaceship-repair", geography: "Springfield" }),
    ).rejects.toThrow(UnsupportedIndustryError);
    expect(called).toBe(false);
  });

  it("requires a non-empty geography", async () => {
    const client = new OverpassDirectoryApiClient();
    await expect(client.search({ industry: "restaurant", geography: "" })).rejects.toThrow();
  });

  it("parses a mocked Overpass JSON response into listings", async () => {
    const mockResponse = {
      elements: [
        {
          type: "node",
          id: 123,
          lat: 39.78,
          lon: -89.65,
          tags: {
            name: "Springfield Diner",
            amenity: "restaurant",
            website: "https://www.springfielddiner.example/",
          },
        },
        {
          type: "node",
          id: 124,
          // No `name` tag — must be skipped as not a usable lead.
          tags: { amenity: "restaurant" },
        },
      ],
    };

    const fakeFetch = (async (_url: string, _init?: unknown) => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => mockResponse,
      } as Response;
    }) as unknown as typeof fetch;

    const client = new OverpassDirectoryApiClient("https://overpass-api.de/api/interpreter", fakeFetch);
    const listings = await client.search({ industry: "restaurant", geography: "Springfield" });

    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      name: "Springfield Diner",
      domain: "springfielddiner.example",
      sourceUrl: "https://www.springfielddiner.example/",
    });
    expect(listings[0].rawMetadata).toMatchObject({ source: "openstreetmap-overpass", osmId: 123 });
  });

  it("surfaces a non-ok HTTP response as an error instead of silently returning data", async () => {
    const fakeFetch = (async () => {
      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({ elements: [] }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new OverpassDirectoryApiClient("https://overpass-api.de/api/interpreter", fakeFetch);
    await expect(
      client.search({ industry: "restaurant", geography: "Springfield" }),
    ).rejects.toThrow(/503/);
  });
});
