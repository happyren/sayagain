/**
 * @sayagain/proxy — the commitment boundary for MCP tool calls.
 * 0.1: `wrap` around one stdio server with receipts and a JSONL ledger.
 */
export { classify, META, PROWORD, REPAIR_BUDGET } from "@sayagain/sdk";
export type { BoundaryOptions, BoundaryState, PendingCall, Rewrite } from "./boundary.js";
export {
  ANNOUNCEMENT,
  BOUNDARY_NAME,
  createState,
  hashArgs,
  newReceipt,
  observeClientMessage,
  rewriteServerMessage,
  shapeOf,
} from "./boundary.js";
export type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
export { isRequest, isResponse, LineSplitter, parseMessage } from "./jsonrpc.js";
export type { Ledger, LedgerRow } from "./ledger.js";
export { defaultLedgerPath, JsonlLedger, MemoryLedger, readLedger } from "./ledger.js";
export { resultText, signatureOf } from "./signature.js";
export { PROXY_VERSION } from "./version.js";
export type { WrapOptions, Wrapped } from "./wrap.js";
export { wrap } from "./wrap.js";
