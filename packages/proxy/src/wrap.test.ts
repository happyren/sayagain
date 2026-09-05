import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LearnedStore } from "./learned.js";
import { MemoryLedger } from "./ledger.js";
import { OtlpExporter } from "./otlp.js";
import { PROXY_VERSION } from "./version.js";
import { wrap } from "./wrap.js";

const fixture = new URL("../test/fake-server.mjs", import.meta.url).pathname;

function harness(
  policy: Parameters<typeof wrap>[0]["policy"] = {},
  extra: Partial<Parameters<typeof wrap>[0]> = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const ledger = new MemoryLedger();
  const logs: string[] = [];
  const lines: string[] = [];
  let buf = "";
  output.on("data", (c: Buffer) => {
    buf += c.toString();
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  });
  const wrapped = wrap({
    command: process.execPath,
    args: [fixture],
    input,
    output,
    ledger,
    announce: true,
    control: false,
    policy,
    holdTtlMs: 200,
    log: (l) => logs.push(l),
    ...extra,
  });
  const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`);
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const waitFor = (id: unknown, timeoutMs = 5000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = parsed().find((m) => m.id === id);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > timeoutMs)
          return reject(new Error(`no response for id ${String(id)}`));
        setTimeout(tick, 10);
      };
      tick();
    });
  const handshake = async () => {
    send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const init = await waitFor("init");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
    await waitFor("list");
    return init;
  };
  const finish = async () => {
    input.end();
    return wrapped.done;
  };
  const call = (id: unknown, name: string, args: unknown, meta?: Record<string, unknown>) => {
    const params: Record<string, unknown> = { name, arguments: args };
    if (meta) params._meta = meta;
    send({ jsonrpc: "2.0", id, method: "tools/call", params });
  };
  const pendingHold = async () => {
    for (let i = 0; i < 50 && !wrapped.holds.list().length; i++)
      await new Promise((r) => setTimeout(r, 10));
    return wrapped.holds.list()[0];
  };
  return {
    input,
    ledger,
    logs,
    wrapped,
    send,
    waitFor,
    handshake,
    finish,
    call,
    parsed,
    pendingHold,
  };
}

const meta = (m: Record<string, unknown>) => (m.result as { _meta: Record<string, unknown> })._meta;
const text0 = (m: Record<string, unknown>) =>
  (m.result as { content: { text: string }[] }).content[0]?.text ?? "";
const texts = (m: Record<string, unknown>) =>
  (m.result as { content: { text: string }[] }).content.map((c) => c.text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("wrap end to end", () => {
  it("passes identity through and stamps receipts, also on JSON-RPC errors", async () => {
    const h = harness();
    await h.handshake();
    h.call(3, "echo", { a: 1 });
    const ok = await h.waitFor(3);
    expect(meta(ok)["example/upstream"]).toBe(true);
    expect(meta(ok)["sh.sayagain/status"]).toBe("executed");
    h.call(4, "echo", { fail: true });
    expect((await h.waitFor(4)).result).toMatchObject({ isError: true });
    h.call(5, "echo", { rpcError: true });
    const rpc = await h.waitFor(5);
    expect((rpc.error as { data: Record<string, unknown> }).data["sh.sayagain/status"]).toBe(
      "executed",
    );
    h.call(6, "echo", { rpcErrorNoMessage: true });
    expect((await h.waitFor(6)).error).toBeDefined();
    h.send({ jsonrpc: "2.0", id: 7, method: "ping" });
    await h.waitFor(7);
    expect(await h.finish()).toBe(0);
    expect(h.ledger.rows.map((r) => [r.tool, r.toolClass, r.isError])).toEqual([
      ["echo", "read-only", false],
      ["echo", "read-only", true],
      ["echo", "read-only", true],
      ["echo", "read-only", true],
    ]);
  });

  it("reports the package version and preserves client message order", async () => {
    const h = harness();
    await h.handshake();
    const init = h.parsed().find((m) => m.id === "init") as Record<string, unknown>;
    expect((meta(init)["sh.sayagain/boundary"] as { version: string }).version).toBe(PROXY_VERSION);
    expect(PROXY_VERSION).toBe(
      (
        JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
          version: string;
        }
      ).version,
    );
    // a ping queued right after a call must not overtake it
    h.call(1, "echo", { a: 1 });
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    await h.waitFor(2);
    const ids = h
      .parsed()
      .filter((m) => m.id === 1 || m.id === 2)
      .map((m) => m.id);
    expect(ids).toEqual([1, 2]);
    await h.finish();
  });
});

describe("DISREGARD", () => {
  it("answers a repeated write from the first result, with key-order independence; reads are not deduped", async () => {
    const h = harness();
    await h.handshake();
    h.call(1, "create_page", { title: "x", body: "y" });
    const first = await h.waitFor(1);
    h.call(2, "create_page", { body: "y", title: "x" });
    const second = await h.waitFor(2);
    expect(meta(second)["sh.sayagain/status"]).toBe("deduplicated");
    expect(meta(second)["sh.sayagain/duplicate-of"]).toBe(meta(first)["sh.sayagain/receipt"]);
    h.call(3, "echo", { a: 1 });
    await h.waitFor(3);
    h.call(4, "echo", { a: 1 });
    expect(meta(await h.waitFor(4))["sh.sayagain/status"]).toBe("executed");
    await h.finish();
  });

  it("uses the idempotency key alone when one is given, so distinct keys are distinct calls", async () => {
    const h = harness();
    await h.handshake();
    h.call(1, "create_page", { t: 1 }, { "sh.sayagain/idempotency-key": "A" });
    await h.waitFor(1);
    h.call(2, "create_page", { t: 1 }, { "sh.sayagain/idempotency-key": "B" });
    expect(meta(await h.waitFor(2))["sh.sayagain/status"]).toBe("executed");
    h.call(3, "create_page", { t: 2 }, { "sh.sayagain/idempotency-key": "A" });
    expect(meta(await h.waitFor(3))["sh.sayagain/status"]).toBe("deduplicated");
    await h.finish();
  });

  it("makes a concurrent duplicate wait for the first result instead of executing twice", async () => {
    const h = harness();
    await h.handshake();
    h.call(1, "slow_write", { delayMs: 150, x: 1 });
    h.call(2, "slow_write", { delayMs: 150, x: 1 });
    const [a, b] = await Promise.all([h.waitFor(1), h.waitFor(2)]);
    expect(meta(a)["sh.sayagain/status"]).toBe("executed");
    expect(meta(b)["sh.sayagain/status"]).toBe("deduplicated");
    expect(text0(a)).toBe(text0(b));
    await h.finish();
    expect(h.ledger.rows.map((r) => r.status)).toEqual(["executed", "deduplicated"]);
  });
});

describe("STANDBY", () => {
  it("holds a destructive call, executes once on approve, dead-letters it if that execution fails", async () => {
    const h = harness({ holdWaitMs: 2000 });
    await h.handshake();
    h.call(1, "delete_page", { id: 42 }, { "sh.sayagain/intent": "remove the draft" });
    const pending = await h.pendingHold();
    expect(pending).toMatchObject({
      tool: "delete_page",
      intent: "remove the draft",
      arguments: { id: 42 },
    });
    h.wrapped.holds.decide(pending?.receipt ?? "", "approve");
    const done = await h.waitFor(1);
    expect(meta(done)["sh.sayagain/held"]).toMatchObject({ mode: "pre", decision: "approve" });
    h.call(2, "delete_page", { id: 43, fail: true });
    h.wrapped.holds.decide((await h.pendingHold())?.receipt ?? "", "approve");
    const failed = await h.waitFor(2);
    expect(meta(failed)["sh.sayagain/status"]).toBe("dead-lettered");
    await h.finish();
    expect(h.wrapped.deadLetters.list().map((d) => d.tool)).toEqual(["delete_page"]);
  });

  it("answers UNABLE on reject, STANDBY after the wait, and drops a hold the client cancels", async () => {
    const h = harness({ holdWaitMs: 100 });
    await h.handshake();
    h.call(1, "delete_page", { id: 1 });
    h.wrapped.holds.decide((await h.pendingHold())?.receipt ?? "", "reject");
    const rejected = await h.waitFor(1);
    expect((rejected.result as { isError: boolean }).isError).toBe(true);
    h.call(2, "delete_page", { id: 2 });
    const held = await h.waitFor(2);
    expect(text0(held)).toContain("STANDBY");
    expect(h.wrapped.holds.list()).toHaveLength(1);
    await sleep(250);
    expect(h.wrapped.holds.list()).toHaveLength(0);
    h.call(3, "delete_page", { id: 3 });
    await h.pendingHold();
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } });
    await sleep(50);
    expect(h.wrapped.holds.list()).toHaveLength(0);
    expect(h.parsed().find((m) => m.id === 3)).toBeUndefined();
    await h.finish();
    expect(h.ledger.rows.map((r) => [r.status, r.held?.cancelled ?? false])).toEqual([
      ["held", false],
      ["held", false],
      ["held", true],
    ]);
  });

  it("holds a write with unknown outcome, says so, keeps the failed attempt, and executes once on approve", async () => {
    const h = harness({ holdWaitMs: 100 });
    await h.handshake();
    h.call(1, "write_flaky", { failTimes: 1, title: "x" });
    const held = await h.waitFor(1);
    expect(text0(held)).toContain("outcome is unknown");
    expect(text0(held)).not.toContain("has not been executed");
    expect(meta(held)["sh.sayagain/held"]).toMatchObject({ mode: "unknown-outcome" });
    const pending = h.wrapped.holds.list()[0];
    expect(pending?.reason).toContain("unknown outcome");
    h.wrapped.holds.decide(pending?.receipt ?? "", "approve");
    await sleep(100);
    await h.finish();
    const rows = h.ledger.rows.filter((r) => r.tool === "write_flaky");
    expect(rows.map((r) => [r.status, r.isError, r.errorClass ?? null])).toEqual([
      ["executed", true, "retryable"],
      ["held", false, "retryable"],
      ["executed", false, null],
    ]);
    expect(rows[2]?.attempts).toBe(2);
  });

  it("--hold never disables the unknown-outcome hold too", async () => {
    const h = harness({ hold: "never" });
    await h.handshake();
    h.call(1, "write_flaky", { failTimes: 1 });
    const m = await h.waitFor(1);
    expect(meta(m)["sh.sayagain/status"]).toBe("executed");
    expect((m.result as { isError: boolean }).isError).toBe(true);
    await h.finish();
    expect(h.wrapped.holds.list()).toHaveLength(0);
  });
});

describe("retry, repair, dead-letter, replay", () => {
  it("retries a retryable failure on a read-only tool with backoff and records attempts", async () => {
    const h = harness({ retryAttempts: 3, retryBaseMs: 10 });
    await h.handshake();
    h.call(1, "flaky", { failTimes: 2 });
    const ok = await h.waitFor(1);
    expect(meta(ok)["sh.sayagain/status"]).toBe("executed");
    expect(text0(ok)).toContain('"call":3');
    await h.finish();
    expect(h.ledger.rows[0]).toMatchObject({
      tool: "flaky",
      attempts: 3,
      isError: false,
      status: "executed",
    });
  });

  it("dead-letters after the retry budget, appends guidance, replays on request, and resolves the entry", async () => {
    const h = harness({ retryAttempts: 2, retryBaseMs: 10 });
    await h.handshake();
    h.call(1, "flaky", { failTimes: 2 }, { "sh.sayagain/intent": "read the flaky thing" });
    const dead = await h.waitFor(1);
    expect(meta(dead)["sh.sayagain/status"]).toBe("dead-lettered");
    expect(texts(dead)[1]).toContain("sayagain replay");
    const receipt = String(meta(dead)["sh.sayagain/receipt"]);
    expect(h.wrapped.deadLetters.get(receipt)).toMatchObject({
      tool: "flaky",
      intent: "read the flaky thing",
      attempts: 2,
    });
    const outcome = await h.wrapped.replay(receipt);
    expect(outcome).toMatchObject({ replayOf: receipt, isError: false });
    expect(h.wrapped.deadLetters.list()).toHaveLength(0);
    expect(await h.wrapped.replay(receipt)).toBeNull();
    await h.finish();
    expect(h.ledger.rows.map((r) => [r.status, r.replayOf ?? null])).toEqual([
      ["dead-lettered", null],
      ["executed", receipt],
    ]);
  });

  it("repairs a read-only call from the schema, reports repaired, and dedupes by the client's arguments afterwards", async () => {
    const h = harness({ hold: "never" });
    await h.handshake();
    h.call(1, "strict_write", { limit: "10", tags: ["a", "b"] });
    const ok = await h.waitFor(1);
    expect(meta(ok)["sh.sayagain/status"]).toBe("repaired");
    expect(meta(ok)["sh.sayagain/repair"]).toMatchObject({
      kind: "coerce",
      changes: [
        { path: "/limit", rule: "string-to-number", to: 10 },
        { path: "/tags", rule: "array-to-comma-string", to: "a,b" },
      ],
    });
    h.call(2, "strict_write", { limit: "10", tags: ["a", "b"] });
    expect(meta(await h.waitFor(2))["sh.sayagain/status"]).toBe("deduplicated");
    await h.finish();
    expect(h.ledger.rows[0]).toMatchObject({
      attempts: 2,
      budget: "window",
      repairs: [
        { path: "/limit", rule: "string-to-number" },
        { path: "/tags", rule: "array-to-comma-string" },
      ],
    });
  });

  it("holds the repaired arguments of a write for approval before sending them", async () => {
    const h = harness({ holdWaitMs: 2000 });
    await h.handshake();
    h.call(1, "strict_write", { limit: "7" });
    const pending = await h.pendingHold();
    expect(pending?.reason).toContain("arguments repaired");
    expect(pending?.arguments).toEqual({ limit: 7 });
    h.wrapped.holds.decide(pending?.receipt ?? "", "approve");
    const ok = await h.waitFor(1);
    expect(meta(ok)["sh.sayagain/status"]).toBe("repaired");
    expect(meta(ok)["sh.sayagain/held"]).toMatchObject({ mode: "repaired", decision: "approve" });
    await h.finish();
    expect(h.ledger.rows.map((r) => r.status)).toEqual(["executed", "repaired"]);
  });

  it("dead-letters when the repair does not help, and finishes plainly when nothing can be repaired", async () => {
    const h = harness();
    await h.handshake();
    h.call(1, "strict", { limit: "abc" });
    const plain = await h.waitFor(1);
    expect(meta(plain)["sh.sayagain/status"]).toBe("executed");
    expect(texts(plain)[1]).toContain("Say Again:");
    h.call(2, "strict", { limit: "10", tags: { nested: true } });
    expect(meta(await h.waitFor(2))["sh.sayagain/status"]).toBe("dead-lettered");
    await h.finish();
    expect(h.wrapped.deadLetters.list()).toHaveLength(1);
  });

  it("appends guidance to a semantic failure without retrying it", async () => {
    const h = harness();
    await h.handshake();
    h.call(1, "missing", {});
    const m = await h.waitFor(1);
    expect(texts(m)).toHaveLength(2);
    expect(texts(m)[1]).toContain("read-only tool");
    await h.finish();
    expect(h.ledger.rows[0]?.attempts).toBeUndefined();
  });
});

describe("lifecycle", () => {
  it("holds a destructive call that arrives before the client ever asked for tools/list", async () => {
    const h = harness({ holdWaitMs: 300 });
    h.send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    await h.waitFor("init");
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.call(1, "delete_page", { id: 7 });
    expect(meta(await h.waitFor(1))["sh.sayagain/status"]).toBe("held");
    await h.finish();
  });

  it("resolves done with 1 and logs when the upstream cannot be started", async () => {
    const h = harness({}, { command: "no-such-binary-sayagain-test" });
    expect(await h.wrapped.done).toBe(1);
    expect(h.logs.join("\n")).toContain("cannot run upstream");
  });

  it("answers pending calls with a dead-letter error when the upstream exits, and stops signal listeners", async () => {
    const before = process.listenerCount("SIGINT");
    const h = harness();
    await h.handshake();
    h.call(1, "slow_write", { delayMs: 5000 });
    await sleep(50);
    h.wrapped.kill();
    const err = await h.waitFor(1);
    expect((err.error as { data: Record<string, unknown> }).data["sh.sayagain/status"]).toBe(
      "dead-lettered",
    );
    await h.wrapped.done;
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(h.wrapped.deadLetters.list()).toHaveLength(1);
  });

  it("exports a span per call and flushes the last one before done resolves", async () => {
    const bodies: { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }[] = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const otlp = new OtlpExporter({
      endpoint: "http://collector/v1/traces",
      fetch: fakeFetch,
      flushMs: 10_000,
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    let buf = "";
    output.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    const wrapped = wrap({
      command: process.execPath,
      args: [fixture],
      input,
      output,
      ledger: new MemoryLedger(),
      control: false,
      otlp,
      log: () => {},
    });
    const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { a: 1 } },
    });
    for (let i = 0; i < 200 && !lines.some((l) => l.includes('"id":2')); i++)
      await new Promise((r) => setTimeout(r, 25));
    input.end();
    expect(await wrapped.done).toBe(0);
    const spans = bodies.flatMap((b) =>
      b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((x) => x.spans)),
    );
    expect(spans.map((s) => s.name)).toEqual(["tools/call echo"]);
  });

  it("offers an advise-mode coercion only as a repair after a failure, on a tool whose schema cannot repair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sayagain-wrap-advise-"));
    const path = join(dir, "learned.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-09-05T00:00:00Z",
        interventions: [
          {
            id: "coerce:fake/loose/limit:string-number",
            kind: "coerce",
            server: "upstream",
            tool: "loose",
            signature: "x",
            signatures: ["x"],
            errorClass: "coercible",
            path: "/limit",
            from: "string",
            to: "number",
            rule: "string-to-number",
            evidence: 3,
            learnedAt: "2026-09-05T00:00:00Z",
            activatedAt: "2026-09-05T00:00:00Z",
            state: "active",
            // no mode: a 0.8.0 file, which loads as advise
          },
        ],
      }),
    );
    const store = new LearnedStore(path);
    expect(store.get("coerce:fake/loose/limit:string-number")?.mode).toBe("advise");
    const h = harness({}, { learned: store });
    try {
      await h.handshake();
      h.call(1, "loose", { limit: "10" });
      const first = await h.waitFor(1);
      const meta = (first.result as Record<string, unknown>)._meta as Record<string, unknown>;
      expect(meta["sh.sayagain/status"]).toBe("repaired");
      expect(JSON.stringify(meta["sh.sayagain/repair"])).toContain(
        '"rule":"learned:string-to-number"',
      );
      await h.finish();
      // The call failed first: nothing changed before it left.
      expect(h.ledger.rows[0]).toMatchObject({
        attempts: 2,
        repairs: [{ path: "/limit", rule: "learned:string-to-number" }],
      });
    } finally {
      await h.finish();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("in the control arm forwards, records and does nothing else", async () => {
    const h = harness({ hold: "destructive" }, { arm: "control" });
    try {
      // The control arm's model reads nothing from the boundary: no announcement in instructions.
      expect(JSON.stringify(await h.handshake())).not.toContain("Say Again");
      // A coercible failure is not repaired: the upstream's error reaches the host as it was.
      h.call(1, "strict", { limit: "10" });
      const failed = await h.waitFor(1);
      expect(JSON.stringify(failed)).toContain("Invalid params: limit must be a number");
      expect(meta(failed)["sh.sayagain/status"]).toBe("executed");
      expect(JSON.stringify(failed)).not.toContain("Say Again");
      // A retryable failure on a read-only tool is not retried.
      h.call(2, "flaky", { failTimes: 1 });
      const timedOut = await h.waitFor(2);
      expect(JSON.stringify(timedOut)).toContain("Request timed out");
      // A destructive tool is not held.
      h.call(3, "delete_page", { id: "p1" });
      expect(meta(await h.waitFor(3))["sh.sayagain/status"]).toBe("executed");
      // Two identical writes are both executed: no dedupe.
      h.call(4, "create_page", { title: "same" });
      h.call(5, "create_page", { title: "same" });
      expect(meta(await h.waitFor(4))["sh.sayagain/status"]).toBe("executed");
      expect(meta(await h.waitFor(5))["sh.sayagain/status"]).toBe("executed");
      await h.finish();
      const rows = h.ledger.rows;
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.arm === "control")).toBe(true);
      expect(rows.map((r) => r.status)).toEqual([
        "executed",
        "executed",
        "executed",
        "executed",
        "executed",
      ]);
      expect(rows[0]).toMatchObject({ tool: "strict", isError: true, errorClass: "coercible" });
      expect(rows[0]?.attempts).toBeUndefined();
      expect(rows[0]?.repairs).toBeUndefined();
      expect(rows[1]).toMatchObject({ tool: "flaky", isError: true, errorClass: "retryable" });
      expect(rows[2]?.held).toBeUndefined();
      expect(h.logs.some((l) => l.includes("runs in the control arm"))).toBe(true);
    } finally {
      await h.finish();
    }
  });

  it("in the treatment arm behaves as shipped and stamps the arm on every row", async () => {
    const h = harness({ hold: "destructive" }, { arm: "treatment" });
    try {
      expect(JSON.stringify(await h.handshake())).toContain("Say Again"); // the announcement, as shipped
      h.call(1, "strict", { limit: "10" });
      expect(meta(await h.waitFor(1))["sh.sayagain/status"]).toBe("repaired");
      await h.finish();
      expect(h.ledger.rows[0]).toMatchObject({ arm: "treatment", status: "repaired" });
    } finally {
      await h.finish();
    }
  });

  it("applies a learned coercion from learned.json and notices when the file changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sayagain-wrap-learned-"));
    const path = join(dir, "learned.json");
    const intervention = {
      id: "coerce:fake/strict/limit:string-number",
      kind: "coerce",
      mode: "apply",
      server: "upstream",
      tool: "strict",
      signature: "x",
      signatures: ["x"],
      errorClass: "coercible",
      path: "/limit",
      from: "string",
      to: "number",
      rule: "string-to-number",
      evidence: 3,
      learnedAt: "2026-09-05T00:00:00Z",
      activatedAt: "2026-09-05T00:00:00Z",
      state: "active",
    };
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-09-05T00:00:00Z",
        interventions: [intervention],
      }),
    );
    const store = new LearnedStore(path);
    const h = harness({}, { learned: store });
    try {
      await h.handshake();
      h.call(1, "strict", { limit: "10" });
      const first = await h.waitFor(1);
      const firstMeta = (first.result as Record<string, unknown>)._meta as Record<string, unknown>;
      expect(firstMeta["sh.sayagain/status"]).toBe("repaired");
      expect(JSON.stringify(firstMeta["sh.sayagain/repair"])).toContain(
        '"rule":"learned:string-to-number"',
      );
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          updatedAt: "2026-09-05T00:00:01Z",
          interventions: [{ ...intervention, state: "disabled" }],
        }),
      );
      store.maybeReload(0);
      h.call(2, "strict", { limit: "10" });
      const second = await h.waitFor(2);
      const meta = (second.result as Record<string, unknown>)._meta as Record<string, unknown>;
      expect(meta["sh.sayagain/status"]).toBe("repaired"); // the schema repair, after a failure this time
      expect(JSON.stringify(meta["sh.sayagain/repair"])).toContain('"rule":"string-to-number"');
    } finally {
      await h.finish();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
