import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoveries, report } from "./analysis.js";
import {
  SECRETS,
  T0,
  writeClaudeCodeFixture,
  writeCodexFixture,
  writeCursorFixture,
} from "./test-fixtures/transcripts.js";
import {
  modelFamily,
  readSession,
  scanTranscripts,
  sessionRows,
  type TranscriptCall,
  toolClassFor,
} from "./transcripts.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sayagain-transcripts-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const by = (calls: TranscriptCall[], tool: string): TranscriptCall[] =>
  calls.filter((c) => c.tool === tool);

describe("transcripts", () => {
  it("classes tools the way the boundary would, from built-in names and verbs", () => {
    expect(toolClassFor("Read", false)).toEqual({ toolClass: "read-only", classSource: "builtin" });
    expect(toolClassFor("Bash", false)).toEqual({ toolClass: "write", classSource: "builtin" });
    expect(toolClassFor("Agent", false)).toEqual({
      toolClass: "read-only",
      classSource: "default",
    });
    expect(toolClassFor("get_page", true)).toEqual({ toolClass: "read-only", classSource: "verb" });
    expect(toolClassFor("create_page", true)).toEqual({ toolClass: "write", classSource: "verb" });
    expect(toolClassFor("delete_page", true)).toEqual({
      toolClass: "destructive",
      classSource: "verb",
    });
    expect(toolClassFor("summarize", true)).toEqual({ toolClass: "write", classSource: "default" });
    expect(modelFamily("claude-sonnet-5")).toBe("claude");
    expect(modelFamily("gpt-5.5")).toBe("gpt");
    expect(modelFamily("gemini-2.5-pro")).toBe("gemini");
    expect(modelFamily("qwen3-8b")).toBe("open-weight");
    expect(modelFamily("")).toBe("unknown");
  });

  it("reads a Claude Code session: outcomes, classes, shapes, and tokens split across a turn", () => {
    const file = writeClaudeCodeFixture(root);
    const s = readSession(file, "claude-code");
    expect(s.source).toBe("claude-code");
    expect(s.resultsRecorded).toBe(true);
    expect(s.calls).toHaveLength(9);
    expect(s.tokens).toEqual({ input: 1850, cacheRead: 5000, cacheCreate: 0, output: 470 });
    expect(s.families).toEqual({ claude: 9 });
    const read = by(s.calls, "Read")[0] as TranscriptCall;
    expect(read).toMatchObject({
      server: "claude-code",
      isMcp: false,
      outcome: "ok",
      toolClass: "read-only",
    });
    expect(read.tokens).toBe(6100 + 150); // the text-only first turn carries into the first call
    expect(read.latencyMs).toBe(1000);
    const [failed, fixed, again] = by(s.calls, "create_page");
    expect(failed).toMatchObject({
      server: "notion",
      isMcp: true,
      toolClass: "write",
      outcome: "error",
      errorClass: "coercible",
      signature: "Invalid params: limit must be a number (see <url>",
      argShape: ["limit:string", "parent:string"],
    });
    expect(fixed).toMatchObject({ outcome: "ok", argShape: ["limit:number", "parent:string"] });
    expect(again?.argsHash).toBe(fixed?.argsHash);
    expect(by(s.calls, "Edit")[0]).toMatchObject({ outcome: "no-result", toolClass: "write" });
    expect(by(s.calls, "Bash")[0]).toMatchObject({ outcome: "interrupt", toolClass: "write" });
    expect(by(s.calls, "get_item")[0]).toMatchObject({ server: "private-connector", isMcp: true }); // the UUID stays home
    const pages = by(s.calls, "get_page");
    expect(pages).toHaveLength(2);
    expect(pages.map((c) => c.tokens)).toEqual([100, 100]); // one turn, two calls
    // The wrap-up turn after the last call belongs to the last call, so the session's spend adds up.
    const total = s.calls.reduce((a, c) => a + c.tokens, 0);
    expect(Math.round(total)).toBe(1850 + 5000 + 470);
    expect(JSON.stringify(s)).not.toMatch(/SECRET|example\.com\/private|\/Users\/k\//);
  });

  it("reads a Codex rollout: exit codes, MCP call events with schemas, patches, aborts, token counts", () => {
    const file = writeCodexFixture(root);
    const s = readSession(file, "codex");
    expect(s.calls.map((c) => [c.tool, c.outcome])).toEqual([
      ["exec_command", "error"],
      ["list_pull_requests", "ok"], // one call, although the file records it twice
      ["apply_patch", "error"],
      ["exec_command", "interrupt"],
      ["shell", "ok"], // exit code 0 beats a stdout line starting with Error
      ["exec_command", "ok"],
      ["shell", "error"], // exit code 2 in the JSON wrapper
      ["get_pr", "error"], // an Err result
    ]);
    const [shell, mcp, patch] = s.calls;
    expect(shell).toMatchObject({ server: "codex", toolClass: "write", model: "gpt-5.5" });
    expect(shell?.errorClass).toBeDefined();
    expect(shell?.signature).toBe("error: unknown command <str>"); // the wrapper's header is not the error
    expect(shell?.tokens).toBe(550); // the turn's 1100 tokens, shared with the MCP call it issued
    expect(mcp).toMatchObject({
      server: "github",
      isMcp: true,
      toolClass: "read-only",
      latencyMs: 1500,
      argShape: ["repo:string", "state:string"],
    });
    expect(mcp?.schemaHash).toMatch(/^[0-9a-f]{16}$/);
    expect(patch?.signature).toBe(
      "apply_patch verification failed: Failed to find expected lines in <path>",
    );
    expect([mcp?.tokens, patch?.tokens]).toEqual([550, 550]);
    expect(s.calls[6]?.signature).toBe("boom: <str>");
    expect(s.calls[7]).toMatchObject({ server: "github", isMcp: true, errorClass: "other" });
    expect(s.calls[7]?.latencyMs).toBe(5);
    expect(s.families).toEqual({ gpt: 8 });
    expect(s.usd).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toMatch(/SECRET|\/Users\/k\//);
  });

  it("handles split responses, rejections, in-flight calls and subagent files", () => {
    const project = join(root, "-Users-k-projects-SECRET");
    mkdirSync(join(project, "sess-1", "subagents"), { recursive: true });
    const at = (s: number) => new Date(T0 + s * 1000).toISOString();
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 10,
    };
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const parent = join(project, "sess-1.jsonl");
    writeFileSync(
      parent,
      [
        // One API response written as three lines with the same requestId and usage: counted once.
        line({
          type: "assistant",
          timestamp: at(0),
          requestId: "r1",
          message: {
            model: "claude-sonnet-5",
            usage,
            content: [{ type: "thinking", thinking: "SECRET" }],
          },
        }),
        line({
          type: "assistant",
          timestamp: at(0),
          requestId: "r1",
          message: { model: "claude-sonnet-5", usage, content: [{ type: "text", text: "SECRET" }] },
        }),
        line({
          type: "assistant",
          timestamp: at(0),
          requestId: "r1",
          message: {
            model: "claude-sonnet-5",
            usage,
            content: [
              { type: "tool_use", id: "u1", name: "Bash", input: { command: "rm SECRET" } },
            ],
          },
        }),
        // The user refused: the tool never ran.
        line({
          type: "user",
          timestamp: at(1),
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "u1",
                is_error: true,
                content:
                  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a Bash command).",
              },
            ],
          },
        }),
        line({
          type: "assistant",
          timestamp: at(2),
          requestId: "r2",
          message: {
            model: "claude-sonnet-5",
            usage,
            content: [{ type: "tool_use", id: "u2", name: "Edit", input: { file_path: "SECRET" } }],
          },
        }),
        // No result yet, and the file's last line is recent: in flight, not lost.
      ].join(""),
    );
    const sub = join(project, "sess-1", "subagents", "agent-a.jsonl");
    writeFileSync(
      sub,
      [
        line({
          type: "assistant",
          timestamp: at(3),
          requestId: "r3",
          isSidechain: true,
          message: {
            model: "claude-sonnet-5",
            usage,
            content: [{ type: "tool_use", id: "u3", name: "Read", input: { file_path: "SECRET" } }],
          },
        }),
        line({
          type: "user",
          timestamp: at(4),
          message: { content: [{ type: "tool_result", tool_use_id: "u3", content: "ok" }] },
        }),
      ].join(""),
    );
    const live = readSession(parent, "claude-code", { now: T0 + 60_000 });
    expect(live.tokens).toEqual({ input: 200, cacheRead: 0, cacheCreate: 0, output: 20 });
    expect(live.calls.map((c) => [c.tool, c.outcome])).toEqual([
      ["Bash", "rejected"],
      ["Edit", "unrecorded"],
    ]);
    const later = readSession(parent, "claude-code", { now: T0 + 2 * 3_600_000 });
    expect(later.calls[1]?.outcome).toBe("no-result");
    expect(sessionRows(live).rows.map((r) => r.tool)).toEqual(["Edit"]); // the rejected call gets no row
    const child = readSession(sub, "claude-code");
    expect(child.id).toBe(live.id); // one conversation, one stream
    expect(child.fileKey).not.toBe(live.fileKey);
    const rows = [...sessionRows(later).rows, ...sessionRows(child).rows];
    expect(new Set(rows.map((r) => r.receipt)).size).toBe(2);
    expect(new Set(rows.map((r) => r.session)).size).toBe(1);
    const scan = scanTranscripts({
      sources: ["claude-code"],
      dirs: { "claude-code": root },
      now: T0 + 60_000,
    });
    expect(scan.files["claude-code"]).toBe(2);
    expect(new Set(scan.sessions.map((s) => s.id)).size).toBe(1);
  });

  it("reads Cursor transcripts, and marks a file without tool results as unrecorded", () => {
    const { withResults, withoutResults } = writeCursorFixture(root);
    const a = readSession(withResults, "cursor");
    expect(a.resultsRecorded).toBe(true);
    expect(a.calls.map((c) => [c.server, c.tool, c.outcome])).toEqual([
      ["cursor", "read_file", "ok"],
      ["github", "create_issue", "error"],
    ]);
    expect(a.calls[1]).toMatchObject({ errorClass: "semantic", toolClass: "write", tokens: 0 });
    expect(a.families).toEqual({ unknown: 2 });
    const b = readSession(withoutResults, "cursor");
    expect(b.resultsRecorded).toBe(false);
    expect(b.calls.map((c) => c.outcome)).toEqual(["unrecorded", "unrecorded"]);
  });

  it("turns a session into ledger rows the analysis understands", () => {
    const s = readSession(writeClaudeCodeFixture(root), "claude-code");
    const { rows, extras } = sessionRows(s);
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.session === s.id && r.method === "tools/call")).toBe(true);
    const edit = rows.find((r) => r.tool === "Edit");
    expect(edit).toMatchObject({ isError: true, errorClass: "no-result", status: "executed" });
    const bash = rows.find((r) => r.tool === "Bash");
    expect(bash).toMatchObject({ isError: true, errorClass: "interrupt" });
    expect(extras.get(rows[0]?.receipt ?? "")).toMatchObject({
      family: "claude",
      source: "claude-code",
    });
    const recs = recoveries(rows);
    expect(recs).toHaveLength(1); // an interrupt and a missing result are unknown outcomes, not failures
    expect(recs[0]).toMatchObject({
      recovered: true,
      calls: 0,
      retried: true,
      identicalRetry: false,
      shapeChange: "changed limit:string->number",
    });
    expect(recs[0]?.rows.map((r) => r.tool)).toEqual(["create_page", "create_page"]);
    const r = report(rows, { since: new Date(T0 - 1000), until: new Date(T0 + 60_000) });
    expect(r.calls).toBe(9);
    expect(r.writes).toBe(5);
    expect(r.unacknowledged).toMatchObject({ count: 2 }); // the Edit with no result, the interrupted Bash
    expect(r.northStar.unacknowledgedWritesPer1kWrites).toBe(400);
    expect(r.duplicates.count).toBe(1);
    expect(r.byServer.find((x) => x.server === "notion")).toMatchObject({
      calls: 5,
      failures: 1,
      classes: { coercible: 1 },
    });
    expect(r.byServer.find((x) => x.server === "claude-code")?.failures).toBe(0);
    expect(r.northStar.failureTaxBytesPer1kCalls).toBe(Math.round((1000 * 300) / 9)); // tokens of the two create_page turns
  });

  it("scans the three hosts' directories, honouring overrides and the since cut-off", () => {
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    const cursor = join(root, "cursor");
    const claudeFile = writeClaudeCodeFixture(claude);
    writeCodexFixture(codex);
    writeCursorFixture(cursor);
    const scan = scanTranscripts({ dirs: { "claude-code": claude, codex, cursor } });
    expect(scan.files).toEqual({ "claude-code": 1, codex: 1, cursor: 2 }); // the stray .jsonl outside agent-transcripts is skipped
    expect(scan.sessions.map((s) => s.source).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "cursor",
    ]);
    const old = new Date(T0 - 30 * 86_400_000);
    utimesSync(claudeFile, old, old);
    const recent = scanTranscripts({
      dirs: { "claude-code": claude, codex, cursor },
      since: new Date(T0 - 86_400_000),
    });
    expect(recent.files["claude-code"]).toBe(0);
    expect(scan.sessions.find((s) => s.source === "codex")?.calls).toHaveLength(8);
    expect(recent.sessions.some((s) => s.source === "claude-code")).toBe(false);
    const none = scanTranscripts({ sources: ["codex"], dirs: { codex: join(root, "missing") } });
    expect(none.sessions).toEqual([]);
    for (const secret of SECRETS) expect(JSON.stringify(scan.sessions)).not.toContain(secret);
  });
});
