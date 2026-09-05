/** The two ends of the boundary: hosts attach as sessions; the upstream is what the boundary talks to. */
import type { JsonRpcMessage } from "./jsonrpc.js";

export interface Session {
  id: string;
  send(msg: JsonRpcMessage): void;
  /**
   * Can this session carry messages the upstream initiates (requests, notifications)?
   * A stdio host can; a one-shot HTTP POST cannot. Undefined means yes.
   */
  readonly bidirectional?: boolean;
  /** A one-shot session (one HTTP request): its id says nothing about the host, so rows do not carry it. */
  readonly ephemeral?: boolean;
}

export interface Upstream {
  /** Queue one newline-terminated JSON-RPC line. Returns false when the upstream cannot take it. */
  send(line: string): boolean;
  readonly ready: boolean;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (reason: string, code: number | null) => void): void;
  start(): Promise<void>;
  stop(): void;
}
