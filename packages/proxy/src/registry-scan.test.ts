import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listRegistry,
  probeTools,
  renderRegistryScan,
  scanRegistry,
  wilson,
} from "./registry-scan.js";

/** One loopback server that plays the registry and four MCP servers, by path. */
interface Fake {
  url: (path: string) => string;
  close: () => Promise<void>;
  hits: string[];
}

const GOOD_TOOL = {
  name: "create_issue",
  description:
    "Create a GitHub issue in a repository you can write to. Use get_repo first to confirm the repo exists. Returns the new issue number and URL.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name", pattern: "^[^/]+/[^/]+$" },
      title: { type: "string", description: "Issue title, one line" },
    },
    required: ["repo", "title"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
const BAD_TOOL = {
  name: "search",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string" }, limit: { type: "number" } },
  },
};

async function fake(): Promise<Fake> {
  const hits: string[] = [];
  const registryPage = (page: number) => {
    const servers =
      page === 1
        ? [
            {
              server: {
                name: "io.example/good",
                version: "1.0.0",
                remotes: [{ type: "streamable-http", url: "SELF/mcp/good" }],
              },
            },
            {
              server: {
                name: "io.example/good",
                version: "1.1.0",
                remotes: [{ type: "streamable-http", url: "SELF/mcp/good" }],
              },
            },
            {
              server: {
                name: "io.example/auth",
                version: "1.0.0",
                remotes: [{ type: "streamable-http", url: "SELF/mcp/auth" }],
              },
            },
            {
              server: {
                name: "io.example/sse-only",
                version: "1.0.0",
                remotes: [{ type: "sse", url: "SELF/sse" }],
              },
            },
          ]
        : [
            {
              server: {
                name: "io.example/slow",
                version: "1.0.0",
                remotes: [{ type: "streamable-http", url: "SELF/mcp/slow" }],
              },
            },
            {
              server: {
                name: "io.example/html",
                version: "1.0.0",
                remotes: [{ type: "streamable-http", url: "SELF/mcp/html" }],
              },
            },
            {
              server: {
                name: "io.example/pkg",
                version: "1.0.0",
                packages: [{ registryType: "npm", identifier: "x" }],
              },
            },
          ];
    return { servers, metadata: page === 1 ? { nextCursor: "page2", count: 4 } : { count: 3 } };
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push(`${req.method} ${url.pathname}`);
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const json = (status: number, o: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(o));
      };
      if (url.pathname === "/v0/servers") {
        const page = url.searchParams.get("cursor") === "page2" ? 2 : 1;
        const raw = JSON.stringify(registryPage(page)).replace(/SELF/g, `http://127.0.0.1:${port}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(raw);
        return;
      }
      if (url.pathname === "/mcp/auth") return json(401, { error: "unauthorized" });
      if (url.pathname === "/mcp/html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not mcp</html>");
        return;
      }
      if (url.pathname === "/mcp/slow") return; // never answers
      if (url.pathname === "/mcp/good") {
        const msg = JSON.parse(body || "{}") as { id?: number; method?: string };
        if (msg.method === "initialize")
          return json(
            200,
            {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "good", version: "1" },
              },
            },
            { "mcp-session-id": "s1" },
          );
        if (msg.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (msg.method === "tools/list")
          return json(200, {
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [GOOD_TOOL, BAD_TOOL] },
          });
      }
      json(404, { error: "no such path" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let f: Fake;
beforeAll(async () => {
  f = await fake();
});
afterAll(async () => {
  await f.close();
});

describe("registry scan", () => {
  it("lists the registry across pages, one entry per name, with the streamable-http remote", async () => {
    const servers = await listRegistry({ url: f.url("/v0/servers") });
    expect(servers.map((s) => [s.name, s.version, s.url !== undefined, s.hasPackages])).toEqual([
      ["io.example/good", "1.1.0", true, false],
      ["io.example/auth", "1.0.0", true, false],
      ["io.example/sse-only", "1.0.0", false, false],
      ["io.example/slow", "1.0.0", true, false],
      ["io.example/html", "1.0.0", true, false],
      ["io.example/pkg", "1.0.0", false, true],
    ]);
    expect(
      (await listRegistry({ url: f.url("/v0/servers"), max: 2 })).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("probes a server without credentials and says why it gave nothing", async () => {
    const good = await probeTools(f.url("/mcp/good"), { timeoutMs: 2000 });
    expect(good.outcome).toBe("ok");
    expect(good.tools.map((t) => t.name)).toEqual(["create_issue", "search"]);
    expect(await probeTools(f.url("/mcp/auth"), { timeoutMs: 2000 })).toMatchObject({
      outcome: "auth",
      status: 401,
      tools: [],
    });
    expect(await probeTools(f.url("/mcp/html"), { timeoutMs: 2000 })).toMatchObject({
      outcome: "not-mcp",
      tools: [],
    });
    const slow = await probeTools(f.url("/mcp/slow"), { timeoutMs: 300 });
    expect(slow).toMatchObject({ outcome: "unreachable", tools: [] });
    expect(slow.ms).toBeGreaterThanOrEqual(250);
    expect(await probeTools("http://127.0.0.1:1/mcp", { timeoutMs: 2000 })).toMatchObject({
      outcome: "unreachable",
    });
  });

  it("grades what it reaches and reports M16 with the rule-set version, naming no server on the page", async () => {
    const scan = await scanRegistry({
      registryUrl: f.url("/v0/servers"),
      timeoutMs: 500,
      concurrency: 2,
    });
    expect(scan.ruleSet).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(scan.selection).toEqual({ mode: "all", listed: 6, withRemote: 4, chosen: 4 });
    expect(scan.outcomes).toEqual({ ok: 1, auth: 1, unreachable: 1, "not-mcp": 1, "no-tools": 0 });
    expect(scan.tools).toBe(2);
    expect(scan.grades).toEqual({ A: 1, B: 0, C: 0, D: 0, F: 1 });
    expect(scan.findingShares["params/constrained"]).toBe(50);
    expect(scan.m16).toEqual({
      ...wilson(1, 2),
      n: 2,
      servers: 1,
      serversWithFinding: 1,
      medianServerSharePct: 50,
    });
    expect(
      scan.servers.find((s) => s.name === "io.example/good")?.tools.map((t) => t.grade),
    ).toEqual(["A", "F"]);
    const page = renderRegistryScan(scan);
    expect(page).toContain("rule set");
    expect(page).toContain("M16, tools without documented parameter constraints: 50%");
    expect(page).not.toContain("io.example");
    const sample = await scanRegistry({
      registryUrl: f.url("/v0/servers"),
      timeoutMs: 500,
      sample: 2,
      seed: 7,
    });
    expect(sample.selection).toEqual({
      mode: "sample",
      listed: 6,
      withRemote: 4,
      chosen: 2,
      seed: 7,
    });
    const again = await scanRegistry({
      registryUrl: f.url("/v0/servers"),
      timeoutMs: 500,
      sample: 2,
      seed: 7,
    });
    expect(again.servers.map((s) => s.name)).toEqual(sample.servers.map((s) => s.name)); // seeded
    const first = await scanRegistry({
      registryUrl: f.url("/v0/servers"),
      timeoutMs: 500,
      first: 1,
    });
    expect(first.servers.map((s) => s.name)).toEqual(["io.example/good"]);
  });

  it("computes a Wilson interval", () => {
    expect(wilson(0, 0)).toEqual({ pct: 0, low: 0, high: 0 });
    expect(wilson(50, 100)).toEqual({ pct: 50, low: 40.4, high: 59.6 });
    expect(wilson(100, 100).high).toBe(100);
  });
});
