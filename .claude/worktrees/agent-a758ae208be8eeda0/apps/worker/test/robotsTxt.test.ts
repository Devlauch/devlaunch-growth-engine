import { describe, it, expect } from "vitest";
import { parseRobotsTxt } from "../src/agents/robotsTxt.js";

describe("parseRobotsTxt", () => {
  it("allows everything when there is no matching group", () => {
    const robots = parseRobotsTxt("");
    expect(robots.isAllowed("/anything")).toBe(true);
  });

  it("disallows an exact path listed under Disallow for the matching user-agent", () => {
    const robots = parseRobotsTxt(
      ["User-agent: *", "Disallow: /admin", "Disallow: /private/"].join("\n"),
      "DevLaunchResearchBot/1.0",
    );
    expect(robots.isAllowed("/admin")).toBe(false);
    expect(robots.isAllowed("/admin/users")).toBe(false);
    expect(robots.isAllowed("/private/")).toBe(false);
    expect(robots.isAllowed("/contact")).toBe(true);
  });

  it("prefers a more specific user-agent group over the wildcard group", () => {
    const content = [
      "User-agent: *",
      "Disallow: /contact",
      "",
      "User-agent: DevLaunchResearchBot",
      "Disallow:",
    ].join("\n");
    const robots = parseRobotsTxt(content, "DevLaunchResearchBot/1.0");
    // The specific group has an empty Disallow (= allow all), so it should
    // win over the wildcard group's Disallow: /contact.
    expect(robots.isAllowed("/contact")).toBe(true);
  });

  it("resolves overlapping Allow/Disallow by longest-match-wins", () => {
    const content = ["User-agent: *", "Disallow: /news", "Allow: /news/public"].join("\n");
    const robots = parseRobotsTxt(content);
    expect(robots.isAllowed("/news/internal")).toBe(false);
    expect(robots.isAllowed("/news/public")).toBe(true);
    expect(robots.isAllowed("/news/public/article-1")).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    const content = ["# comment", "", "User-agent: *", "# another comment", "Disallow: /secret"].join("\n");
    const robots = parseRobotsTxt(content);
    expect(robots.isAllowed("/secret")).toBe(false);
    expect(robots.isAllowed("/public")).toBe(true);
  });

  it("exposes the disallowed paths for the matched group", () => {
    const robots = parseRobotsTxt(["User-agent: *", "Disallow: /a", "Disallow: /b"].join("\n"));
    expect(robots.disallowedPaths).toEqual(["/a", "/b"]);
  });
});
