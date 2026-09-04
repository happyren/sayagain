/**
 * @sayagain/proxy — Layer 0 and Layer 1 of the commitment boundary.
 * Nothing here is usable yet; the public surface below is the contract the
 * implementation will fill in. See docs/adr/0003 and 0004.
 */
import type { ToolClass } from "@sayagain/sdk";

export { classify, META, PROWORD, REPAIR_BUDGET } from "@sayagain/sdk";

export const PROXY_VERSION = "0.0.0";

export interface ProxyOptions {
  /** Upstream MCP server: a URL for HTTP transport or a command for stdio. */
  upstream: string | { command: string; args?: string[] };
  /** Ledger and dead-letter queue: a sqlite:// path (default) or a postgres:// URL. */
  ledger?: string;
  /** Operator overrides for tool classification, keyed by tool name. */
  toolClasses?: Record<string, ToolClass>;
  /** Enable the schema shim for non-read-only tools (spec section 7). */
  shim?: boolean;
}

export function createProxy(_options: ProxyOptions): never {
  throw new Error("@sayagain/proxy is pre-alpha: createProxy is not implemented yet");
}
