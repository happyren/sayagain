import type { Finding } from "@sayagain/lint";
import { describe, expect, it } from "vitest";
import type { ShapeDocument } from "./contribute.js";
import type { RegistryScan } from "./registry-scan.js";
import {
  badgeSvg,
  buildIndex,
  fixesText,
  GRADE_SCORE,
  renderIndexSite,
  slugOf,
} from "./reliability-index.js";

const finding = (rule: string, severity: Finding["severity"]): Finding => ({
  rule,
  severity,
  message: `${rule} message`,
});

const scan: RegistryScan = {
  generatedAt: "2026-09-05T12:00:00Z",
  registry: "https://registry.example/v0/servers",
  ruleSet: "2026-09-05.1",
  selection: { mode: "sample", listed: 100, withRemote: 60, chosen: 3, seed: 7 },
  outcomes: { ok: 2, auth: 1, refused: 0, unreachable: 0, "not-mcp": 0, "no-tools": 0, skipped: 0 },
  tools: 3,
  invalidTools: 0,
  grades: { A: 1, B: 0, C: 0, D: 0, F: 2 },
  findingShares: { "params/constrained": 66.7 },
  m16: {
    pct: 66.7,
    low: 20.8,
    high: 93.9,
    n: 3,
    servers: 2,
    serversWithFinding: 2,
    medianServerSharePct: 75,
  },
  servers: [
    {
      name: "io.github.acme/Notion-Bridge",
      version: "2.1.0",
      url: "https://notion.example/mcp",
      hasPackages: false,
      needsSecret: false,
      outcome: "ok",
      ms: 120,
      invalidTools: 0,
      tools: [
        {
          name: "create_page",
          grade: "F",
          findings: [
            finding("params/described", "error"),
            finding("params/constrained", "warning"),
            finding("annotations/present", "warning"),
          ],
        },
        { name: "get_page", grade: "A", findings: [] },
      ],
    },
    {
      name: "com.example/solo",
      version: "0.1.0",
      hasPackages: true,
      needsSecret: false,
      outcome: "ok",
      ms: 80,
      invalidTools: 0,
      tools: [
        {
          name: "run",
          grade: "F",
          findings: [
            finding("description/present", "error"),
            finding("params/constrained", "warning"),
          ],
        },
      ],
    },
    {
      name: "com.example/walled",
      version: "1.0.0",
      url: "https://walled.example/mcp",
      hasPackages: false,
      needsSecret: true,
      outcome: "auth",
      ms: 0,
      invalidTools: 0,
      tools: [],
    },
  ],
};

const contribution: ShapeDocument = {
  schema: "sayagain.shape/1",
  contributor: "c_0123456789abcdef",
  consent: { termsVersion: "2026-09-05", acceptedAt: "2026-09-05T00:00:00Z" },
  client: { name: "sayagain", version: "t", source: "claude-code-transcripts" },
  window: { since: "2026-08-01T00:00:00Z", until: "2026-09-01T00:00:00Z" },
  sessions: 12,
  shapes: [
    {
      server: "notion-bridge", // the host's key for the server: the registry name's last segment
      tool: "create_page",
      toolClass: "write",
      modelFamily: "claude",
      intentCategory: "create",
      calls: 40,
      failures: 8,
      unacknowledgedWrites: 1,
      duplicateWrites: 0,
      errors: [
        {
          class: "coercible",
          signatureHash: "0123456789abcdef",
          count: 6,
          argShape: ["limit:string"],
          resolution: "type-change",
          shapeChange: "changed limit:string->number",
          callsToRecover: { median: 0, unrecovered: 0 },
          boundary: { repaired: 0, held: 0, deadLettered: 0 },
        },
        {
          class: "semantic",
          signatureHash: "fedcba9876543210",
          count: 2,
          argShape: ["parent:string"],
          resolution: "other-tool-first",
          recoveryPath: ["get_page"],
          callsToRecover: { median: 1, unrecovered: 1 },
          boundary: { repaired: 0, held: 0, deadLettered: 0 },
        },
      ],
    },
    {
      server: "notion-bridge",
      tool: "create_page",
      toolClass: "write",
      modelFamily: "gpt",
      intentCategory: "create",
      calls: 10,
      failures: 5,
      unacknowledgedWrites: 0,
      duplicateWrites: 0,
      errors: [],
    },
    {
      server: "elsewhere",
      tool: "nothing",
      toolClass: "read-only",
      modelFamily: "claude",
      intentCategory: "read",
      calls: 3,
      failures: 0,
      unacknowledgedWrites: 0,
      duplicateWrites: 0,
      errors: [],
    },
  ],
};

