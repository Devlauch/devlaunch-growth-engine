import { describe, it, expect, vi } from "vitest";
import {
  normalizeDomain,
  normalizeOrgName,
  normalizeContactName,
  findDuplicateContact,
} from "../src/lib/dedup.js";

describe("normalizeOrgName", () => {
  it("strips the Pty Ltd suffix (AU/NZ/ZA) so it dedups against the bare name", () => {
    // Regression for a real bug fixed in a prior round: "Acme Pty Ltd" only
    // had its trailing "ltd" stripped, normalizing to "acme pty" instead of
    // "acme" — silently failing to dedup against "Acme" listed elsewhere.
    expect(normalizeOrgName("Acme Pty Ltd")).toBe("acme");
    expect(normalizeOrgName("Acme")).toBe("acme");
  });
});

describe("normalizeContactName", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeContactName("Jane Doe")).toBe("jane doe");
    expect(normalizeContactName("  jane   doe  ")).toBe("jane doe");
    expect(normalizeContactName("JANE DOE")).toBe("jane doe");
  });

  it("returns an empty string for null/undefined/blank input", () => {
    expect(normalizeContactName(null)).toBe("");
    expect(normalizeContactName(undefined)).toBe("");
    expect(normalizeContactName("   ")).toBe("");
  });
});

describe("findDuplicateContact — name-fallback edge case", () => {
  /**
   * Regression test for a real dedup gap: the name-fallback match used to
   * compare `name = $2` verbatim (case-sensitive, no whitespace
   * normalization), unlike every other normalizer in this file
   * (normalizeDomain/normalizeOrgName/normalizeEmail all normalize before
   * comparing). Two connector runs surfacing "Jane Doe" and "jane  doe" for
   * the same organization (no email on either row — common for a
   * contact-form-only org) would NOT dedup, silently creating a second
   * discovered_contacts row for the same real person. This proves the fix:
   * the SQL now normalizes `name` the same way on both sides.
   */
  it("matches an existing contact whose name differs only by case/whitespace", async () => {
    const queryMock = vi.fn(async (sql: string, params: unknown[]) => {
      // No email match path is taken (no normalized_email in params for
      // this call); only the name-fallback query should run.
      expect(sql).toContain("lower(regexp_replace(trim(name)");
      expect(params[1]).toBe("jane doe"); // normalized form of "jane   doe"
      return { rowCount: 1, rows: [{ id: "contact-1", name: "Jane Doe", email: null }] };
    });

    const match = await findDuplicateContact({ query: queryMock } as never, "org-1", {
      email: null,
      name: "jane   doe",
    });

    expect(match).toEqual({ id: "contact-1", name: "Jane Doe", email: null });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when no contact matches by email or normalized name", async () => {
    const queryMock = vi.fn(async () => ({ rowCount: 0, rows: [] }));

    const match = await findDuplicateContact({ query: queryMock } as never, "org-1", {
      email: "nobody@example.com",
      name: "Nobody",
    });

    expect(match).toBeNull();
    // Both the email check and the name-fallback check should have run.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("skips the name-fallback query entirely when name is blank", async () => {
    const queryMock = vi.fn(async () => ({ rowCount: 0, rows: [] }));

    const match = await findDuplicateContact({ query: queryMock } as never, "org-1", {
      email: null,
      name: "   ",
    });

    expect(match).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("normalizeDomain — sanity check (unchanged behavior)", () => {
  it("still normalizes protocol/www/path/case", () => {
    expect(normalizeDomain("HTTPS://WWW.Example.com/path?x=1")).toBe("example.com");
  });
});
