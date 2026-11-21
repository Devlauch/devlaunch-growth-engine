/**
 * Minimal but real robots.txt parser + matcher.
 *
 * Implements the common subset of the robots.txt convention used in
 * practice (and documented by Google's robots.txt spec):
 *  - `User-agent:` lines open one or more groups; a line is attached to
 *    every `User-agent:` immediately preceding it in the same group.
 *  - `Allow:` / `Disallow:` lines within a group apply to the matched
 *    user-agent(s).
 *  - When choosing which rule applies to a path, the *longest matching
 *    path* wins; on a tie, `Allow` wins over `Disallow`.
 *  - If no group matches our user-agent, we fall back to the `*` group.
 *  - If there is no robots.txt (or it has no matching group), everything
 *    is allowed — callers should treat a failed robots.txt fetch as "allow
 *    by default" but SHOULD still log that robots.txt could not be read.
 *
 * This is intentionally not a full RFC-adjacent implementation (no
 * wildcard `*`/`$` matching inside paths, no Sitemap/Crawl-delay
 * handling) but it is a genuine parser operating on real robots.txt text,
 * not a stub that always returns true.
 */

interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  /** Returns true if `path` (e.g. "/contact") may be fetched. */
  isAllowed(path: string): boolean;
  /** The Disallow path patterns in the group that matched our user-agent. */
  disallowedPaths: string[];
}

function parseGroups(content: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let currentHasRule = false;

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const sepIdx = line.indexOf(":");
    if (sepIdx === -1) continue;
    const field = line.slice(0, sepIdx).trim().toLowerCase();
    const value = line.slice(sepIdx + 1).trim();

    if (field === "user-agent") {
      // A new User-agent line after rules were already seen in the
      // current group starts a *new* group; consecutive User-agent
      // lines (no rules between them) belong to the same group.
      if (!current || currentHasRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        currentHasRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (!current) continue;
      current.rules.push({ type: field, path: value });
      currentHasRule = true;
    }
    // Other fields (Crawl-delay, Sitemap, etc.) are intentionally ignored.
  }

  return groups;
}

function selectGroup(groups: RobotsGroup[], userAgent: string): RobotsGroup | undefined {
  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  if (specific) return specific;
  return groups.find((g) => g.agents.includes("*"));
}

export function parseRobotsTxt(content: string, userAgent = "*"): RobotsRules {
  const groups = parseGroups(content);
  const group = selectGroup(groups, userAgent);
  const rules = group?.rules ?? [];
  const disallowedPaths = rules.filter((r) => r.type === "disallow" && r.path !== "").map((r) => r.path);

  return {
    disallowedPaths,
    isAllowed(path: string): boolean {
      if (rules.length === 0) return true;

      // An empty Disallow value means "allow everything" per convention.
      let bestMatch: RobotsRule | undefined;
      for (const rule of rules) {
        if (rule.path === "") continue; // Disallow: (empty) => allow all, no-op here
        if (path.startsWith(rule.path)) {
          if (!bestMatch || rule.path.length > bestMatch.path.length) {
            bestMatch = rule;
          } else if (rule.path.length === bestMatch.path.length && rule.type === "allow") {
            // Tie-break: Allow wins over Disallow at equal specificity.
            bestMatch = rule;
          }
        }
      }
      if (!bestMatch) return true;
      return bestMatch.type === "allow";
    },
  };
}
