import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { LedgerRow } from "./ledger.js";
import {
  localCollectorListening,
  OtlpExporter,
  otlpEndpointFromEnv,
  otlpHeadersFromEnv,
  resolveOtlpEndpoint,
  spanAttributes,
} from "./otlp.js";

const row: LedgerRow = {
  receipt: "rcpt_1",
  ts: "2026-09-05T00:00:00.000Z",
  upstream: "notion",
  method: "tools/call",
  tool: "create_page",
  toolClass: "write",
  argShape: ["title:string"],
  argsHash: "h",
  hasIntent: true,
  task: "t1",
  session: "s1",
  status: "dead-lettered",
  isError: true,
  errorClass: "retryable",
  errorSignature: "Request timed out after <n> ms",
  latencyMs: 250,
  requestBytes: 10,
  responseBytes: 20,
  attempts: 3,
  held: { reason: "r", mode: "unknown-outcome", decision: "reject", waitedMs: 5 },
};

describe("otlp", () => {
  it("builds ADR-0007 attributes, hashing the signature unless opted in", () => {
    const attrs = Object.fromEntries(spanAttributes(row).map((a) => [a.key, a.value]));
    expect(attrs["gen_ai.tool.name"]).toEqual({ stringValue: "create_page" });
    expect(attrs["sayagain.status"]).toEqual({ stringValue: "dead-lettered" });
    expect(attrs["sayagain.error.class"]).toEqual({ stringValue: "retryable" });
    expect(attrs["sayagain.error.signature_hash"]).toMatchObject({
      stringValue: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(attrs["sayagain.error.signature"]).toBeUndefined();
    expect(attrs["sayagain.held.decision"]).toEqual({ stringValue: "reject" });
    expect(attrs["sayagain.attempts"]).toEqual({ intValue: "3" });
    expect(attrs["sayagain.args.shape"]).toEqual({
      arrayValue: { values: [{ stringValue: "title:string" }] },
    });
    const plain = Object.fromEntries(
      spanAttributes(row, { signatures: true }).map((a) => [a.key, a.value]),
    );
    expect(plain["sayagain.error.signature"]).toEqual({
      stringValue: "Request timed out after <n> ms",
    });
  });

  it("posts batched OTLP/HTTP JSON to a collector and keeps going after a failure", async () => {
    const bodies: unknown[] = [];
    let fail = true;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        if (fail) {
          fail = false;
          res.writeHead(503);
          return res.end();
        }
        bodies.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const logs: string[] = [];
    const exporter = new OtlpExporter({
      endpoint: `http://127.0.0.1:${port}/v1/traces`,
      headers: { authorization: "Basic x" },
      version: "t",
      batchSize: 2,
      log: (l) => logs.push(l),
    });
    exporter.record(row);
    exporter.record({
      ...row,
      receipt: "rcpt_2",
      isError: false,
      status: "executed",
      held: undefined as never,
    });
    await new Promise((r) => setTimeout(r, 50));
    exporter.record({ ...row, receipt: "rcpt_3" });
    await exporter.close();
    expect(logs.some((l) => l.includes("HTTP 503"))).toBe(true);
    expect(bodies).toHaveLength(1);
    const spans =
      (
        bodies[0] as {
          resourceSpans: {
            scopeSpans: {
              spans: {
                name: string;
                status: { code: number };
                traceId: string;
                events: { name: string }[];
              }[];
            }[];
          }[];
        }
      ).resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans.map((s) => s.name)).toEqual(["tools/call create_page"]);
    expect(spans[0]?.status.code).toBe(2);
    expect(spans[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0]?.events.map((e) => e.name)).toEqual(["hold.reject", "dead-letter"]);
    expect(await localCollectorListening(port)).toBe(true);
    server.close();
    expect(await localCollectorListening(port)).toBe(false);
  });

  it("resolves the endpoint from options and the environment", async () => {
    expect(otlpEndpointFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/" })).toBe(
      "http://c:4318/v1/traces",
    );
    expect(otlpEndpointFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/x" })).toBe(
      "http://c/x",
    );
    expect(otlpEndpointFromEnv({})).toBeUndefined();
    expect(otlpHeadersFromEnv({ OTEL_EXPORTER_OTLP_HEADERS: "a=1, b=x%20y" })).toEqual({
      a: "1",
      b: "x y",
    });
    expect(
      await resolveOtlpEndpoint("off", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" }),
    ).toBeUndefined();
    expect(await resolveOtlpEndpoint("http://e/v1/traces", {})).toBe("http://e/v1/traces");
    expect(await resolveOtlpEndpoint(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" })).toBe(
      "http://c/v1/traces",
    );
  });
});
