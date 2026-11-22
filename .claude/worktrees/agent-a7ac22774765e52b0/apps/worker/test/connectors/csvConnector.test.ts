import { describe, it, expect } from "vitest";
import {
  CsvUploadConnector,
  CsvFormatError,
  parseCsvRecords,
} from "../../src/connectors/csvConnector.js";
import type { ConnectorConfig } from "../../src/connectors/types.js";

const baseConfig: ConnectorConfig = {
  rateLimitPerMinute: 60,
  enabled: true,
  termsNote: "test",
};

describe("parseCsvRecords (hand-rolled RFC4180-ish parser)", () => {
  it("parses simple comma-separated rows", () => {
    const records = parseCsvRecords("a,b,c\n1,2,3\n");
    expect(records).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields containing commas", () => {
    const records = parseCsvRecords('name,note\n"Acme, Inc.",hello\n');
    expect(records).toEqual([
      ["name", "note"],
      ["Acme, Inc.", "hello"],
    ]);
  });

  it("handles escaped quotes within a quoted field", () => {
    const records = parseCsvRecords('name\n"She said ""hi"""\n');
    expect(records).toEqual([["name"], ['She said "hi"']]);
  });

  it("handles CRLF line endings", () => {
    const records = parseCsvRecords("a,b\r\n1,2\r\n");
    expect(records).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles mixed CRLF/LF line endings", () => {
    const records = parseCsvRecords("a,b\r\n1,2\n3,4\r\n");
    expect(records).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles a file with no trailing newline", () => {
    const records = parseCsvRecords("a,b\n1,2");
    expect(records).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("does not produce a spurious trailing row for a trailing newline", () => {
    const records = parseCsvRecords("a,b\n1,2\n");
    expect(records.length).toBe(2);
  });

  it("handles empty optional fields", () => {
    const records = parseCsvRecords("a,b,c\n1,,3\n");
    expect(records).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("CsvUploadConnector", () => {
  const connector = new CsvUploadConnector();

  it("parses a well-formed CSV into organizations + contacts", async () => {
    const csv =
      "organization_name,domain,contact_name,contact_email,contact_phone,role_title,source_url\n" +
      "Acme University,https://www.acme.edu,Jane Doe,jane@acme.edu,555-1234,Admissions Director,https://acme.edu/contact\n";

    const result = await connector.discover(csv, baseConfig);

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]).toMatchObject({
      name: "Acme University",
      domain: "acme.edu",
      sourceUrl: "https://acme.edu/contact",
    });
    expect(result.organizations[0].discoveredAt).toBeTruthy();

    const contacts = result.contacts["Acme University"];
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: "Jane Doe",
      roleTitle: "Admissions Director",
      email: "jane@acme.edu",
      phone: "555-1234",
      contactChannel: "named_person",
    });
  });

  it("groups multiple contact rows under the same organization", async () => {
    const csv =
      "organization_name,domain,contact_name,contact_email\n" +
      "Acme University,acme.edu,Jane Doe,jane@acme.edu\n" +
      "Acme University,acme.edu,John Smith,john@acme.edu\n";

    const result = await connector.discover(csv, baseConfig);
    expect(result.organizations).toHaveLength(1);
    expect(result.contacts["Acme University"]).toHaveLength(2);
  });

  it("skips rows missing the required organization_name", async () => {
    const csv =
      "organization_name,contact_email\n" +
      ",noorg@example.com\n" +
      "Real Org,ok@example.com\n";

    const result = await connector.discover(csv, baseConfig);
    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0].name).toBe("Real Org");
  });

  it("handles missing optional columns gracefully", async () => {
    const csv = "organization_name\nJust A Name\n";
    const result = await connector.discover(csv, baseConfig);
    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0].domain).toBeUndefined();
    expect(result.contacts["Just A Name"]).toEqual([]);
  });

  it("classifies contact channel from available fields", async () => {
    const csv =
      "organization_name,contact_phone\n" +
      "Phone Only Org,555-0000\n";
    const result = await connector.discover(csv, baseConfig);
    expect(result.contacts["Phone Only Org"][0].contactChannel).toBe("phone");
  });

  it("rejects an empty CSV file", async () => {
    await expect(connector.discover("", baseConfig)).rejects.toThrow(CsvFormatError);
  });

  it("rejects a CSV missing the required header", async () => {
    const csv = "name,email\nAcme,a@b.com\n";
    await expect(connector.discover(csv, baseConfig)).rejects.toThrow(CsvFormatError);
  });

  it("rejects input that isn't a string or { csvText }", async () => {
    await expect(connector.discover(42, baseConfig)).rejects.toThrow(CsvFormatError);
  });

  it("refuses to run when disabled for the tenant", async () => {
    await expect(
      connector.discover("organization_name\nAcme\n", { ...baseConfig, enabled: false }),
    ).rejects.toThrow(/disabled/);
  });

  it("declares its plug-in metadata", () => {
    expect(connector.id).toBe("csv-upload");
    expect(connector.type).toBe("csv_upload");
    expect(connector.termsNote.length).toBeGreaterThan(0);
    expect(connector.defaultRateLimitPerMinute).toBeGreaterThan(0);
  });
});
