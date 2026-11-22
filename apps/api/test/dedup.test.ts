import { describe, it, expect, vi } from "vitest";
import {
  normalizeDomain,
  normalizeOrgName,
  normalizeContactName,
  findDuplicateContact,
  levenshteinDistance,
  orgNameSimilarity,
  isFuzzyOrgNameMatch,
  findPossibleDuplicateOrganization,
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

// ---------------------------------------------------------------------------
// Fuzzy org-name dedup (ported from milestone3-phase2 Track 2, added
// alongside master's existing exact-match tier — not a replacement).
// ---------------------------------------------------------------------------

describe("levenshteinDistance", () => {
  it("is 0 for identical strings", () => {
    expect(levenshteinDistance("acme", "acme")).toBe(0);
  });

  it("counts a single substitution", () => {
    expect(levenshteinDistance("acme", "acne")).toBe(1);
  });

  it("handles empty-string edges", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
    expect(levenshteinDistance("", "")).toBe(0);
  });
});

describe("orgNameSimilarity", () => {
  it("returns 1 for identical normalized names", () => {
    expect(orgNameSimilarity("acme robotics", "acme robotics")).toBe(1);
  });

  it("scores a minor typo highly via Levenshtein", () => {
    expect(orgNameSimilarity("acme technologies", "acme technologie")).toBeGreaterThan(0.9);
  });

  it("scores word-reordering highly via token overlap", () => {
    // Levenshtein alone would score this poorly (whole-word shuffle), but
    // token-overlap (Jaccard) catches it.
    expect(orgNameSimilarity("acme global robotics", "global acme robotics")).toBe(1);
  });

  it("scores unrelated names low", () => {
    expect(orgNameSimilarity("acme consulting", "beta industries")).toBeLessThan(0.5);
  });
});

describe("isFuzzyOrgNameMatch", () => {
  it("is false for identical strings (that's the exact-match tier's job)", () => {
    expect(isFuzzyOrgNameMatch("acme", "acme")).toBe(false);
  });

  it("is true for a near-miss name above the threshold", () => {
    expect(isFuzzyOrgNameMatch("acme technologies", "acme technologie")).toBe(true);
  });

  it("is false for unrelated names below the threshold", () => {
    expect(isFuzzyOrgNameMatch("acme consulting", "beta industries")).toBe(false);
  });

  it("is false for very short normalized names, even if superficially similar", () => {
    // "co" vs "co2" — short names produce noisy coincidental scores and are
    // excluded from the fuzzy tier entirely.
    expect(isFuzzyOrgNameMatch("co", "co2")).toBe(false);
  });
});

describe("findPossibleDuplicateOrganization", () => {
  it("flags the best-scoring near-miss candidate without writing anything", async () => {
    const queryMock = vi.fn(async () => ({
      rowCount: 2,
      rows: [
        { id: "org-close", name: "Acme Technologie", domain: "acme.io", normalized_name: "acme technologie" },
        { id: "org-unrelated", name: "Beta Industries", domain: "beta.com", normalized_name: "beta industries" },
      ],
    }));

    const match = await findPossibleDuplicateOrganization({ query: queryMock } as never, "project-1", {
      name: "Acme Technologies",
    });

    expect(match).toEqual({ id: "org-close", name: "Acme Technologie", domain: "acme.io" });
    // Read-only: a single SELECT, no INSERT/UPDATE/DELETE/MERGE statement of
    // any kind was issued by this call.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/^\s*SELECT/i);
  });

  it("returns null when no candidate clears the fuzzy threshold", async () => {
    const queryMock = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ id: "org-unrelated", name: "Beta Industries", domain: "beta.com", normalized_name: "beta industries" }],
    }));

    const match = await findPossibleDuplicateOrganization({ query: queryMock } as never, "project-1", {
      name: "Acme Technologies",
    });

    expect(match).toBeNull();
  });

  it("returns null for a blank/too-short name without querying", async () => {
    const queryMock = vi.fn(async () => ({ rowCount: 0, rows: [] }));

    const match = await findPossibleDuplicateOrganization({ query: queryMock } as never, "project-1", {
      name: "co",
    });

    expect(match).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  /**
   * HARD REQUIREMENT (spec): fuzzy matching is flag-only and must NEVER
   * trigger an automatic merge or write on its own. This test proves that
   * guarantee at the function-contract level: given a database handle whose
   * `query` method is the ONLY method the function is allowed to call
   * (no `insert`/`update`/`delete`/transaction helpers are even present on
   * the mock), and given a candidate that clearly clears the fuzzy
   * threshold, findPossibleDuplicateOrganization must return a plain
   * read-only match object and must not have attempted any write. If a
   * future change tried to make this function (or a caller relying on its
   * return value in the same call) auto-merge two organizations, this test
   * fails because:
   *   (a) the mock has no write-capable methods to call, so any attempt to
   *       write would throw a TypeError, and
   *   (b) the SQL text of every call made is asserted to be a SELECT.
   */
  it("never auto-merges or writes on a fuzzy match — flag-only contract", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    // Intentionally a minimal object with ONLY `query` — mirrors
    // `Pick<PoolClient, "query">`, the narrowest type this function accepts.
    // There is no write-capable method available to call even if the
    // implementation tried.
    const readOnlyDb = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return {
          rowCount: 1,
          rows: [{ id: "org-close", name: "Acme Technologie", domain: "acme.io", normalized_name: "acme technologie" }],
        };
      }),
    };

    const match = await findPossibleDuplicateOrganization(readOnlyDb as never, "project-1", {
      name: "Acme Technologies",
    });

    // A match was found (the fuzzy tier did its job)...
    expect(match).not.toBeNull();
    expect(match?.id).toBe("org-close");
    // ...but every single query issued was a read (SELECT), never a write.
    expect(calls.length).toBeGreaterThan(0);
    for (const { sql } of calls) {
      expect(sql).toMatch(/^\s*SELECT/i);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    }
    // The function's return type is a plain data object (id/name/domain),
    // not a side-effecting promise/handle — nothing about calling this
    // function changes database state, so the caller (route handler) is the
    // only place a `possible_duplicate_of` write could ever happen, and only
    // as an explicit, separate, human-reviewable step.
    expect(Object.keys(match as object).sort()).toEqual(["domain", "id", "name"]);
  });
});
