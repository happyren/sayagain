import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Audit } from "./audit.js";
import { main } from "./cli.js";
import type { ShapeDocument } from "./contribute.js";
import type { LedgerRow } from "./ledger.js";
import {
  SECRETS,
  T0,
  writeClaudeCodeFixture,
  writeCodexFixture,
} from "./test-fixtures/transcripts.js";

/** `sayagain audit` and `sayagain contribute` over fixture transcripts under a scratch home, no daemon. */
interface IndexCall {
  method: string | undefined;
  body: string;
}

describe("cli audit and contribute", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};
  let out = "";
  beforeEach(() => {
    dir = join(
      tmpdir(),
      `sayagain-cli-audit-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(dir, "home"), { recursive: true });
    for (const k of ["HOME", "SAYAGAIN_HOME", "SAYAGAIN_CONTRIBUTE"]) saved[k] = process.env[k];
    process.env.HOME = dir;
    process.env.SAYAGAIN_HOME = join(dir, "home");
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function index(
    status = 201,
  ): Promise<{ url: string; calls: IndexCall[]; close: () => Promise<void> }> {
    const calls: IndexCall[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        calls.push({ method: req.method, body });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ receipt: "rcpt_9", url: "https://index.example/c/9" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/v1`,
      calls,
      close: () => new Promise((r) => server.close(() => r())),
    };
  }

  it("audit prints the page, writes the HTML file, and takes --json", async () => {
    const claude = join(dir, "claude");
    writeClaudeCodeFixture(claude);
    const html = join(dir, "audit.html");
    expect(
      await main([
        "audit",
        "--source",
        "claude-code",
        "--dir",
        claude,
        "--since",
        "2026-08-01",
        "--html",
        html,
        "--min-calls",
        "1",
      ]),
    ).toBe(0);
    expect(out).toContain("Say Again audit: 2026-08-01 to ");
    expect(out).toContain("North star (risk, then cost)");
    expect(out.indexOf("unacknowledged")).toBeLessThan(out.indexOf("failure tax"));
    expect(out).toContain("notion/create_page");
    expect(out).toContain(`HTML page: ${html}`);
    const page = readFileSync(html, "utf8");
    expect(page).toContain("Say Again audit");
    for (const secret of SECRETS) {
      expect(out).not.toContain(secret);
      expect(page).not.toContain(secret);
    }
    out = "";
    const codex = join(dir, "codex");
    writeCodexFixture(codex);
    expect(
      await main([
        "audit",
        "--json",
        "--no-html",
        "--source",
        "codex",
        "--dir",
        codex,
        "--since",
        "2026-08-01",
      ]),
    ).toBe(0);
    const a = JSON.parse(out) as Audit;
    expect(a.sources).toEqual([
      expect.objectContaining({ source: "codex", sessions: 1, calls: 4, mcpCalls: 1 }),
    ]);
    expect(a.report.calls).toBe(4);
    expect(readdirSync(join(dir, "home")).includes("audit")).toBe(false); // --no-html wrote nothing
    out = "";
    expect(
      await main([
        "audit",
        "--source",
        "cursor",
        "--dir",
        join(dir, "nowhere"),
        "--since",
        "2026-08-01",
        "--no-html",
      ]),
    ).toBe(0);
    expect(out).toContain("No transcripts found");
    await expect(main(["audit", "--dir", claude])).rejects.toThrow(/--dir needs --source/);
    await expect(main(["audit", "--source", "nope"])).rejects.toThrow(/--source expects/);
    await expect(main(["audit", "--since", "next week"])).rejects.toThrow(/--since/);
  });

  it("audit writes its page under the home directory by default", async () => {
    const claude = join(dir, "claude");
    writeClaudeCodeFixture(claude);
    expect(
      await main(["audit", "--source", "claude-code", "--dir", claude, "--since", "2026-08-01"]),
    ).toBe(0);
    const files = readdirSync(join(dir, "home", "audit"));
    expect(files).toHaveLength(1);
    expect(out).toContain(`HTML page: ${join(dir, "home", "audit", files[0] ?? "")}`);
  });

  it("contribute writes and prints the document, and stops without an endpoint", async () => {
    const claude = join(dir, "claude");
    writeClaudeCodeFixture(claude);
    expect(
      await main([
        "contribute",
        "--source",
        "claude-code",
        "--dir",
        claude,
        "--since",
        "2026-08-01",
      ]),
    ).toBe(0);
    expect(out).toContain('"schema": "sayagain.shape/1"');
    expect(out).toContain("No index endpoint is configured yet");
    expect(out).toMatch(/\d+ shapes across \d+ servers/);
    for (const secret of SECRETS) expect(out).not.toContain(secret);
    const files = readdirSync(join(dir, "home", "contributions"));
    expect(files).toHaveLength(1);
    const doc = JSON.parse(
      readFileSync(join(dir, "home", "contributions", files[0] ?? ""), "utf8"),
    ) as ShapeDocument;
    expect(doc.client.source).toBe("claude-code-transcripts");
    expect(doc.consent).toEqual({ termsVersion: "none", acceptedAt: "" });
    out = "";
    expect(await main(["contribute", "--status"])).toBe(0);
    expect(out).toMatch(/contributor {2}c_[0-9a-f]{16}/);
    expect(out).toContain("not accepted");
    expect(out).toContain("endpoint     none");
    await expect(main(["contribute", "--weekly", "on"])).rejects.toThrow(/needs an endpoint/);
    await expect(main(["contribute", "--weekly", "sometimes"])).rejects.toThrow(/on or off/);
    await expect(main(["contribute", "--endpoint", "http://index.example/v1"])).rejects.toThrow(
      /must be https/,
    );
    await expect(main(["contribute", "--accept-terms", "1999-01-01"])).rejects.toThrow(
      /current terms are version 2026-09-05/,
    );
  });

  it("contribute sends only with the terms accepted and a yes, then can go weekly and forget", async () => {
    const claude = join(dir, "claude");
    writeClaudeCodeFixture(claude);
    const idx = await index();
    try {
      const base = [
        "contribute",
        "--source",
        "claude-code",
        "--dir",
        claude,
        "--since",
        "2026-08-01",
        "--endpoint",
        idx.url,
      ];
      expect(await main([...base, "--yes"])).toBe(1);
      expect(out).toContain("needs --accept-terms 2026-09-05");
      expect(idx.calls).toHaveLength(0);
      out = "";
      expect(await main([...base, "--accept-terms", "2026-09-05"])).toBe(1); // not a terminal, no --yes
      expect(out).toContain("Nothing was sent");
      expect(idx.calls).toHaveLength(0);
      out = "";
      expect(await main([...base, "--yes"])).toBe(0);
      expect(out).toContain("sent: the index answered 201, receipt rcpt_9");
      expect(out).toContain("your servers on the index: https://index.example/c/9");
      expect(idx.calls).toHaveLength(1);
      expect(idx.calls[0]?.method).toBe("POST");
      const sent = JSON.parse(idx.calls[0]?.body ?? "") as ShapeDocument;
      expect(sent.consent.termsVersion).toBe("2026-09-05");
      expect(sent.shapes.length).toBeGreaterThan(0);
      out = "";
      expect(await main(["contribute", "--status", "--json"])).toBe(0);
      const status = JSON.parse(out) as {
        contributor: string;
        weekly: boolean;
        lastSentAt: string | null;
      };
      expect(status.lastSentAt).not.toBeNull();
      out = "";
      expect(await main(["contribute", "--weekly", "on"])).toBe(0);
      expect(out).toContain("weekly contribution: on");
      out = "";
      expect(await main(["contribute", "--forget"])).toBe(0);
      expect(out).toContain(`the index answered 201 to the deletion of ${status.contributor}`);
      expect(out).toMatch(
        new RegExp(`rotated: ${status.contributor} -> c_[0-9a-f]{16}; weekly contribution off`),
      );
      expect(idx.calls[1]?.method).toBe("DELETE");
      out = "";
      expect(await main(["contribute", "--status", "--json"])).toBe(0);
      const after = JSON.parse(out) as {
        contributor: string;
        weekly: boolean;
        lastSentAt: string | null;
      };
      expect(after.contributor).not.toBe(status.contributor);
      expect(after.weekly).toBe(false);
      expect(after.lastSentAt).toBeNull();
    } finally {
      await idx.close();
    }
  });

  it("contribute reads the ledger by default and says so when it is empty", async () => {
    const ledger = join(dir, "ledger.jsonl");
    writeFileSync(ledger, "");
    expect(await main(["contribute", "--ledger", ledger, "--since", "7d"])).toBe(0);
    expect(out).toContain("nothing to contribute");
    expect(out).toContain("try --source claude-code, codex or cursor");
    const row = (over: Partial<LedgerRow>): LedgerRow => ({
      receipt: `r${Math.random().toString(36).slice(2)}`,
      ts: new Date(Date.now() - 3_600_000).toISOString(),
      upstream: "fake-notion",
      server: "notion",
      method: "tools/call",
      tool: "create_page",
      toolClass: "write",
      argShape: ["limit:string"],
      argsHash: "h",
      hasIntent: false,
      session: "s1",
      status: "executed",
      isError: false,
      latencyMs: 5,
      requestBytes: 10,
      responseBytes: 20,
      ...over,
    });
    writeFileSync(
      ledger,
      [
        row({
          isError: true,
          errorClass: "coercible",
          errorSignature: "Invalid params: limit must be a number",
        }),
        row({ argShape: ["limit:number"], argsHash: "h2" }),
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(""),
    );
    out = "";
    expect(await main(["contribute", "--ledger", ledger, "--since", "7d", "--json"])).toBe(0);
    const doc = JSON.parse(out) as ShapeDocument;
    expect(doc.client.source).toBe("ledger");
    expect(doc.shapes).toEqual([
      expect.objectContaining({
        server: "fake-notion",
        tool: "create_page",
        modelFamily: "unknown",
        calls: 2,
        failures: 1,
      }),
    ]);
    expect(doc.shapes[0]?.errors[0]).toMatchObject({
      class: "coercible",
      resolution: "type-change",
    });
    expect(out).not.toContain("Invalid params");
    expect(existsSync(join(dir, "home", "contributions"))).toBe(true);
    await expect(main(["contribute", "--dir", dir])).rejects.toThrow(
      /--dir goes with a transcript --source/,
    );
  });

  it("keeps T0 fixtures inside the audit window", () => {
    expect(T0).toBeLessThan(Date.now());
  });
});
