/** Transports the boundary core talks through. A Session is a connected host; an Upstream is the real server. */
import type { JsonRpcMessage } from "./jsonrpc.js";

export interface Session {
  /** Stable within the boundary's lifetime. */
  id: string;
  /** Deliver one message to this host. */
  send(msg: JsonRpcMessage): void;
}

export interface Upstream {
  /** Send one newline-terminated JSON-RPC line. Returns false when the upstream cannot take it. */
  send(line: string): boolean;
  readonly ready: boolean;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (reason: string, code: number | null) => void): void;
  start(): Promise<void>;
  stop(): void;
}
