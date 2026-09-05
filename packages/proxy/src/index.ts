/**
 * @sayagain/proxy — the commitment boundary for MCP tool calls.
 * 0.3: wrap with classification, DISREGARD dedupe, STANDBY holds, bounded
 * retry, deterministic repair, dead-letter and replay, error rewriting.
 */
export { classify, META, PROWORD, REPAIR_BUDGET } from "@sayagain/sdk";
export {
  type AnalysisOptions,
  parseSince,
  type Recovery,
  type Report,
  recoveries,
  report,
  type SignatureStats,
  selectRows,
  shapeDiff,
  signatureStats,
  type ToolStats,
  toolStats,
} from "./analysis.js";
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
export {
  allDeadLetters,
  allHolds,
  daemonStatus,
  decideAnywhere,
  liveDaemon,
  replayAnywhere,
  stopDaemon,
} from "./client-api.js";
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
export type { BoundaryCoreOptions } from "./core.js";
export { Boundary } from "./core.js";
export type { Daemon, DaemonOptions } from "./daemon.js";
export { startDaemon } from "./daemon.js";
export type { DeadLetter } from "./deadletter.js";
export { DeadLetterStore, defaultDeadLetterPath, readDeadLetters } from "./deadletter.js";
export { DedupeCache } from "./dedupe.js";
export type { ErrorClass } from "./errors.js";
export { classifyError, guidanceFor } from "./errors.js";
export type { Decision, Hold } from "./holds.js";
export { HoldQueue } from "./holds.js";
export { ensureHome, homePath, sayagainHome } from "./home.js";
export type { HostFile, HostId, HostSpec, Scope } from "./hosts.js";
export { HOST_IDS, HOSTS, hostFiles, isHostId } from "./hosts.js";
export { detectIndent, parseJsonc, stripJsonc } from "./jsonc.js";
export type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
export { isRequest, isResponse, LineSplitter, parseMessage } from "./jsonrpc.js";
export type { Ledger, LedgerRow } from "./ledger.js";
export { defaultLedgerPath, JsonlLedger, MemoryLedger, readLedger } from "./ledger.js";
export type { EjectResult, HostEntry, ImportResult, InstallResult, Target } from "./onboarding.js";
export {
  boundaryEntry,
  configFromEntry,
  ejectHost,
  importHost,
  inspectHost,
  installHost,
  isBoundaryEntry,
} from "./onboarding.js";
export {
  localCollectorListening,
  OtlpExporter,
  type OtlpOptions,
  otlpEndpointFromEnv,
  otlpHeadersFromEnv,
  resolveOtlpEndpoint,
  spanAttributes,
} from "./otlp.js";
export type { HoldMode, PolicyOptions } from "./policy.js";
export { DEFAULT_POLICY, parseClassOverrides, shouldHold, ToolClassifier } from "./policy.js";
export type { DaemonInfo, Registry, ServerConfig } from "./registry.js";
export {
  addServer,
  loadRegistry,
  readDaemonInfo,
  registryPath,
  removeServer,
  resolveEnv,
  saveRegistry,
  upstreamFor,
} from "./registry.js";
export type { RepairChange, RepairResult } from "./repair.js";
export { repairArguments } from "./repair.js";
export { daemonHealthy, ensureDaemon, runStdioShim } from "./shim.js";
export { resultText, signatureOf } from "./signature.js";
export type { DeadLetters, HoldPersistence, Stores } from "./stores.js";
export { defaultSqlitePath, openStores } from "./stores.js";
export type { Session, Upstream } from "./transport.js";
export { HttpUpstream } from "./upstream-http.js";
export { StdioUpstream } from "./upstream-stdio.js";
export { PROXY_VERSION } from "./version.js";
export type { WrapOptions, Wrapped } from "./wrap.js";
export { wrap } from "./wrap.js";
