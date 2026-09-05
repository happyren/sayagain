/**
 * Transcript fixtures for the audit and contribution tests. Every value that must never leave a
 * reader carries a SECRET marker, so a test can assert on its absence from any output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const T0 = Date.parse("2026-09-01T10:00:00Z");
export const SECRETS = ["SECRET", "example.com/private", "/Users/k/"];
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

/** A Claude Code session: nine calls, one coercible failure, a duplicate write, an interrupt, a missing result, a UUID-named connector. */
export function writeClaudeCodeFixture(root: string): string {
  const dir = join(root, "-Users-k-projects-SECRET-proj");
  mkdirSync(dir, { recursive: true });
  const usage = (input: number, output: number, cacheRead = 0) => ({
    input_tokens: input,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
    output_tokens: output,
  });
  const assistant = (s: number, requestId: string, content: unknown[], u: unknown) =>
    line({
      type: "assistant",
      timestamp: at(s),
      requestId,
      message: { role: "assistant", model: "claude-sonnet-5", usage: u, content },
    });
  const result = (s: number, id: string, text: string, isError = false, top?: unknown) =>
    line({
      type: "user",
      timestamp: at(s),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }],
      },
      ...(top ? { toolUseResult: top } : {}),
    });
  const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
  const file = join(dir, "session-SECRET.jsonl");
  writeFileSync(
    file,
    [
      assistant(0, "r1", [{ type: "text", text: "SECRET prompt text" }], usage(1000, 100, 5000)),
      assistant(
        1,
        "r2",
        [use("u1", "Read", { file_path: "/Users/k/SECRET/a.ts" })],
        usage(100, 50),
      ),
      result(2, "u1", "file contents SECRET"),
      assistant(
        3,
        "r3",
        [use("u2", "mcp__notion__create_page", { parent: "SECRET-VALUE-42", limit: "10" })],
        usage(100, 50),
      ),
      result(
        4,
        "u2",
        "Invalid params: limit must be a number (see https://example.com/private/SECRET)",
        true,
      ),
      assistant(
        5,
        "r4",
        [use("u3", "mcp__notion__create_page", { parent: "SECRET-VALUE-42", limit: 10 })],
        usage(100, 50),
      ),
      result(6, "u3", "created SECRET"),
      assistant(
        7,
        "r5",
        [use("u4", "Edit", { file_path: "/Users/k/SECRET/b.ts", old_string: "SECRET-OLD" })],
        usage(100, 50),
      ),
      assistant(8, "r6", [use("u5", "Bash", { command: "rm -rf SECRET-CMD" })], usage(100, 50)),
      result(9, "u5", "Request interrupted by user", true),
      assistant(
        10,
        "r7",
        [
          use("u6", "mcp__notion__get_page", { id: "SECRET-1" }),
          use("u7", "mcp__notion__get_page", { id: "SECRET-2" }),
        ],
        usage(150, 50),
      ),
      result(11, "u6", "page SECRET-1"),
      result(12, "u7", "page SECRET-2"),
      assistant(
        13,
        "r8",
        [use("u8", "mcp__notion__create_page", { parent: "SECRET-VALUE-42", limit: 10 })],
        usage(100, 50),
      ),
      result(14, "u8", "created again SECRET"),
      assistant(
        15,
        "r9",
        [use("u9", "mcp__bf7c680d-5fdc-5ef4-b4a0-abadb619bf0a__get_item", { id: "SECRET-3" })],
        usage(100, 20),
      ),
      result(16, "u9", "item SECRET-3"),
    ].join(""),
  );
  return file;
}

