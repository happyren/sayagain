import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertShapeDocumentSafe,
  buildShapeDocument,
  checkEndpoint,
  contributeSettings,
  intentCategory,
  type ShapeDocument,
  sendContribution,
  TERMS_VERSION,
  weeklyContribution,
  writeContribution,
} from "./contribute.js";
import type { LedgerRow } from "./ledger.js";
import { loadRegistry, saveRegistry } from "./registry.js";
import { SECRETS, T0, writeClaudeCodeFixture } from "./test-fixtures/transcripts.js";
import { readSession, sessionRows } from "./transcripts.js";

let root: string;
let prevHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sayagain-contribute-"));
  prevHome = process.env.SAYAGAIN_HOME;
  process.env.SAYAGAIN_HOME = join(root, "home");
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SAYAGAIN_HOME;
  else process.env.SAYAGAIN_HOME = prevHome;
  rmSync(root, { recursive: true, force: true });
});

const consent = { termsVersion: TERMS_VERSION, acceptedAt: "2026-09-05T00:00:00Z" };
const contributor = "c_0123456789abcdef";

function fixtureDocument(): ShapeDocument {
  return fixture().doc;
}

function fixture(): { doc: ShapeDocument; id: string } {
  const s = readSession(writeClaudeCodeFixture(join(root, "claude")), "claude-code");
  const { rows, extras } = sessionRows(s);
  const doc = buildShapeDocument(rows, {
    source: "claude-code-transcripts",
    contributor,
    consent,
    since: new Date(T0 - 1000),
    until: new Date(T0 + 60_000),
    version: "t",
    sessions: 1,
    familyOf: (r) => extras.get(r.receipt)?.family ?? "unknown",
    schemaHashOf: (r) => extras.get(r.receipt)?.schemaHash,
  });
  return { doc, id: s.id };
}

interface IndexCall {
  method: string | undefined;
  auth: string | undefined;
  body: string;
}