describe("reliability index", () => {
  it("scores servers from grades, ranks them, and names two fixes", () => {
    const index = buildIndex(scan, [contribution], {
      version: "t",
      now: new Date("2026-09-05T13:00:00Z"),
    });
    expect(index.ruleSet).toBe("2026-09-05.1");
    expect(index.scan).toMatchObject({ listed: 100, withRemote: 60, probed: 3 });
    expect(index.contributions).toEqual({ documents: 1, sessions: 12, shapes: 3 });
    expect(index.servers.map((s) => [s.name, s.score, s.grade])).toEqual([
      ["io.github.acme/Notion-Bridge", 60, "C"], // (20 + 100) / 2
      ["com.example/solo", 20, "F"],
      ["com.example/walled", undefined, undefined],
    ]);
    const notion = index.servers[0];
    expect(notion?.slug).toBe("io-github-acme-notion-bridge");
    expect(notion?.grades).toEqual({ A: 1, B: 0, C: 0, D: 0, F: 1 });
    expect(notion?.fixes.map((f) => [f.rule, f.tools])).toEqual([
      ["params/described", 1], // an error outweighs two warnings
      ["params/constrained", 1],
    ]);
    expect(notion?.fixes[0]?.summary).toContain("Every input property has a description");
    expect(GRADE_SCORE.A).toBe(100);
  });

  it("attaches runtime scores from contributed shapes by server name, aggregated over families", () => {
    const index = buildIndex(scan, [contribution], { version: "t" });
    const create = index.servers[0]?.tools.find((t) => t.name === "create_page");
    expect(create?.runtime).toEqual({
      calls: 50,
      failures: 13,
      failureRatePct: 26,
      unacknowledgedWrites: 1,
      score: 74,
      dominantErrorClass: "coercible",
      families: { claude: { calls: 40, failures: 8 }, gpt: { calls: 10, failures: 5 } },
      resolution: "type-change",
      suggestion: expect.stringContaining("coercion"),
      contributions: 1,
    });
    expect(index.servers[0]?.tools.find((t) => t.name === "get_page")?.runtime).toBeUndefined();
    expect(buildIndex(scan, [], { version: "t" }).servers[0]?.tools[0]?.runtime).toBeUndefined();
  });

  it("renders a site with a page and badges per server, badges per tool, and a JSON file that names no contributor", () => {
    const index = buildIndex(scan, [contribution], { version: "t" });
    const site = renderIndexSite(index, "/sayagain");
    expect([...site.keys()].sort()).toEqual([
      "badges/com-example-solo.svg",
      "badges/com-example-solo/run.svg",
      "badges/io-github-acme-notion-bridge.svg",
      "badges/io-github-acme-notion-bridge/create_page.svg".replace("create_page", "create-page"),
      "badges/io-github-acme-notion-bridge/get-page.svg",
      "index.html",
      "index.json",
      "servers/com-example-solo.html",
      "servers/io-github-acme-notion-bridge.html",
    ]);
    const home = site.get("index.html") ?? "";
    expect(home).toContain("Tool Reliability Index");
    expect(home).toContain("66.7%");
    expect(home).toContain('href="/sayagain/servers/io-github-acme-notion-bridge.html"');
    expect(home).not.toContain("<script");
    const pageText = site.get("servers/io-github-acme-notion-bridge.html") ?? "";
    expect(pageText).toContain("Two fixes");
    expect(pageText).toContain("Every input property has a description");
    expect(pageText).toContain(
      "50 contributed calls, 26% failed, mostly coercible; what worked: type-change",
    );
    expect(pageText).toContain("claude 40, gpt 10");
    const badge = site.get("badges/io-github-acme-notion-bridge.svg") ?? "";
    expect(badge).toContain("<svg");
    expect(badge).toContain("C 60");
    expect(site.get("badges/com-example-solo/run.svg")).toContain("F 20");
    const json = JSON.parse(site.get("index.json") ?? "{}") as {
      servers: { name: string; tools: { runtime?: unknown }[] }[];
    };
    expect(json.servers[0]?.name).toBe("io.github.acme/Notion-Bridge");
    expect(json.servers[0]?.tools[0]?.runtime).toBeDefined();
    for (const content of site.values()) {
      expect(content).not.toContain("c_0123456789abcdef");
      expect(content).not.toContain("0123456789abcdef"); // no signature hash either
      expect(content).not.toContain("limit:string");
    }
  });

  it("writes the maintainer's message: score, two fixes, runtime, nothing else", () => {
    const index = buildIndex(scan, [contribution], { version: "t" });
    const text = fixesText(
      index,
      index.servers[0] as NonNullable<(typeof index.servers)[0]>,
      "https://index.example",
    );
    expect(text).toContain(
      "io.github.acme/Notion-Bridge 2.1.0 on the Tool Reliability Index (2026-09-05, rule set 2026-09-05.1)",
    );
    expect(text).toContain("score 60 (C) over 2 tools: A 1, F 1");
    expect(text).toContain(
      "1. Every input property has a description. (params/described; 1 of 2 tools)",
    );
    expect(text).toContain("create_page 26% failed on 50 calls (coercible)");
    expect(text).toContain("page: https://index.example/servers/io-github-acme-notion-bridge.html");
    expect(text).not.toContain("c_0123456789abcdef");
    const walled = fixesText(index, index.servers[2] as NonNullable<(typeof index.servers)[0]>);
    expect(walled).toContain("not graded");
  });

  it("makes slugs and badges", () => {
    expect(slugOf("io.github.Acme/My Server!")).toBe("io-github-acme-my-server");
    expect(slugOf("---")).toBe("server");
    const svg = badgeSvg("sayagain", "A 100", "A");
    expect(svg).toContain('aria-label="sayagain: A 100"');
    expect(svg).toContain("#2e8b57");
    expect(badgeSvg("x<y", "F 20", "F")).toContain("x&lt;y");
  });
});
