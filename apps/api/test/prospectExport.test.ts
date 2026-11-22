import { describe, it, expect } from "vitest";
import { csvField, organizationsToCsv, contactsToCsv } from "../src/lib/prospectExport.js";

describe("csvField", () => {
  it("passes a plain value through unchanged", () => {
    expect(csvField("Acme Inc")).toBe("Acme Inc");
    expect(csvField(42)).toBe("42");
  });

  it("renders null/undefined as an empty field, never the literal string", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes and escapes a value containing a comma, quote, or newline", () => {
    expect(csvField("Springfield, USA")).toBe('"Springfield, USA"');
    expect(csvField('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
  });
});

describe("organizationsToCsv", () => {
  it("produces a header row plus one row per organization, in column order", () => {
    const csv = organizationsToCsv([
      {
        name: "Springfield Diner",
        domain: "springfielddiner.example",
        status: "new",
        source_confidence: "verified",
        discovered_at: "2024-01-01T00:00:00.000Z",
        source_url: "https://springfielddiner.example",
      },
    ]);

    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Name,Domain,Status,Source Confidence,Discovered At,Source URL");
    expect(lines[1]).toBe(
      "Springfield Diner,springfielddiner.example,new,verified,2024-01-01T00:00:00.000Z,https://springfielddiner.example",
    );
  });

  it("escapes a comma in an organization name instead of corrupting the column count", () => {
    const csv = organizationsToCsv([
      {
        name: "Acme, Inc.",
        domain: null,
        status: "new",
        source_confidence: "unconfirmed",
        discovered_at: "2024-01-01T00:00:00.000Z",
        source_url: null,
      },
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[1]?.startsWith('"Acme, Inc.",,new,unconfirmed,')).toBe(true);
  });

  it("produces just the header row (no trailing data) for an empty list", () => {
    const csv = organizationsToCsv([]);
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });

  it("accepts a Date object for discovered_at and serializes it to ISO", () => {
    const csv = organizationsToCsv([
      {
        name: "Acme",
        domain: null,
        status: "new",
        source_confidence: "verified",
        discovered_at: new Date("2024-06-15T12:00:00.000Z"),
        source_url: null,
      },
    ]);
    expect(csv).toContain("2024-06-15T12:00:00.000Z");
  });
});

describe("contactsToCsv", () => {
  it("produces a header row plus one row per contact, joined back to its organization", () => {
    const csv = contactsToCsv([
      {
        organization_name: "Acme Inc",
        organization_domain: "acme.com",
        name: "Jane Doe",
        role_title: "Owner",
        email: "jane@acme.com",
        phone: null,
        contact_channel: "named_person",
        verification_status: "verified",
        source_confidence: "verified",
      },
    ]);

    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "Organization,Organization Domain,Contact Name,Role / Title,Email,Phone,Contact Channel,Verification Status,Source Confidence",
    );
    expect(lines[1]).toBe("Acme Inc,acme.com,Jane Doe,Owner,jane@acme.com,,named_person,verified,verified");
  });
});
