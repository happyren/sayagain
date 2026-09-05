/** Minimal JSON-RPC 2.0 helpers for newline-delimited MCP stdio framing. */
import { StringDecoder } from "node:string_decoder";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseMessage(line: string): JsonRpcMessage | JsonRpcMessage[] | null {
  try {
    const v: unknown = JSON.parse(line);
    if (isObject(v) || Array.isArray(v)) return v as JsonRpcMessage | JsonRpcMessage[];
    return null;
  } catch {
    return null;
  }
}

export function isRequest(m: unknown): m is JsonRpcRequest {
  return isObject(m) && typeof m.method === "string" && m.id !== undefined && m.id !== null;
}

export function isResponse(m: unknown): m is JsonRpcResponse {
  return (
    isObject(m) &&
    m.method === undefined &&
    m.id !== undefined &&
    (m.result !== undefined || m.error !== undefined)
  );
}

/** Splits a byte stream into complete lines; keeps the partial tail and never splits a multi-byte character. */
export class LineSplitter {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  push(chunk: string | Buffer): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      lines.push(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
    }
    return lines;
  }

  flush(): string | null {
    const rest = this.buffer + this.decoder.end();
    this.buffer = "";
    return rest.length ? rest : null;
  }
}
