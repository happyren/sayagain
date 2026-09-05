import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isPrivateAddress,
  listRegistry,
  probeTools,
  renderRegistryScan,
  scanRegistry,
  summarizeScan,
  wilson,
} from "./registry-scan.js";

/** One loopback server that plays the registry and a dozen MCP servers, by path. */
interface Fake {
  url: (path: string) => string;
  close: () => Promise<void>;
  hits: { path: string; auth: string | undefined; session: string | undefined; method?: string }[];
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

const entry = (
  name: string,
  version: string,
  extra: Record<string, unknown>,
  status = "active",
) => ({
  server: { name, version, ...extra },
  _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest: true } },
});
const remote = (path: string, headers?: unknown[]) => ({
  remotes: [{ type: "streamable-http", url: `SELF${path}`, ...(headers ? { headers } : {}) }],
});

async function fake(): Promise<Fake> {
  const hits: Fake["hits"] = [];
  const registryPage = (page: number) => {
    const servers =
      page === 1
        ? [
            entry("io.example/good", "1.0.0", remote("/mcp/good")),
            entry("io.example/good", "1.1.0", remote("/mcp/good")),
            entry("io.example/auth", "1.0.0", remote("/mcp/auth")),
            entry("io.example/sse-only", "1.0.0", { remotes: [{ type: "sse", url: "SELF/sse" }] }),
            entry("io.example/gone", "1.0.0", remote("/mcp/good"), "deprecated"),
          ]
        : [
            entry("io.example/slow", "1.0.0", remote("/mcp/slow")),
            entry("io.example/html", "1.0.0", remote("/mcp/html")),
            entry("io.example/pkg", "1.0.0", {
              packages: [{ registryType: "npm", identifier: "x" }],
            }),
            entry(
              "io.example/secret",
              "1.0.0",
              remote("/mcp/good", [{ name: "Authorization", isRequired: true, isSecret: true }]),
            ),
            entry("io.example/sse", "1.0.0", remote("/mcp/sse")),
            entry("io.example/hang", "1.0.0", remote("/mcp/hang")),
            entry("io.example/jsonerr", "1.0.0", remote("/mcp/jsonerr")),
            entry("io.example/refuse", "1.0.0", remote("/mcp/refuse")),
            entry("io.example/nulltool", "1.0.0", remote("/mcp/nulltool")),
            entry("io.example/private", "1.0.0", {
              remotes: [{ type: "streamable-http", url: "http://10.0.0.1/mcp" }],
            }),
          ];
    return { servers, metadata: page === 1 ? { nextCursor: "page2", count: 5 } : { count: 10 } };
  };
  const initResult = (id: unknown, name: string) => ({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name, version: "1" },
    },
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const msg = JSON.parse(body || "{}") as { id?: number; method?: string };
      hits.push({
        path: url.pathname,
        auth: req.headers.authorization,
        session: req.headers["mcp-session-id"] as string | undefined,
        ...(msg.method ? { method: msg.method } : {}),
      });
      const json = (status: number, o: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(o));
      };
      const sse = (o: unknown) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(o)}\n\n`);
      };
      const accepted = () => {
        res.writeHead(202);
        res.end();
      };
      if (url.pathname === "/v0/servers") {
        const page = url.searchParams.get("cursor") === "page2" ? 2 : 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(registryPage(page)).replace(/SELF/g, `http://127.0.0.1:${port}`));
        return;
      }
      if (url.pathname === "/mcp/auth") return json(401, { error: "unauthorized" });
      if (url.pathname === "/mcp/html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not mcp</html>");
        return;
      }
      if (url.pathname === "/mcp/slow") return; // never answers
      if (url.pathname === "/mcp/jsonerr")
        return json(200, { error: "unauthorized: api key required" });
      if (url.pathname === "/mcp/refuse")
        return json(200, {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "unsupported protocol version" },
        });
      if (msg.method === "notifications/initialized") return accepted();
      if (url.pathname === "/mcp/good") {
        if (msg.method === "initialize")
          return json(200, initResult(msg.id, "good"), { "mcp-session-id": "s1" });
        if (msg.method === "tools/list")
          return json(200, {
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [GOOD_TOOL, BAD_TOOL] },
          });
      }
      if (url.pathname === "/mcp/sse") {
        if (msg.method === "initialize") return sse(initResult(msg.id, "sse"));
        if (msg.method === "tools/list")
          return sse({ jsonrpc: "2.0", id: msg.id, result: { tools: [GOOD_TOOL] } });
      }
      if (url.pathname === "/mcp/hang") {
        if (msg.method === "initialize") return json(200, initResult(msg.id, "hang"));
        if (msg.method === "tools/list") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(": ping\n\n"); // and never answers
          return;
        }
      }
      if (url.pathname === "/mcp/nulltool") {
        if (msg.method === "initialize") return json(200, initResult(msg.id, "nulltool"));
        if (msg.method === "tools/list")
          return json(200, {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                GOOD_TOOL,
                { name: "broken", inputSchema: null },
                { name: "odd", inputSchema: { type: "object", properties: { a: null } } },
              ],
            },
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
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let f: Fake;
beforeAll(async () => {
  f = await fake();
});
afterAll(async () => {
  await f.close();
});

const local = { timeoutMs: 400, allowPrivate: true };
const LONG = 20_000;

describe("registry scan", () => {
  it("lists active servers across pages, one entry per name, with the streamable-http remote", async () => {
    const servers = await listRegistry({ url: f.url("/v0/servers") });
    expect(servers.map((s) => [s.name, s.url !== undefined, s.hasPackages, s.needsSecret])).toEqual(
      [
        ["io.example/good", true, false, false],
        ["io.example/auth", true, false, false],
        ["io.example/sse-only", false, false, false],
        ["io.example/slow", true, false, false],
        ["io.example/html", true, false, false],
        ["io.example/pkg", false, true, false],
        ["io.example/secret", true, false, true],
        ["io.example/sse", true, false, false],
        ["io.example/hang", true, false, false],
        ["io.example/jsonerr", true, false, false],
        ["io.example/refuse", true, false, false],
        ["io.example/nulltool", true, false, false],
        ["io.example/private", true, false, false],
      ],
    );
    expect(servers.some((s) => s.name === "io.example/gone")).toBe(false); // deprecated
    expect(f.hits.filter((h) => h.path === "/v0/servers")).toHaveLength(2);
    expect(
      (await listRegistry({ url: f.url("/v0/servers"), max: 2 })).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("knows a private address when it sees one", () => {
    for (const u of [
      "http://localhost/mcp",
      "http://127.0.0.1:8080/mcp",
      "http://10.1.2.3/",
      "http://192.168.1.1/",
      "http://172.20.0.1/",
      "http://169.254.1.1/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://intranet/mcp",
      "http://box.local/mcp",
      "not a url",
    ])
      expect(isPrivateAddress(u), u).toBe(true);
    for (const u of [
      "https://api.example.com/mcp",
      "http://8.8.8.8/mcp",
      "https://[2606:4700::1]/mcp",
    ])
      expect(isPrivateAddress(u), u).toBe(false);
  });

  it("probes a server without credentials and says why it gave nothing", {
    timeout: LONG,
  }, async () => {
    const good = await probeTools(f.url("/mcp/good"), local);
    expect(good.outcome).toBe("ok");
    expect(good.tools.map((t) => t.name)).toEqual(["create_issue", "search"]);
    const goodHits = f.hits.filter((h) => h.path === "/mcp/good");
    expect(goodHits.map((h) => h.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(goodHits.every((h) => h.auth === undefined)).toBe(true); // never a credential
    expect(goodHits[2]?.session).toBe("s1"); // the session id is echoed
    expect(await probeTools(f.url("/mcp/auth"), local)).toMatchObject({
      outcome: "auth",
      status: 401,
      tools: [],
    });
    const html = await probeTools(f.url("/mcp/html"), local);
    expect(html).toMatchObject({ outcome: "not-mcp", detail: "answered text/html", tools: [] });
    expect(html.ms).toBeLessThan(300); // a web page is recognised at once, not after the timeout
    const slow = await probeTools(f.url("/mcp/slow"), local);
    expect(slow).toMatchObject({ outcome: "unreachable", tools: [] });
    expect(slow.ms).toBeGreaterThanOrEqual(300);
    expect(await probeTools("http://127.0.0.1:1/mcp", local)).toMatchObject({
      outcome: "unreachable",
    });
    expect(await probeTools(f.url("/mcp/sse"), local)).toMatchObject({ outcome: "ok" }); // answers as SSE
    const hang = await probeTools(f.url("/mcp/hang"), local);
    expect(hang).toMatchObject({ outcome: "unreachable", detail: "no answer in time" });
    expect(await probeTools(f.url("/mcp/jsonerr"), local)).toMatchObject({
      outcome: "auth",
      detail: expect.stringContaining("credentials"),
    });
    expect(await probeTools(f.url("/mcp/refuse"), local)).toMatchObject({
      outcome: "refused",
      detail: "unsupported protocol version",
    });
    const nulls = await probeTools(f.url("/mcp/nulltool"), local);
    expect(nulls.outcome).toBe("ok");
    expect(nulls.tools.map((t) => t.name)).toEqual(["create_issue", "odd"]); // a null schema is not a definition
    expect(await probeTools("http://10.0.0.1/mcp", { timeoutMs: 500 })).toMatchObject({
      outcome: "skipped",
      ms: 0,
    });
    expect(f.hits.some((h) => h.path === "/mcp/private")).toBe(false);
  });

  it("grades what it reaches and reports M16 with the rule-set version, naming no server on the page", {
    timeout: LONG,
  }, async () => {
    const scan = await scanRegistry({
      registryUrl: f.url("/v0/servers"),
      concurrency: 3,
      ...local,
    });
    expect(scan.ruleSet).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    expect(scan.selection).toEqual({ mode: "all", listed: 13, withRemote: 11, chosen: 11 });
    expect(scan.outcomes).toEqual({
      ok: 3,
      auth: 3,
      refused: 1,
      unreachable: 3,
      "not-mcp": 1,
      "no-tools": 0,
      skipped: 0,
    });
    expect(scan.servers.find((s) => s.name === "io.example/secret")).toMatchObject({
      outcome: "auth",
      detail: "declares a required secret header",
      ms: 0,
    });
    expect(scan.tools).toBe(5); // a null property schema is skipped, the tool still graded
    expect(scan.invalidTools).toBe(0);
    expect(scan.grades).toEqual({ A: 3, B: 0, C: 0, D: 1, F: 1 });
    expect(scan.findingShares["params/constrained"]).toBe(20);
    expect(scan.m16).toEqual({
      ...wilson(1, 5),
      n: 5,
      servers: 3,
      serversWithFinding: 1,
      medianServerSharePct: 0,
    });
    expect(
      scan.servers.find((s) => s.name === "io.example/good")?.tools.map((t) => t.grade),
    ).toEqual(["A", "F"]);
    const page = renderRegistryScan(scan);
    expect(page).toContain("rule set");
    expect(page).toContain("M16, tools without documented parameter constraints: 20%");
    expect(page).toContain("per server: 1 of 3 servers");
    expect(page).not.toContain("io.example");
    expect(summarizeScan(scan.servers, scan.selection).m16).toEqual(scan.m16); // a saved file renders again
    const sample = await scanRegistry({
      registryUrl: f.url("/v0/servers"),
      sample: 2,
      seed: 7,
      ...local,
    });
    expect(sample.selection).toEqual({
      mode: "sample",
      listed: 13,
      withRemote: 11,
      chosen: 2,
      seed: 7,
    });
    const again = await scanRegistry({
      registryUrl: f.url("/v0/servers"),
      sample: 2,
      seed: 7,
      ...local,
    });
    expect(again.servers.map((s) => s.name)).toEqual(sample.servers.map((s) => s.name)); // seeded
    const first = await scanRegistry({ registryUrl: f.url("/v0/servers"), first: 1, ...local });
    expect(first.servers.map((s) => s.name)).toEqual(["io.example/good"]);
    expect(first.selection.listed).toBe(13); // the whole registry is listed even for --first
  });

  it("computes a Wilson interval", () => {
    expect(wilson(0, 0)).toEqual({ pct: 0, low: 0, high: 0 });
    expect(wilson(50, 100)).toEqual({ pct: 50, low: 40.4, high: 59.6 });
    expect(wilson(100, 100).high).toBe(100);
  });
});