async function indexServer(
  handler: (req: IndexCall) => { status: number; body: unknown },
): Promise<{ url: string; close: () => Promise<void>; calls: IndexCall[] }> {
  const calls: IndexCall[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const call = { method: req.method, auth: req.headers.authorization, body };
      calls.push(call);
      const out = handler(call);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1/contributions`,
    calls,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe("contribute", () => {
  it("derives the intent category from the name and class, never from text", () => {
    expect(intentCategory("get_page", "read-only")).toBe("read");
    expect(intentCategory("search_issues", "read-only")).toBe("search");
    expect(intentCategory("create_page", "write")).toBe("create");
    expect(intentCategory("update_page", "write")).toBe("update");
    expect(intentCategory("delete_page", "destructive")).toBe("delete");
    expect(intentCategory("run_query", "write")).toBe("execute");
    expect(intentCategory("Bash", "write")).toBe("execute");
    expect(intentCategory("Edit", "write")).toBe("update");
    expect(intentCategory("summarize", "write")).toBe("unknown");
    expect(intentCategory("Read", "read-only")).toBe("read");
  });

  it("builds the ADR-0009 document from rows: counts, classes, shapes and hashes, nothing else", () => {
    const { doc, id } = fixture();
    const s = { id };
    expect(doc).toMatchObject({
      schema: "sayagain.shape/1",
      contributor,
      consent,
      client: { name: "sayagain", version: "t", source: "claude-code-transcripts" },
      sessions: 1,
    });
    const notion = doc.shapes.find((s) => s.server === "notion" && s.tool === "create_page");
    expect(notion).toMatchObject({
      toolClass: "write",
      modelFamily: "claude",
      intentCategory: "create",
      calls: 3,
      failures: 1,
      unacknowledgedWrites: 0,
      duplicateWrites: 1,
    });
    expect(notion?.errors).toHaveLength(1);
    expect(notion?.errors[0]).toMatchObject({
      class: "coercible",
      count: 1,
      argShape: ["limit:string", "parent:string"],
      resolution: "type-change",
      shapeChange: "changed limit:string->number",
      callsToRecover: { median: 0, unrecovered: 0 },
      boundary: { repaired: 0, held: 0, deadLettered: 0 },
    });
    expect(notion?.errors[0]?.signatureHash).toMatch(/^[0-9a-f]{16}$/);
    expect(notion?.errors[0]?.recoveryPath).toBeUndefined();
    const edit = doc.shapes.find((s) => s.server === "claude-code" && s.tool === "Edit");
    expect(edit).toMatchObject({ calls: 1, failures: 0, unacknowledgedWrites: 1, errors: [] });
    // The UUID-named connector stays home.
    expect(doc.shapes.some((s) => s.server === "bf7c680d-5fdc-5ef4-b4a0-abadb619bf0a")).toBe(false);
    expect(doc.shapes.some((s) => s.server === "private-connector")).toBe(false);
    const bash = doc.shapes.find((s) => s.tool === "Bash");
    expect(bash).toMatchObject({ unacknowledgedWrites: 1, intentCategory: "execute" });
    const json = JSON.stringify(doc);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(json).not.toContain("Invalid params");
    expect(json).not.toContain(s.id); // the session key stays home
    expect(json).not.toMatch(/[0-9a-f]{12}:\d/); // no receipts
    expect(() => assertShapeDocumentSafe(doc)).not.toThrow();
  });

  it("refuses a document with anything beyond the schema", () => {
    const doc = fixtureDocument();
    type Loose = {
      shapes: { tool: string; errors: Record<string, unknown>[]; [k: string]: unknown }[];
    };
    const mutate = (edit: (d: Loose) => void): unknown => {
      const copy = JSON.parse(JSON.stringify(doc)) as Loose;
      edit(copy);
      return copy;
    };
    const first = (d: Loose) => d.shapes.find((s) => s.errors.length) as Loose["shapes"][number];
    expect(() =>
      assertShapeDocumentSafe(
        mutate((d) => {
          d.shapes[0] = { ...(d.shapes[0] as Loose["shapes"][number]), arguments: { limit: 10 } };
        }),
      ),
    ).toThrow(/unexpected field shapes\[0\]\.arguments/);
    expect(() =>
      assertShapeDocumentSafe(
        mutate((d) => {
          (d.shapes[0] as Loose["shapes"][number]).tool = "/Users/k/tool";
        }),
      ),
    ).toThrow(/must not contain spaces or paths/);
    expect(() =>
      assertShapeDocumentSafe(
        mutate((d) => {
          (first(d).errors[0] as Record<string, unknown>).signatureHash =
            "Invalid params: limit must be a number";
        }),
      ),
    ).toThrow(/signatureHash must be 16 hex/);
    expect(() =>
      assertShapeDocumentSafe(
        mutate((d) => {
          (first(d).errors[0] as Record<string, unknown>).argShape = ["limit:10"];
        }),
      ),
    ).toThrow(/argShape must be key:type/);
    expect(() => assertShapeDocumentSafe({ ...doc, contributor: "kaixiang" })).toThrow(/c_ id/);
    expect(() =>
      assertShapeDocumentSafe(
        mutate((d) => {
          (d.shapes[0] as Loose["shapes"][number]).server = "bf7c680d-5fdc-5ef4-b4a0-abadb619bf0a";
        }),
      ),
    ).toThrow(/opaque id/);
  });

  it("keeps namespaced server names and odd keys, and drops names that read as paths", () => {
    const row = (over: Partial<LedgerRow>): LedgerRow => ({
      receipt: `r${Math.random().toString(36).slice(2)}`,
      ts: new Date(T0).toISOString(),
      upstream: "example-servers/everything",
      method: "tools/call",
      tool: "echo",
      toolClass: "read-only",
      argShape: ["xml:lang:string", "some key:number", "a/b:object"],
      argsHash: "h",
      hasIntent: false,
      session: "s1",
      status: "executed",
      isError: false,
      latencyMs: 1,
      requestBytes: 1,
      responseBytes: 1,
      ...over,
    });
    const rows = [
      row({ isError: true, errorClass: "coercible", errorSignature: "Invalid params: x" }),
      row({ argShape: ["xml:lang:number"], argsHash: "h2" }),
      row({ upstream: "/Users/k/SECRET/server", tool: "x" }),
      row({ upstream: "My Server", tool: "run thing" }),
    ];
    const doc = buildShapeDocument(rows, {
      source: "ledger",
      contributor,
      consent,
      since: new Date(T0 - 1000),
      until: new Date(T0 + 1000),
      version: "t",
    });
    expect(doc.shapes.map((s) => [s.server, s.tool])).toEqual([
      ["example-servers/everything", "echo"],
      ["my-server", "run-thing"],
    ]);
    expect(doc.shapes[0]?.errors[0]?.argShape).toEqual([
      "a-b:object",
      "some-key:number",
      "xml:lang:string",
    ]);
    expect(doc.sessions).toBe(1);
    expect(JSON.stringify(doc)).not.toContain("SECRET");
  });

  it("attributes an error to the failing call's model family even when the fix ran under another", () => {
    const base = (over: Partial<LedgerRow>): LedgerRow => ({
      receipt: `r${Math.random().toString(36).slice(2)}`,
      ts: new Date(T0).toISOString(),
      upstream: "notion",
      method: "tools/call",
      tool: "create_page",
      toolClass: "write",
      argShape: ["limit:string"],
      argsHash: "h",
      hasIntent: false,
      session: "s1",
      status: "executed",
      isError: false,
      latencyMs: 1,
      requestBytes: 1,
      responseBytes: 1,
      ...over,
    });
    const failed = base({
      isError: true,
      errorClass: "coercible",
      errorSignature: "Invalid params: limit",
    });
    const fixed = base({
      ts: new Date(T0 + 1000).toISOString(),
      argShape: ["limit:number"],
      argsHash: "h2",
    });
    const family = new Map([
      [failed.receipt, "claude"],
      [fixed.receipt, "gpt"],
    ]);
    const doc = buildShapeDocument([failed, fixed], {
      source: "ledger",
      contributor,
      consent,
      since: new Date(T0 - 1000),
      until: new Date(T0 + 2000),
      version: "t",
      familyOf: (r) => family.get(r.receipt) ?? "unknown",
    });
    const claude = doc.shapes.find((s) => s.modelFamily === "claude");
    expect(claude?.errors[0]).toMatchObject({
      resolution: "type-change",
      shapeChange: "changed limit:string->number",
      callsToRecover: { median: 0, unrecovered: 0 },
    });
    expect(doc.shapes.find((s) => s.modelFamily === "gpt")?.errors).toEqual([]);
  });

  it("writes the document under the home directory with owner-only permissions", () => {
    const doc = fixtureDocument();
    const path = writeContribution(doc, new Date(T0));
    expect(path).toBe(join(root, "home", "contributions", "2026-09-01T10-00-00-000Z.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(doc);
  });

  it("keeps a random contributor id in config.json", () => {
    const registry = loadRegistry();
    const first = contributeSettings(registry).contributor;
    expect(first).toMatch(/^c_[0-9a-f]{16}$/);
    expect(loadRegistry().contribute?.contributor).toBe(first);
    expect(contributeSettings(loadRegistry()).contributor).toBe(first);
    expect(statSync(join(root, "home", "config.json")).mode & 0o777).toBe(0o600);
  });

  it("sends only over https, or http to loopback, with the contributor as bearer", async () => {
    expect(() => checkEndpoint("http://index.example/v1")).toThrow(/must be https/);
    expect(() => checkEndpoint("ftp://x")).toThrow(/must be https/);
    expect(() => checkEndpoint("not a url")).toThrow(/is not a URL/);
    expect(checkEndpoint("https://index.example/v1").hostname).toBe("index.example");
    const index = await indexServer(() => ({
      status: 201,
      body: { receipt: "rcpt_1", url: "https://index.example/c/x" },
    }));
    try {
      const doc = fixtureDocument();
      const receipt = await sendContribution(doc, index.url, "t");
      expect(receipt).toEqual({ status: 201, receipt: "rcpt_1", url: "https://index.example/c/x" });
      expect(index.calls).toHaveLength(1);
      expect(index.calls[0]).toMatchObject({ method: "POST", auth: `Bearer ${contributor}` });
      expect(JSON.parse(index.calls[0]?.body ?? "")).toEqual(doc);
    } finally {
      await index.close();
    }
    const down = await indexServer(() => ({ status: 503, body: {} }));
    try {
      await expect(sendContribution(fixtureDocument(), down.url, "t")).rejects.toThrow(
        /answered 503/,
      );
    } finally {
      await down.close();
    }
  });

  it("contributes weekly only with the setting, an endpoint, the terms, and a week gone by", async () => {
    const s = readSession(writeClaudeCodeFixture(join(root, "claude")), "claude-code");
    const rows = sessionRows(s).rows;
    const now = new Date(T0 + 3_600_000);
    const registry = loadRegistry();
    contributeSettings(registry);
    expect(await weeklyContribution({ rows, version: "t", now })).toMatchObject({
      sent: false,
      reason: "weekly contribution is off",
    });
    const settings = contributeSettings(registry);
    settings.weekly = true;
    saveRegistry(registry);
    expect(await weeklyContribution({ rows, version: "t", now })).toMatchObject({
      reason: "no endpoint",
    });
    const index = await indexServer(() => ({ status: 200, body: { receipt: "w1" } }));
    try {
      settings.endpoint = index.url;
      saveRegistry(registry);
      expect(await weeklyContribution({ rows, version: "t", now })).toMatchObject({
        reason: "terms not accepted",
      });
      settings.consent = consent;
      saveRegistry(registry);
      process.env.SAYAGAIN_CONTRIBUTE = "0";
      expect(await weeklyContribution({ rows, version: "t", now })).toMatchObject({
        reason: "SAYAGAIN_CONTRIBUTE=0",
      });
      delete process.env.SAYAGAIN_CONTRIBUTE;
      const sent = await weeklyContribution({ rows, version: "t", now });
      expect(sent).toMatchObject({ sent: true, receipt: { status: 200, receipt: "w1" } });
      expect(index.calls).toHaveLength(1);
      const body = JSON.parse(index.calls[0]?.body ?? "") as ShapeDocument;
      expect(body.client.source).toBe("ledger");
      expect(body.shapes.length).toBeGreaterThan(0);
      expect(readdirSync(join(root, "home", "contributions"))).toHaveLength(1);
      expect(loadRegistry().contribute?.lastSentAt).toBe(now.toISOString());
      expect(
        await weeklyContribution({ rows, version: "t", now: new Date(now.getTime() + 86_400_000) }),
      ).toMatchObject({ sent: false, reason: "sent within the week" });
      expect(index.calls).toHaveLength(1);
    } finally {
      await index.close();
    }
  });
});
