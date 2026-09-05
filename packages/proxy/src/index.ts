/**
 * @sayagain/proxy — the commitment boundary for MCP tool calls.
 * 0.2: wrap with classification, DISREGARD dedupe, STANDBY holds, JSONL ledger.
 */
export { classify, META, PROWORD, REPAIR_BUDGET } from "@sayagain/sdk";
export type { BoundaryOptions, BoundaryState, PendingCall, Rewrite } from "./boundary.js";
export {
  ANNOUNCEMENT,
  BOUNDARY_NAME,
  baseRow,
  createState,
  describeCall,
  duplicateResponse,
  hashArgs,
  heldResponse,
  newReceipt,
  observeClientMessage,
  registerPending,
  rewriteServerMessage,
  shapeOf,
} from "./boundary.js";
export type { ControlRequest, ControlResponse, HoldSummary } from "./control.js";
export {
  ask,
  decideEverywhere,
  listAllHolds,
  liveSockets,
  socketPathFor,
  startControlServer,
} from "./control.js";
export { DedupeCache } from "./dedupe.js";
export type { Decision, Hold } from "./holds.js";
export { HoldQueue } from "./holds.js";
export type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
export { isRequest, isResponse, LineSplitter, parseMessage } from "./jsonrpc.js";
export type { Ledger, LedgerRow } from "./ledger.js";
export { defaultLedgerPath, JsonlLedger, MemoryLedger, readLedger } from "./ledger.js";
export type { HoldMode, PolicyOptions } from "./policy.js";
export { DEFAULT_POLICY, parseClassOverrides, shouldHold, ToolClassifier } from "./policy.js";
export { resultText, signatureOf } from "./signature.js";
export { PROXY_VERSION } from "./version.js";
export type { WrapOptions, Wrapped } from "./wrap.js";
export { wrap } from "./wrap.js";