/** A Codex rollout: a failed shell command, an MCP call with a schema, a failed patch, an aborted command. */
export function writeCodexFixture(root: string): string {
  const dir = join(root, "2026", "09", "01");
  mkdirSync(dir, { recursive: true });
  const item = (s: number, type: string, payload: unknown) =>
    line({ timestamp: at(s), type, payload });
  const tokens = (s: number, input: number, cached: number, output: number) =>
    item(s, "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {},
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
      },
    });
  const file = join(dir, "rollout-2026-09-01T10-00-00-SECRET.jsonl");
  writeFileSync(
    file,
    [
      item(0, "session_meta", {
        id: "SECRET-session",
        timestamp: at(0),
        cwd: "/Users/k/SECRET",
        dynamic_tools: [
          {
            namespace: "github",
            name: "list_pull_requests",
            description: "SECRET description",
            inputSchema: { type: "object", properties: { state: { type: "string" } } },
          },
        ],
      }),
      item(1, "turn_context", { turn_id: "t1", cwd: "/Users/k/SECRET", model: "gpt-5.5" }),
      item(2, "response_item", {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "git status SECRET-CMD" }),
        call_id: "c1",
      }),
      item(3, "response_item", {
        type: "function_call_output",
        call_id: "c1",
        output:
          "Chunk ID: abc12\nWall time: 1.0 seconds\nProcess exited with code 1\nOriginal token count: 12\nOutput:\nerror: unknown command 'SECRET-OUT'",
      }),
      tokens(4, 1000, 600, 100),
      item(5, "event_msg", {
        type: "mcp_tool_call_end",
        call_id: "m1",
        invocation: {
          server: "github",
          tool: "list_pull_requests",
          arguments: { state: "open", repo: "SECRET/repo" },
        },
        duration: { secs: 1, nanos: 500_000_000 },
        result: { Ok: { content: [{ type: "text", text: "[] SECRET" }], isError: false } },
      }),
      item(6, "response_item", {
        type: "custom_tool_call",
        status: "completed",
        call_id: "c2",
        name: "apply_patch",
        input: "*** Begin Patch SECRET-PATCH",
      }),
      item(7, "response_item", {
        type: "custom_tool_call_output",
        call_id: "c2",
        output:
          "apply_patch verification failed: Failed to find expected lines in /Users/k/SECRET/x.ts",
      }),
      tokens(8, 500, 0, 50),
      item(9, "response_item", {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls SECRET" }),
        call_id: "c3",
      }),
      item(10, "response_item", {
        type: "function_call_output",
        call_id: "c3",
        output: "aborted by user after 3.0s",
      }),
      tokens(11, 200, 0, 10),
    ].join(""),
  );
  return file;
}

/** Two Cursor sessions: one with results (a read, then a failed MCP write), one that records calls only. */
export function writeCursorFixture(root: string): { withResults: string; withoutResults: string } {
  const project = join(root, "SECRET-project", "agent-transcripts");
  const s1 = join(project, "s1");
  const s2 = join(project, "s2");
  mkdirSync(s1, { recursive: true });
  mkdirSync(s2, { recursive: true });
  const assistant = (content: unknown[]) =>
    line({ role: "assistant", message: { role: "assistant", content } });
  const user = (content: unknown[]) => line({ role: "user", message: { role: "user", content } });
  const withResults = join(s1, "s1.jsonl");
  writeFileSync(
    withResults,
    [
      user([{ type: "text", text: "SECRET request" }]),
      assistant([
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "/Users/k/SECRET/c.ts" } },
      ]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "contents SECRET" }]),
      assistant([
        {
          type: "tool_use",
          id: "t2",
          name: "mcp__github__create_issue",
          input: { title: "SECRET-TITLE" },
        },
      ]),
      user([
        {
          type: "tool_result",
          tool_use_id: "t2",
          is_error: true,
          content: [{ type: "text", text: "Error: repository '/Users/k/SECRET/repo' not found" }],
        },
      ]),
    ].join(""),
  );
  // Not a transcript: Cursor keeps other JSON lines under a project too.
  writeFileSync(
    join(root, "SECRET-project", "notes.jsonl"),
    line({
      role: "assistant",
      message: { content: [{ type: "tool_use", id: "x", name: "read_file", input: {} }] },
    }),
  );
  const withoutResults = join(s2, "s2.jsonl");
  writeFileSync(
    withoutResults,
    [
      user([{ type: "text", text: "SECRET request" }]),
      assistant([
        { type: "tool_use", id: "t3", name: "edit_file", input: { path: "/Users/k/SECRET/d.ts" } },
      ]),
      assistant([
        { type: "tool_use", id: "t4", name: "read_file", input: { path: "/Users/k/SECRET/d.ts" } },
      ]),
    ].join(""),
  );
  return { withResults, withoutResults };
}
