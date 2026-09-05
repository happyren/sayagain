/**
 * @sayagain/proxy — the commitment boundary for MCP tool calls.
 * 0.3: wrap with classification, DISREGARD dedupe, STANDBY holds, bounded
 * retry, deterministic repair, dead-letter and replay, error rewriting.
 */
export { classify, META, PROWORD, REPAIR_BUDGET } from "@sayagain/sdk";
export type { BoundaryOptions, BoundaryState, Failure, PendingCall, Rewrite } from "./boundary.js";
export {
  ANNOUNCEMENT,
  BOUNDARY_NAME,
  baseRow,
  createState,
  describeCall,
  duplicateResponse,
  failureOf,
  hashArgs,
  heldResponse,
  newReceipt,
  observeClientMessage,
  ownToolsListRequest,
  pendingFor,
  registerPending,
  rewriteServerMessage,
  shapeOf,
  withArguments,
} from "./boundary.js";
export type {
  ControlRequest,
  ControlResponse,
  DeadLetterSummary,
  HoldSummary,
  ReplayOutcome,
} from "./control.js";
export {
  ask,
  decideEverywhere,
  listAllDeadLetters,
  listAllHolds,
  liveSockets,
  replayEverywhere,
  socketPathFor,
  startControlServer,
} from "./control.js";
export type { DeadLetter } from "./deadletter.js";
export { DeadLetterStore, defaultDeadLetterPath, readDeadLetters } from "./deadletter.js";
export { DedupeCache } from "./dedupe.js";
export type { ErrorClass } from "./errors.js";
export { classifyError, guidanceFor } from "./errors.js";
export type { Decision, Hold } from "./holds.js";
export { HoldQueue } from "./holds.js";
export type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
export { isRequest, isResponse, LineSplitter, parseMessage } from "./jsonrpc.js";
export type { Ledger, LedgerRow } from "./ledger.js";
export { defaultLedgerPath, JsonlLedger, MemoryLedger, readLedger } from "./ledger.js";
export type { HoldMode, PolicyOptions } from "./policy.js";
export { DEFAULT_POLICY, parseClassOverrides, shouldHold, ToolClassifier } from "./policy.js";
export type { RepairChange, RepairResult } from "./repair.js";
export { repairArguments } from "./repair.js";
export { resultText, signatureOf } from "./signature.js";
export { PROXY_VERSION } from "./version.js";
export type { WrapOptions, Wrapped } from "./wrap.js";
export { wrap } from "./wrap.js";
