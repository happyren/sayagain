#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { grade, lintTool, type ToolDefinition } from "@sayagain/lint";
import {
  type ArmDiff as AbDiff,
  type AbReport,
  abReport,
  report as buildReport,
  parseSince,
  type Report,
  selectRows,
  signatureStats,
  toolStats,
} from "./analysis.js";
import { renderAuditHtml, renderAuditText, runAudit } from "./audit.js";
import { type ArmMode, isArmMode } from "./boundary.js";
import {
  type ClassReport,
  classReport,
  type Direction,
  declaredTools,
  describeAnnotations,
  overridesFrom,
  suggestionsOf,
} from "./classes.js";
import {
  allDeadLetters,
  allHolds,
  daemonLearn,
  daemonLearnReport,
  daemonLedger,
  daemonLedgerSince,
  daemonReloadPolicy,
  daemonStatus,
  daemonToolsList,
  decideAnywhere,
  liveDaemon,
  replayAnywhere,
  stopDaemon,
} from "./client-api.js";
import {
  assertShapeDocumentSafe,
  buildShapeDocument,
  checkEndpoint,
  contributeSettings,
  forgetContributor,
  sendContribution,
  summarizeDocument,
  TERMS_VERSION,
  writeContribution,
} from "./contribute.js";
import { startDaemon } from "./daemon.js";
import { defaultDeadLetterPath, readDeadLetters } from "./deadletter.js";
import {
  type DoctorHold,
  type DoctorServer,
  doctorFindings,
  type Finding,
  renderDoctor,
} from "./doctor.js";
import { homePath } from "./home.js";
import {
  HOST_IDS,
  HOSTS,
  type HostId,
  hostFiles,
  isHostId,
  type Scope,
  type Target,
} from "./hosts.js";
import { ensureLauncher, launcherCaveat } from "./launcher.js";
import { type Intervention, LearnedStore, upstreamReport } from "./learned.js";
import { defaultLedgerPath, JsonlLedger, type LedgerRow, readLedger } from "./ledger.js";
import { ejectHost, importHost, inspectHost, installHost } from "./onboarding.js";
import { OtlpExporter, otlpHeadersFromEnv, resolveOtlpEndpoint } from "./otlp.js";
import { parseClassOverrides } from "./policy.js";
import {
  addServer,
  daemonBaseUrl,
  isValidServerName,
  loadOrCreateToken,
  loadRegistry,
  readDaemonInfo,
  registryPath,
  removeDaemonInfo,
  removeServer,
  type ServerConfig,
  saveRegistry,
  tokenPath,
  unresolvedRefs,
} from "./registry.js";
import { renderRegistryScan, scanRegistry } from "./registry-scan.js";
import { buildIndex, fixesText, renderIndexSite } from "./reliability-index.js";
import { daemonHealthy, ensureDaemon, runStdioShim, serveArgv, waitForDaemon } from "./shim.js";
import { defaultSqlitePath, openStores, type StoreKind } from "./stores.js";
import {
  isTranscriptSource,
  type RowExtra,
  scanTranscripts,
  sessionRows,
  TRANSCRIPT_SOURCES,
  type TranscriptSource,
} from "./transcripts.js";
import { PROXY_VERSION } from "./version.js";
import { wrap } from "./wrap.js";

const USAGE = `sayagain ${PROXY_VERSION}

  sayagain wrap [options] -- <server command> [args...]
      Run the boundary in-process around one stdio MCP server.
      --ledger <path>          JSONL ledger (default ~/.sayagain/ledger.jsonl)
      --deadletter <path>      dead-letter file (default ~/.sayagain/deadletter.jsonl)
      --name <upstream>        upstream name until initialize reveals it
      --no-announce            do not append the boundary sentence to instructions
      --hold destructive|always|never   which calls are held before leaving (default destructive)
      --hold-wait <ms>         how long a held call waits for a decision (default 120000)
      --class <tool>=<class>   override a tool's class (read-only, idempotent-write, write, destructive); repeatable
      --dedupe-window <ms>     retention for idempotency keys and write fingerprints (default 30000)
      --retry <n>              attempts for retryable failures on safe tools (default 3; 1 disables)
      --no-repair              disable deterministic argument repair
      --no-rewrite-errors      do not append guidance to failures
      --otlp <url>|off         export one span per call (default: $OTEL_EXPORTER_OTLP_ENDPOINT, else a local collector on :4318; serve remembers it in config.json; SAYAGAIN_OTLP=off disables machine-wide)
      --no-learn               ignore ~/.sayagain/learned.json (the loop's coercions and hints)
      --arm control|treatment|coinflip|daily   the A/B arm for this process (docs/measurement.md 5.4; daily follows the calendar)
  sayagain serve [--listen 127.0.0.1:7777] [--store jsonl|sqlite] [--db <path>] [--otlp <url>|off] [--arm <mode>] [--detach]
      Run the daemon: one virtual server per registered upstream at /mcp/<name>, plus the control API.
      The bearer token is in ~/.sayagain/token. SAYAGAIN_HOME moves every file elsewhere.
      --arm control|treatment|coinflip|daily|off runs the A/B protocol: control forwards and records only (no
      hold, dedupe, retry, repair, learned coercion, hint, guidance, augmented descriptions or announcement);
      treatment is the boundary as shipped; coinflip assigns each host session; daily gives every session of a
      UTC day the same arm and follows the calendar. Persists in config.json until --arm off.
  sayagain add <name> [--url <url>] [--header k=v]... [--env K[=V]]... [--cwd <dir>] [--class t=c]... [--hold m] [-- <command> [args...]]
      Register an upstream (stdio command, or --url for Streamable HTTP). --env K alone stores "\${K}",
      resolved from the daemon's environment at spawn; so does a \${VAR} inside --header or --env values.
  sayagain remove <name> | sayagain list | sayagain status | sayagain stop
  sayagain ui [--no-open]
      Open the operator page (holds inbox, servers, dead letters, ledger, tools, errors, report); starts the daemon if needed.
  sayagain doctor [--no-probe] [--json]
      Check the whole setup and print the command that fixes each finding: servers a host still calls
      directly, a server configured in one project only, a stdio server the daemon starts without the
      working directory its host gave it, a reference the daemon's environment does not define, tools
      whose class comes from nothing, calls waiting for a decision, and traffic that never arrives.
      Findings come most serious first, and the command exits 1 when something is broken.
      --no-probe leaves the upstreams unstarted, so the class checks are skipped and the run is fast.
  sayagain classes <name>|--all [--suggest] [--write [--lower]] [--json]
      What class each tool gets and where it came from (the operator's table, the server's annotations,
      or the cautious fallback), and what the boundary does with it. --suggest adds the class the tool's
      name implies where it differs. --write stores the suggestions that raise a class; a suggestion
      that lowers one drops a hold, so it needs --write --lower. A running daemon applies a written
      table without a restart. One tool at a time: sayagain add <name> --class <tool>=<class>
  sayagain hosts [--project] [--json]
      Which MCP hosts are configured on this machine (Claude Code, Cursor, Claude Desktop, VS Code) and what they hold.
  sayagain import --host <id>|all [--rewrite] [--dry-run] [--force] [--project] [--file <path>] [--transport stdio|http] [--command <path>] [--no-start]
      Register the host's servers; with --rewrite, point the host's entries at Say Again (same keys; backups in ~/.sayagain/backups)
      and start the daemon from this shell. Entries point at ~/.sayagain/bin/sayagain, a launcher every command refreshes.
  sayagain install --host <id>|all [--project] [--file <path>] [--dry-run] [--transport stdio|http] [--command <path>] [--no-start] [name...]
      Write entries for registered servers into a host's file.
  sayagain eject --host <id>|all [--project] [--file <path>] [--dry-run] [--keep] [--prune] [name...]
      Restore the host's original entries and forget the servers that import registered (--keep keeps them; --prune also removes
      Say Again entries whose server is no longer registered).
  sayagain stdio <name>
      Thin stdio client for hosts that only spawn commands; starts the daemon if needed.
  sayagain tools [--since 7d] [--server <name>] [--min-calls 10] [--ledger <path>] [--json]
      Tools ranked by the waste their failures cause: failure and mis-call rates, identical retries, calls to recover, latency.
  sayagain errors [<tool>] [--since 7d] [--server <name>] [--ledger <path>] [--json]
      Error signatures with counts, class, first and last seen, calls to recover, the usual recovery path and shape change.
  sayagain report [--since 7d | --weekly] [--server <name>] [--ledger <path>] [--json]
      The weekly page from docs/measurement.md section 6, from the ledger alone, with the previous window for comparison.
      --server takes the registry name or the upstream's own name. Rows come from the running daemon, else the store.
  sayagain report --ab [--since 30d] [--json]
      The A/B protocol's page (docs/measurement.md 5.4): both arms side by side, then the differences with 95%
      intervals, risk first (unacknowledged writes per 1K writes, the failure tax in bytes per call, the failure
      rate), and the verdict against the pre-registered minimum of two weeks or 2,000 calls per arm, whichever
      is later. Rows without an arm (calls outside the experiment) are counted and left out.
  sayagain learn [--update] [--min-evidence 3] [--json]
      What the loop has learned from your own ledger: coercions offered as repairs, facts appended to tool
      descriptions and errors; each with its before and after numbers, reverted by itself when it does not help.
  sayagain learn --disable <id> | --enable <id> | --apply <id> | --advise <id> | --report <server>
      Switch one intervention off or on. --apply <id> lets a coercion change read-only calls before they leave
      (by default the loop only advises: the hint, and the repair after a failure); --advise <id> switches it back.
      --report <server> prints a tool definition report. A wrap picks changes up within seconds.
  sayagain audit [--source claude-code|codex|cursor|all] [--dir <path>] [--project <name>] [--since 30d]
                 [--min-calls 10] [--top 15] [--html <file>|--no-html] [--json]
      The one page from docs/measurement.md over your own transcripts (Claude Code, Codex, Cursor), risk first:
      unacknowledged writes, the failure tax in dollars, failures by server, duplicates, recovery, the tools most
      prone to mis-calls. Writes a shareable HTML page (names, counts and masked signatures; never arguments).
      --project <name> keeps one project's sessions (its directory name; worktrees included).
  sayagain contribute [--source ledger|claude-code|codex|cursor] [--dir <path>] [--ledger <path>] [--since 30d]
                      [--yes] [--accept-terms <version>] [--endpoint <url>] [--json]
      Build the contributed-shape document of ADR-0009 (tool names, counts, error classes, argument shapes,
      hashed signatures; nothing else), write it to ~/.sayagain/contributions, print it, and send it only after
      a y to the endpoint you name. No endpoint is configured yet: without one the command stops after writing.
      --json prints the document alone and never sends.
  sayagain contribute --status | --weekly on|off | --forget
      Show the contributor id and settings; let the daemon send weekly (endpoint and accepted terms required);
      rotate the id and ask the index to delete the old one's data.
  sayagain lint <name>|--all [--file <tools.json>] [--fail-below A|B|C|D] [--json]
      Grade a server's tool definitions with @sayagain/lint (starts the upstream through the daemon if needed).
  sayagain lint --registry [--sample <n> [--seed 20260905] | --first <n>] [--concurrency 8] [--timeout 10s]
                 [--out <file>] [--json] [--registry-url <url> [--allow-private]]
      Scan the public MCP registry (docs/measurement.md 5.5): ask every server with a Streamable HTTP remote for
      its tools without credentials, grade them, print the grade distribution and M16 (tools without documented
      parameter constraints) with the rule-set version. The page and --json name no server; the progress log on
      stderr does. --out writes every probed server (registry name, version, remote URL, outcome, status, error
      text) and every graded tool with its findings, all of it public registry data.
  sayagain index build --from <scan.json> [--contributions <dir>] [--out <dir>] [--base-url <url>]
      The Tool Reliability Index as a static site (ADR-0010): from the scan file that lint --registry --out
      wrote and the contributed shape documents in <dir> (your own copies; default ~/.sayagain/contributions),
      index.html, a page and a badge per graded server, a badge per tool, index.json, into --out (default
      ~/.sayagain/index). Public registry data and aggregates only; nothing is sent.
  sayagain index fixes <server> --from <scan.json> [--contributions <dir>] [--base-url <url>]
      The message for a maintainer: their score and the two changes that move it most. Printed, never sent.
  sayagain ledger [--ledger <path>] [--tail <n>] [--json]
  sayagain holds [--json]
  sayagain approve <receipt> | sayagain reject <receipt>
  sayagain deadletters [--json] [--deadletter <path>]
  sayagain replay <receipt> [--args '<json>']
      Re-send a dead-lettered call through the running boundary that holds it.
  sayagain --version | --help
`;

class UsageError extends Error {}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--"))
    throw new UsageError(`${name} expects a value`);
  args.splice(i, 2);
  return value;
}

/** A non-negative integer option, or a UsageError naming the flag. */
function takeNumber(args: string[], name: string): number | undefined {
  const raw = takeOption(args, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim()))
    throw new UsageError(`${name} expects a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function takeAll(args: string[], name: string): string[] {
  const out: string[] = [];
  let v = takeOption(args, name);
  while (v !== undefined) {
    out.push(v);
    v = takeOption(args, name);
  }
  return out;
}

function parseTranscriptSource(s: string): TranscriptSource {
  if (!isTranscriptSource(s))
    throw new UsageError(`--source expects claude-code, codex or cursor; got ${JSON.stringify(s)}`);
  return s;
}

function checkEndpointOrUsage(endpoint: string): void {
  try {
    checkEndpoint(endpoint);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

/** Is a Claude Code session running? It rewrites ~/.claude.json when it exits. */
function claudeCodeRunning(): boolean {
  if (process.platform === "win32") return false;
  try {
    return (
      execFileSync("pgrep", ["-x", "claude"], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim().length > 0
    );
  } catch {
    return false;
  }
}

/** Every ledger row since a time: an explicit file, else the daemon when live, else the configured store. */
async function loadRowsSince(since: Date, ledgerPath?: string): Promise<LedgerRow[]> {
  const after = (rows: LedgerRow[]) => rows.filter((r) => Date.parse(r.ts) >= since.getTime());
  if (ledgerPath) return after(readLedger(ledgerPath, {}));
  const fromDaemon = await daemonLedgerSince(since);
  if (fromDaemon) return fromDaemon;
  const registry = loadRegistry();
  if (registry.daemon?.store === "sqlite") {
    const sqlitePath =
      registry.daemon.db !== undefined ? resolve(registry.daemon.db) : defaultSqlitePath();
    if (!existsSync(sqlitePath)) return [];
    const stores = openStores("sqlite", { sqlitePath });
    const rows = stores.readLedger();
    stores.close();
    return after(rows);
  }
  return after(readLedger(defaultLedgerPath(), {}));
}

/** `--server` may be the registry name or the upstream's own name; rows carry both when the boundary knows them. */
const serverMatcher =
  (name: string) =>
  (r: LedgerRow): boolean =>
    r.upstream === name || r.server === name;

const kib = (n: number): string =>
  n < 1024 ? `${Math.round(n)} B` : `${(n / 1024).toFixed(1)} KiB`;
const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/** The A/B page: both arms side by side, then the differences with their intervals. */
/** One server's class table: what each tool gets, where it came from, and what that means. */
/** "1 tool" / "3 tools", so a count reads like a sentence. */
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function renderClasses(r: ClassReport, withSuggestions: boolean): string {
  const out: string[] = [];
  const counts = Object.entries(r.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  out.push(`${r.server}: ${plural(r.rows.length, "tool")}: ${counts || "none"}`);
  if (r.fallback)
    out.push(
      `  ${r.fallback} of them take the cautious fallback: the server declares nothing about them, so they are classed as writes.`,
    );
  out.push("");
  // The effect belongs to the class, not the row, so it is said once per class in use.
  for (const [cls, n] of Object.entries(r.counts))
    if (n > 0) {
      const row = r.rows.find((x) => x.toolClass === cls);
      if (row) out.push(`  ${cls.padEnd(17)} ${row.effect}`);
    }
  out.push("");
  const name = (t: string) => (t.length > 33 ? `${t.slice(0, 32)}\u2026` : t).padEnd(33);
  out.push(`  ${"tool".padEnd(33)} ${"class".padEnd(17)} ${"from".padEnd(10)} the server declares`);
  for (const row of r.rows) {
    out.push(
      `  ${name(row.tool)} ${row.toolClass.padEnd(17)} ${row.source.padEnd(10)} ${describeAnnotations(row.annotations)}`,
    );
    if (row.warning) out.push(`      ! ${row.warning}`);
    if (withSuggestions && row.suggestion)
      out.push(
        `      -> ${row.suggestion.toolClass} (${row.suggestion.direction}): ${row.suggestion.reason}`,
      );
  }
  if (withSuggestions && r.suggestions.length) {
    out.push("");
    out.push(
      `  ${plural(r.suggestions.length, "suggestion")}, each a guess from the tool's name: read them before writing.`,
    );
  }
  return `${out.join("\n")}\n`;
}

function renderAbReport(r: AbReport): string {
  const out: string[] = [];
  const c = r.arms.control;
  const t = r.arms.treatment;
  const line = (label: string, a: string | number, b: string | number) =>
    out.push(`  ${label.padEnd(30)} ${String(a).padStart(14)} ${String(b).padStart(14)}`);
  out.push(
    `Say Again A/B: ${when(r.window.since)} to ${when(r.window.until)} UTC (${r.window.days} days); target ${r.targetCallsPerArm} calls per arm (docs/measurement.md 5.4)`,
  );
  if (r.experiment.first && r.experiment.last)
    out.push(
      `Armed rows from ${when(r.experiment.first)} to ${when(r.experiment.last)} UTC (${r.experiment.days} days; minimum ${r.minimumDays} days or ${r.targetCallsPerArm} calls per arm, whichever is later)`,
    );
  out.push("");
  line("", "control", "treatment");
  line("calls", c.calls, t.calls);
  line("sessions (clusters)", c.sessions, t.sessions);
  line("writes", c.writes, t.writes);
  line(
    "failures (M1)",
    `${c.failures} (${c.failureRatePct}%)`,
    `${t.failures} (${t.failureRatePct}%)`,
  );
  line(
    "unacknowledged writes (M9)",
    `${c.unacknowledged} (${c.unacknowledgedPer1kWrites}/1K)`,
    `${t.unacknowledged} (${t.unacknowledgedPer1kWrites}/1K)`,
  );
  line("failure tax, bytes per call", c.recoveryBytesPerCall, t.recoveryBytesPerCall);
  line(
    "retried / identical (M2, M3)",
    `${c.recovery.retryRatePct}% / ${c.recovery.identicalRetryPct}%`,
    `${t.recovery.retryRatePct}% / ${t.recovery.identicalRetryPct}%`,
  );
  line("median calls to recover (M17)", c.recovery.medianCalls, t.recovery.medianCalls);
  line(
    "boundary: retried / repaired",
    `${c.boundary.retried} / ${c.boundary.repaired}`,
    `${t.boundary.retried} / ${t.boundary.repaired}`,
  );
  line(
    "boundary: held ok / rejected",
    `${c.boundary.held} / ${c.boundary.rejected}`,
    `${t.boundary.held} / ${t.boundary.rejected}`,
  );
  line(
    "boundary: dead-lettered / dedup",
    `${c.boundary.deadLettered} / ${c.boundary.deduplicated}`,
    `${t.boundary.deadLettered} / ${t.boundary.deduplicated}`,
  );
  out.push("");
  line(
    "failure tax = rate x cost",
    `${c.failureRatePct}% x ${r.taxFactors.control.bytesPerFailure}B`,
    `${t.failureRatePct}% x ${r.taxFactors.treatment.bytesPerFailure}B`,
  );
  out.push("");
  out.push("Differences, control minus treatment (95% interval; positive favours the boundary)");
  const d = r.differences;
  const show = (label: string, x: AbDiff, unit: string) => {
    const interval = x.low === null || x.high === null ? "not estimable" : `${x.low} to ${x.high}`;
    out.push(
      `  ${label.padEnd(30)} ${String(x.delta).padStart(8)} ${unit.padEnd(14)} ${interval.padEnd(20)} ${x.distinguishable ? "distinguishable from zero" : "not distinguishable"}`,
    );
  };
  // Risk first, then cost (ADR-0009 decision 2).
  show("unacknowledged (primary, risk)", d.unacknowledgedPer1kWrites, "per 1K writes");
  show("failure tax (primary, cost)", d.recoveryBytesPerCallRobust, "bytes/call");
  show("  the same, normal interval", d.recoveryBytesPerCall, "bytes/call");
  show("failure rate (secondary)", d.failureRatePct, "points");
  out.push("");
  if (r.rate.perArmPerDay !== null)
    out.push(
      `Filling at ${r.rate.perArmPerDay} calls per arm per day${
        r.rate.daysToTarget
          ? `; ${r.rate.targetDate ? `the target is met around ${when(r.rate.targetDate)}` : ""} (${r.rate.daysToTarget} days)`
          : "; the target is met"
      }`,
    );
  else out.push("Filling too briefly to project a rate yet (two days of armed calls are needed)");
  const p = r.power;
  const cut = (x: number | null) =>
    x === null ? "nothing short of elimination" : `a ${Math.round(100 * x)}% cut`;
  out.push(
    p.estimable
      ? `At ${p.callsPerArm} calls per arm, this much traffic can distinguish: unacknowledged writes ${cut(p.unacknowledgedCut)}, failure rate ${cut(p.failureRateCut)}, failure tax ${p.failureTaxBytes === null ? "not estimable" : `a change of ${p.failureTaxBytes} bytes per call`} (docs/measurement.md 5.4).`
      : "Too few control calls yet to say what this sample could distinguish (docs/measurement.md 5.4 carries the figures from the baseline).",
  );
  out.push("");
  out.push(`Verdict: ${r.verdict}`);
  if (r.outside) out.push(`Rows outside the experiment (no arm): ${r.outside}`);
  out.push("");
  return `${out.join("\n")}\n`;
}

/** The one page, in the order docs/measurement.md section 6 asks for. */
function renderReport(r: Report): string {
  const out: string[] = [];
  const was = (prev: string | undefined) => (prev === undefined ? "" : `  (was ${prev})`);
  const hours = (Date.parse(r.window.until) - Date.parse(r.window.since)) / 3_600_000;
  const span =
    r.window.days >= 1
      ? r.window.days === 1
        ? "1 day"
        : `${r.window.days} days`
      : `${Math.max(1, Math.round(hours))} hour${Math.round(hours) === 1 ? "" : "s"}`;
  const failures = r.byServer.reduce((a, s) => a + s.failures, 0);
  out.push(
    `Say Again report: ${when(r.window.since)} to ${when(r.window.until)} UTC (${span}), ${r.calls} calls, ${r.writes} writes`,
  );
  out.push("");
  out.push("North star (risk, then cost)");
  out.push(
    `  unacknowledged     ${r.northStar.unacknowledgedWritesPer1kWrites} writes per 1K writes without a known outcome (${r.unacknowledged.count})`,
  );
  out.push(
    `  failure tax        ${kib(r.northStar.failureTaxBytesPer1kCalls)} of recovery traffic per 1K calls${was(r.previous === undefined ? undefined : kib(r.previous.failureTaxBytesPer1kCalls))}`,
  );
  out.push("");
  out.push("Failures by server (M1 rate, M7 addressable share)");
  for (const s of r.byServer)
    out.push(
      `  ${s.server.padEnd(20)} ${String(s.calls).padStart(6)} calls  ${String(s.failureRatePct).padStart(5)}% fail  ${String(s.addressablePct).padStart(5)}% addressable  ${Object.entries(
        s.classes,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  if (!r.byServer.length) out.push("  (no calls)");
  out.push("");
  const named = (xs: { tool: string; count: number }[]) =>
    xs.length ? `  ${xs.map((t) => `${t.tool} ${t.count}`).join(", ")}` : "";
  out.push(
    `Duplicates (M8): ${r.duplicates.count} deduplicated, ${r.duplicates.per1kWrites} per 1K writes${named(r.duplicates.tools)}`,
  );
  out.push(`Unacknowledged writes (M9): ${r.unacknowledged.count}${named(r.unacknowledged.tools)}`);
  out.push("");
  out.push(
    `Recovery (M2, M3, M5, M17): ${r.recovery.failures} failures, ${r.recovery.recovered} recovered; retried ${r.recovery.retryRatePct}%, of which identical ${r.recovery.identicalRetryPct}%; median ${r.recovery.medianCalls} calls (mean ${r.recovery.meanCalls}), median ${kib(r.recovery.medianBytes)} (mean ${kib(r.recovery.meanBytes)})`,
  );
  out.push("");
  out.push("What the boundary did (M15)");
  const h = r.boundary.held;
  out.push(
    `  resolved by retry ${r.boundary.retriesResolved}, by repair ${r.boundary.repairsResolved}; held: approved ${h.approved}, rejected ${h.rejected}, undecided ${h.undecided}, cancelled ${h.cancelled}; dead-lettered ${r.boundary.deadLettered}; replays ${r.boundary.replays.count} (${r.boundary.replays.succeeded} succeeded); deduplicated ${r.boundary.deduplicated}; boundary-side failures ${r.boundary.infrastructure}`,
  );
  out.push("");
  out.push("Top signatures");
  for (const x of r.topSignatures)
    out.push(
      `  ${x.server}/${x.tool} x${x.count} ${x.errorClass}: ${x.signature}  (median ${x.medianCallsToRecover} calls to recover, ${x.unrecovered} unrecovered)`,
    );
  if (!r.topSignatures.length) out.push("  (no failures)");
  if (r.previous) {
    out.push("");
    out.push(
      `What moved vs the previous ${span}: calls ${r.previous.calls} -> ${r.calls}; failure rate ${r.previous.failureRatePct}% -> ${r.calls ? ((100 * failures) / r.calls).toFixed(1) : "0"}%; dead-lettered ${r.previous.deadLettered} -> ${r.boundary.deadLettered}`,
    );
  }
  out.push("");
  return `${out.join("\n")}\n`;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${PROXY_VERSION}\n`);
    return 0;
  }

  if (command === "wrap") {
    const sep = rest.indexOf("--");
    if (sep < 0 || sep === rest.length - 1)
      throw new UsageError("wrap: expected -- followed by the server command");
    const opts = rest.slice(0, sep);
    const [serverCommand, ...serverArgs] = rest.slice(sep + 1);
    if (!serverCommand) throw new UsageError("wrap: expected a server command");
    const ledgerPath = takeOption(opts, "--ledger") ?? defaultLedgerPath();
    const deadLetterPath = takeOption(opts, "--deadletter") ?? defaultDeadLetterPath();
    const upstreamName = takeOption(opts, "--name");
    const announce = !takeFlag(opts, "--no-announce");
    const hold = takeOption(opts, "--hold");
    const holdWait = takeNumber(opts, "--hold-wait");
    const dedupeWindow = takeNumber(opts, "--dedupe-window");
    const retry = takeNumber(opts, "--retry");
    const noRepair = takeFlag(opts, "--no-repair");
    const noRewrite = takeFlag(opts, "--no-rewrite-errors");
    const armOption = takeOption(opts, "--arm");
    if (armOption !== undefined && !isArmMode(armOption))
      throw new UsageError("wrap: --arm must be control, treatment, coinflip or daily");
    const wrapOtlp = takeOption(opts, "--otlp");
    const noLearn = takeFlag(opts, "--no-learn");
    const classes = parseClassOverrides(takeAll(opts, "--class"));
    if (opts.length) throw new UsageError(`wrap: unknown option ${opts[0]}`);
    if (hold !== undefined && hold !== "destructive" && hold !== "always" && hold !== "never")
      throw new UsageError("wrap: --hold must be destructive, always or never");
    const policy: NonNullable<Parameters<typeof wrap>[0]["policy"]> = { classes };
    if (hold !== undefined) policy.hold = hold;
    if (holdWait !== undefined) policy.holdWaitMs = holdWait;
    if (dedupeWindow !== undefined) policy.dedupeWindowMs = dedupeWindow;
    if (retry !== undefined) policy.retryAttempts = Math.max(1, retry);
    if (noRepair) policy.repair = false;
    if (noRewrite) policy.rewriteErrors = false;
    const wrapOptions: Parameters<typeof wrap>[0] = {
      command: serverCommand,
      args: serverArgs,
      ledger: new JsonlLedger(ledgerPath),
      ledgerKind: "jsonl",
      deadLetterPath,
      announce,
      policy,
    };
    if (upstreamName !== undefined) wrapOptions.upstreamName = upstreamName;
    const wrapOtlpEndpoint = await resolveOtlpEndpoint(wrapOtlp);
    if (noLearn) wrapOptions.learned = false;
    if (wrapOtlpEndpoint) {
      wrapOptions.otlp = new OtlpExporter({
        endpoint: wrapOtlpEndpoint,
        headers: otlpHeadersFromEnv(),
        version: PROXY_VERSION,
        log: (l) => process.stderr.write(`${l}\n`),
      });
      process.stderr.write(`sayagain: exporting spans to ${wrapOtlpEndpoint}\n`);
    }
    if (armOption) wrapOptions.arm = armOption as ArmMode;
    const { done } = wrap(wrapOptions);
    return done;
  }

  if (command === "serve") {
    const opts = [...rest];
    const listen = takeOption(opts, "--listen");
    const store = takeOption(opts, "--store");
    const db = takeOption(opts, "--db");
    const otlpOption = takeOption(opts, "--otlp");
    const armOption = takeOption(opts, "--arm");
    if (armOption !== undefined && armOption !== "off" && !isArmMode(armOption))
      throw new UsageError("serve: --arm must be control, treatment, coinflip, daily or off");
    const detach = takeFlag(opts, "--detach");
    if (opts.length) throw new UsageError(`serve: unknown option ${opts[0]}`);
    if (store !== undefined && store !== "jsonl" && store !== "sqlite")
      throw new UsageError("serve: --store must be jsonl or sqlite");
    const registry = loadRegistry();
    const running = readDaemonInfo();
    if (running && running.pid !== process.pid) {
      if (await daemonHealthy(running))
        throw new UsageError(
          `a daemon is already running (pid ${running.pid}, ${running.host}:${running.port}); use sayagain stop first`,
        );
      removeDaemonInfo(running.pid); // stale: crashed, killed, or a reboot
    }
    if (detach) {
      const { file, args } = serveArgv([
        ...(listen ? ["--listen", listen] : []),
        ...(store ? ["--store", store] : []),
        ...(db ? ["--db", db] : []),
        ...(otlpOption ? ["--otlp", otlpOption] : []),
        ...(armOption ? ["--arm", armOption] : []),
      ]);
      const child = spawn(file, args, { detached: true, stdio: "ignore", env: process.env });
      child.on("error", () => undefined);
      child.unref();
      const info = await waitForDaemon(10_000, child.pid);
      if (!info) {
        process.stderr.write(
          "sayagain: the daemon did not come up within 10 s; run `sayagain serve` in the foreground to see why\n",
        );
        return 1;
      }
      process.stdout.write(
        `sayagain serve running (pid ${info.pid}) at http://${info.host}:${info.port}; token in ${tokenPath()}\n`,
      );
      return 0;
    }
    const token = loadOrCreateToken();
    ensureLauncher();
    const kind: StoreKind = (store as StoreKind | undefined) ?? registry.daemon?.store ?? "jsonl";
    const storeOptions: Parameters<typeof openStores>[1] = {
      log: (l) => process.stderr.write(`${l}\n`),
    };
    const sqlitePath = db ?? registry.daemon?.db;
    if (sqlitePath !== undefined) storeOptions.sqlitePath = resolve(sqlitePath);
    const stores = openStores(kind, storeOptions);
    const daemonOptions: Parameters<typeof startDaemon>[0] = {
      registry,
      stores,
      version: PROXY_VERSION,
      token,
      onShutdown: () => process.exit(0),
    };
    if (otlpOption !== undefined && registry.daemon?.otlp !== otlpOption) {
      // Remembered, so a daemon the shim restarts keeps exporting.
      registry.daemon = { ...(registry.daemon ?? {}), otlp: otlpOption };
      saveRegistry(registry);
    }
    // The experiment's arm mode persists like the collector, so a daemon the shim restarts keeps it; `--arm off` ends it.
    if (armOption !== undefined && registry.daemon?.arm !== armOption) {
      registry.daemon = { ...(registry.daemon ?? {}), arm: armOption as ArmMode | "off" };
      saveRegistry(registry);
    }
    const persistedArm = armOption ?? registry.daemon?.arm;
    const armMode: ArmMode | undefined =
      persistedArm && persistedArm !== "off" ? (persistedArm as ArmMode) : undefined;
    const otlpEndpoint = await resolveOtlpEndpoint(otlpOption ?? registry.daemon?.otlp);
    if (otlpEndpoint) {
      daemonOptions.otlp = new OtlpExporter({
        endpoint: otlpEndpoint,
        headers: otlpHeadersFromEnv(),
        version: PROXY_VERSION,
        log: (l) => process.stderr.write(`${l}\n`),
      });
      process.stderr.write(`sayagain: exporting spans to ${otlpEndpoint}\n`);
    }
    if (listen !== undefined) daemonOptions.listen = listen;
    if (armMode) daemonOptions.arm = armMode;
    const daemon = await startDaemon(daemonOptions);
    process.stderr.write(
      `sayagain ${PROXY_VERSION} serving ${Object.keys(registry.servers).length} upstream(s) at ${daemon.url} (store: ${stores.kind}; token in ${tokenPath()})\n`,
    );
    for (const name of Object.keys(registry.servers))
      process.stderr.write(`  ${daemon.url}/mcp/${name}\n`);
    await new Promise<void>((resolve) => {
      const stop = () => void daemon.close().then(resolve);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }

  if (command === "stdio") {
    const name = rest[0];
    if (!name) throw new UsageError("stdio: expected the registered server name");
    return runStdioShim({ name, input: process.stdin, output: process.stdout });
  }

  if (command === "add") {
    const opts = [...rest];
    const sep = opts.indexOf("--");
    const serverCommand = sep >= 0 ? opts.slice(sep + 1) : [];
    const flags = sep >= 0 ? opts.slice(0, sep) : opts;
    const name = flags.shift();
    if (!name || name.startsWith("--")) throw new UsageError("add: expected a server name first");
    if (!isValidServerName(name))
      throw new UsageError(
        `add: server names use letters, digits, dot, dash, underscore (got ${JSON.stringify(name)})`,
      );
    const url = takeOption(flags, "--url");
    const pair = (flag: string, raw: string, bareOk: boolean): [string, string] => {
      const i = raw.indexOf("=");
      if (i > 0) return [raw.slice(0, i), raw.slice(i + 1)];
      if (bareOk && i < 0) return [raw, `\${${raw}}`];
      throw new UsageError(`${flag} expects k=v, got ${raw}`);
    };
    const headers = Object.fromEntries(
      takeAll(flags, "--header").map((h) => pair("--header", h, false)),
    );
    const env = Object.fromEntries(takeAll(flags, "--env").map((h) => pair("--env", h, true)));
    let classes: ReturnType<typeof parseClassOverrides>;
    try {
      classes = parseClassOverrides(takeAll(flags, "--class"));
    } catch (err) {
      throw new UsageError(`add: ${err instanceof Error ? err.message : String(err)}`);
    }
    const hold = takeOption(flags, "--hold");
    const cwd = takeOption(flags, "--cwd");
    if (flags.length) throw new UsageError(`add: unknown option ${flags[0]}`);
    if (hold !== undefined && hold !== "destructive" && hold !== "always" && hold !== "never")
      throw new UsageError("add: --hold must be destructive, always or never");
    let config: ServerConfig;
    if (url) {
      if (serverCommand.length)
        throw new UsageError("add: give either --url <url> or -- <command>, not both");
      if (Object.keys(env).length || cwd !== undefined)
        throw new UsageError("add: --env and --cwd apply to stdio commands, not --url");
      config = { transport: "http", url };
      if (Object.keys(headers).length) config.headers = headers;
    } else {
      const [cmd, ...args] = serverCommand;
      if (!cmd) throw new UsageError("add: expected --url <url> or -- <command> [args...]");
      if (Object.keys(headers).length)
        throw new UsageError("add: --header applies to --url upstreams; use --env for a command");
      config = { transport: "stdio", command: cmd, args };
      if (Object.keys(env).length) config.env = env;
      if (cwd !== undefined) config.cwd = resolve(cwd);
    }
    if (Object.keys(classes).length) config.classes = classes;
    if (hold !== undefined) config.hold = hold;
    const literalSecrets = [...Object.values(headers), ...Object.values(env)].filter(
      (v) => !v.includes("${") && /token|secret|key|bearer|password/i.test(v),
    );
    // Re-registering a server changes what runs, not where it came from: origins keep `eject` able
    // to restore the host's original entry, and a class table the operator wrote outlives a --cwd.
    const previous = loadRegistry().servers[name];
    if (previous) {
      if (previous.origins) config.origins = previous.origins;
      if (previous.imported !== undefined) config.imported = previous.imported;
      if (config.classes === undefined && previous.classes) config.classes = previous.classes;
      if (config.hold === undefined && previous.hold) config.hold = previous.hold;
    }
    const replaced = addServer(name, config);
    process.stdout.write(`${replaced ? "replaced" : "registered"} ${name} (${config.transport})\n`);
    if (previous?.origins)
      process.stdout.write(
        `  kept the record of where it came from, so sayagain eject still restores the original entry\n`,
      );
    if (literalSecrets.length)
      process.stderr.write(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the hint tells the user to type a reference
        "note: a value looks like a literal secret; prefer '${VAR}' (single-quoted) so it is resolved from the daemon's environment and never stored\n",
      );
    const live = await liveDaemon();
    process.stdout.write(
      live
        ? `host entry (Streamable HTTP): { "type": "http", "url": "http://${live.host}:${live.port}/mcp/${name}", "headers": { "Authorization": "Bearer <contents of ${tokenPath()}>" } }\n`
        : `host entry: { "command": "sayagain", "args": ["stdio", "${name}"] }   (or start the daemon: sayagain serve --detach)\n`,
    );
    return 0;
  }

  if (command === "remove") {
    const name = rest[0];
    if (!name) throw new UsageError("remove: expected a server name");
    const origins = Object.keys(loadRegistry().servers[name]?.origins ?? {});
    if (origins.length)
      process.stderr.write(
        `note: ${name} was imported from ${origins.length} host file(s); eject it first (sayagain eject --host all ${name}) to restore the original entries\n`,
      );
    const removed = removeServer(name);
    process.stdout.write(removed ? `removed ${name}\n` : `no server named ${name}\n`);
    if (removed && (await liveDaemon()))
      process.stdout.write(
        "the running daemon keeps serving it until restarted: sayagain stop && sayagain serve --detach\n",
      );
    return 0;
  }

  if (command === "list") {
    const registry = loadRegistry();
    const names = Object.keys(registry.servers);
    if (!names.length) {
      process.stdout.write(
        "no registered upstreams; add one with: sayagain add <name> -- <command>\n",
      );
      return 0;
    }
    for (const n of names) {
      const c = registry.servers[n];
      if (!c) continue;
      process.stdout.write(
        `${n}  ${c.transport}  ${c.transport === "http" ? c.url : [c.command, ...(c.args ?? [])].join(" ")}${c.hold ? `  hold=${c.hold}` : ""}\n`,
      );
    }
    return 0;
  }

  if (command === "status") {
    const s = await daemonStatus();
    if (!s) {
      process.stdout.write("no daemon running (sayagain serve --detach)\n");
      return 1;
    }
    process.stdout.write(
      `daemon pid ${s.info.pid} at ${daemonBaseUrl(s.info)} since ${s.info.startedAt} (version ${s.info.version}; spans ${typeof s.health.otlp === "string" ? `to ${s.health.otlp}` : "not exported"}${typeof s.health.arm === "string" ? `; A/B arms: ${s.health.arm}` : ""})\n`,
    );
    for (const srv of s.servers as {
      name: string;
      transport: string;
      target: string;
      started: boolean;
      ready: boolean;
      sessions: number;
      url: string;
    }[])
      process.stdout.write(
        `  ${srv.name.padEnd(16)} ${srv.transport.padEnd(6)} ${srv.started ? (srv.ready ? "ready" : "starting") : "idle"}  sessions ${srv.sessions}  ${srv.url}\n`,
      );
    return 0;
  }

  if (command === "stop") {
    process.stdout.write((await stopDaemon()) ? "stopping daemon\n" : "no daemon running\n");
    return 0;
  }

  if (command === "ui") {
    const opts = [...rest];
    const noOpen = takeFlag(opts, "--no-open");
    if (opts.length) throw new UsageError(`ui: unknown option ${opts[0]}`);
    const info = await ensureDaemon({
      autoStart: true,
      startTimeoutMs: 10_000,
      log: (l) => process.stderr.write(`${l}\n`),
    });
    if (!info)
      throw new UsageError("ui: no daemon is running and none could be started (sayagain serve)");
    // daemon.json is the user's own 0600 file, but the URL still goes to another program: only a
    // plain host, a port and a token of the shape this tool writes are accepted into it.
    if (
      !/^[A-Za-z0-9.:-]+$/.test(info.host) ||
      !Number.isInteger(info.port) ||
      !/^[A-Za-z0-9_-]{16,}$/.test(info.token)
    )
      throw new UsageError(
        "ui: daemon.json holds an unexpected host, port or token; stop the daemon and start it again",
      );
    const url = `${daemonBaseUrl(info)}/ui?token=${info.token}`;
    process.stdout.write(`${url}\n`);
    if (noOpen) return 0;
    // Each opener takes the URL as an argument; none of them is a shell.
    const opener =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["rundll32", "url.dll,FileProtocolHandler", url]
          : ["xdg-open", url];
    const child = spawn(opener[0] as string, opener.slice(1), { stdio: "ignore", detached: true });
    // spawn reports failure on the next tick; wait for either outcome so the message is not lost to process.exit.
    await new Promise<void>((resolve) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => {
        process.stderr.write(`could not open a browser (${err.message}); open the URL above
`);
        resolve();
      });
    });
    child.unref();
    return 0;
  }

  if (command === "hosts") {
    const opts = [...rest];
    const json = takeFlag(opts, "--json");
    const project = takeFlag(opts, "--project");
    if (opts.length) throw new UsageError(`hosts: unknown option ${opts[0]}`);
    const rows = hostFiles(
      process.cwd(),
      project ? ["user", "local", "project"] : ["user", "local"],
    ).map((f) => {
      const base = {
        ...f,
        label: HOSTS[f.host].label,
        servers: [] as string[],
        wrapped: [] as string[],
        error: undefined as string | undefined,
      };
      if (!f.exists) return base;
      try {
        return { ...base, ...inspectHost(f) };
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    for (const r of rows) {
      const where = r.scope === "local" ? `local ${r.project ?? ""}` : r.scope;
      const state = r.error
        ? `error: ${r.error}`
        : r.exists
          ? `${r.servers.length} server(s), ${r.wrapped.length} through Say Again`
          : "no config file";
      process.stdout.write(
        `${r.label.padEnd(15)} ${where.padEnd(8)} ${state}  ${r.scope === "local" ? "" : r.file}\n`,
      );
    }
    process.stdout.write(
      "\nsayagain import --host all --rewrite   wraps every server the hosts above know about\n",
    );
    return 0;
  }

  if (command === "classes" || command === "doctor") {
    const opts = [...rest];
    const asJson = takeFlag(opts, "--json");
    const suggest = command === "classes" ? takeFlag(opts, "--suggest") : false;
    const write = command === "classes" ? takeFlag(opts, "--write") : false;
    // Lowering a class drops a hold, so it is never part of a plain --write.
    const lower = command === "classes" ? takeFlag(opts, "--lower") : false;
    const all = command === "classes" ? takeFlag(opts, "--all") : true;
    const noProbe = command === "doctor" ? takeFlag(opts, "--no-probe") : false;
    const unknown = opts.find((o) => o.startsWith("-"));
    if (unknown) throw new UsageError(`${command}: unknown option ${unknown}`);
    if (command === "doctor" && opts.length)
      throw new UsageError(`doctor: takes no arguments, got ${opts[0]}`);
    if (lower && !write) throw new UsageError("classes: --lower only means something with --write");
    const registry = loadRegistry();
    const names = command === "classes" && !all ? opts : Object.keys(registry.servers);
    if (command === "classes" && !all && names.length !== 1)
      throw new UsageError("classes: expected one server name, or --all");
    if (command === "classes" && opts.length && all)
      throw new UsageError("classes: give a server name or --all, not both");
    for (const n of names)
      if (!Object.hasOwn(registry.servers, n))
        throw new UsageError(`${command}: no server named ${n}`);

    const live = await liveDaemon();
    /** Ask the daemon for a server's tools; it starts the upstream on the way. */
    const probe = async (name: string): Promise<ClassReport | { error: string }> => {
      if (!live) return { error: "no daemon is running" };
      try {
        const tools = await daemonToolsList(name);
        return classReport(name, declaredTools(tools), registry.servers[name]?.classes ?? {});
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };

    if (command === "classes") {
      if (!live)
        throw new UsageError(
          "classes has to start each server to ask for its tools, and no daemon is running (sayagain serve --detach)",
        );
      let failedProbe = false;
      const reports: ClassReport[] = [];
      for (const name of names) {
        const r = await probe(name);
        if ("error" in r) {
          process.stderr.write(`${name}: ${r.error}\n`);
          failedProbe = true;
          continue;
        }
        reports.push(r);
      }
      const take: Direction[] = lower ? ["raise", "lower"] : ["raise"];
      const written: Record<string, number> = {};
      if (write) {
        // Re-read: the probes above took seconds, and another shell may have registered something.
        const fresh = loadRegistry();
        for (const r of reports) {
          const cfg = fresh.servers[r.server];
          if (!cfg) continue;
          const taken = r.suggestions.filter((x) =>
            take.includes(x.suggestion?.direction ?? "raise"),
          );
          if (!taken.length) continue;
          cfg.classes = overridesFrom(r, cfg.classes ?? {}, take);
          written[r.server] = taken.length;
        }
        if (Object.keys(written).length) saveRegistry(fresh);
      }
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ servers: reports, written }, null, 2)}\n`);
        return failedProbe ? 1 : 0;
      }
      for (const r of reports) process.stdout.write(`${renderClasses(r, suggest || write)}\n`);
      const raises = reports.reduce((n, r) => n + suggestionsOf(r, "raise").length, 0);
      const lowers = reports.reduce((n, r) => n + suggestionsOf(r, "lower").length, 0);
      if (write) {
        const total = Object.values(written).reduce((a, b) => a + b, 0);
        if (!total) process.stdout.write("nothing written: no suggestion in that direction\n");
        else {
          let applied: number | null = null;
          let reloadError: string | undefined;
          try {
            applied = await daemonReloadPolicy();
          } catch (err) {
            reloadError = err instanceof Error ? err.message : String(err);
          }
          process.stdout.write(`wrote ${total} override(s) to ${registryPath()}\n`);
          if (reloadError !== undefined)
            process.stderr.write(
              `the running daemon refused the reload (${reloadError}); it keeps the old table until it restarts: sayagain stop && sayagain serve --detach\n`,
            );
          else
            process.stdout.write(
              applied === null
                ? "no daemon is running; it will read them at the next start\n"
                : "the running daemon applied them\n",
            );
        }
        if (!lower && lowers)
          process.stdout.write(
            `${lowers} suggestion(s) would lower a class and were not written: lowering drops the hold, so it needs --write --lower\n`,
          );
      } else if (raises || lowers) {
        if (!suggest)
          process.stdout.write("--suggest shows what the names imply where they differ\n");
        process.stdout.write(
          `--write stores the ${raises} raising suggestion(s) in ${registryPath()}${lowers ? `; --write --lower includes the ${lowers} that lower a class` : ""}\n`,
        );
      }
      return failedProbe ? 1 : 0;
    }

    // ---- doctor
    const hostRows = hostFiles(process.cwd(), ["user", "local", "project"]).map((f) => {
      const base = {
        label: HOSTS[f.host].label,
        host: f.host as string,
        scope: f.scope as string,
        file: f.file,
        project: f.project,
        exists: f.exists,
        servers: [] as string[],
        wrapped: [] as string[],
        error: undefined as string | undefined,
      };
      if (!f.exists) return base;
      try {
        return { ...base, ...inspectHost(f) };
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    });
    const servers: DoctorServer[] = [];
    for (const [name, cfg] of Object.entries(registry.servers)) {
      // The project a host ran this server in, recorded by import; older registries have none.
      const projectOrigins = [
        ...new Set(
          Object.values(cfg.origins ?? {})
            .map((o) => o.project)
            .filter((p): p is string => typeof p === "string"),
        ),
      ];
      const entry: DoctorServer = {
        name,
        transport: cfg.transport,
        cwd: cfg.cwd,
        command: cfg.command,
        args: cfg.args,
        projectOrigins,
        unresolvedRefs: [...new Set([...unresolvedRefs(cfg.env), ...unresolvedRefs(cfg.headers)])],
      };
      if (!noProbe && live) {
        const r = await probe(name);
        if ("error" in r) entry.probeError = r.error;
        else entry.classes = r;
      }
      servers.push(entry);
    }
    const since = new Date(Date.now() - 7 * 86_400_000);
    const byServer: Record<string, number> = {};
    let total = 0;
    try {
      for (const row of await loadRowsSince(since)) {
        const key = row.server ?? row.upstream;
        byServer[key] = (byServer[key] ?? 0) + 1;
        total++;
      }
    } catch {
      // a missing or unreadable ledger is itself reported by the checks below
    }
    // The queue forgets a hold once it is decided, so everything listed is still waiting.
    const holds: DoctorHold[] = (await allHolds().catch(() => [])).map((h) => ({
      receipt: h.receipt,
      tool: h.tool,
      createdAt: Date.parse(h.createdAt) || Date.now(),
      orphaned: h.orphaned,
    }));
    const caveat = launcherCaveat();
    const status = live ? await daemonStatus() : null;
    const health = (status?.health ?? {}) as { arm?: unknown };
    const input = {
      cliVersion: PROXY_VERSION,
      daemon: live
        ? {
            running: true,
            version: live.version,
            arm: typeof health.arm === "string" ? health.arm : null,
            listen: `${live.host}:${live.port}`,
          }
        : { running: false },
      hosts: hostRows,
      servers,
      ledger: { total, byServer },
      holds,
      probed: !noProbe && live !== null,
      ...(caveat ? { launcherCaveat: caveat } : {}),
      hostRunning: claudeCodeRunning(),
    };
    const findings: Finding[] = doctorFindings(input);
    process.stdout.write(
      asJson ? `${JSON.stringify(findings, null, 2)}\n` : renderDoctor(findings),
    );
    return findings.some((f) => f.severity === "error") ? 1 : 0;
  }

  if (command === "import" || command === "install" || command === "eject") {
    const opts = [...rest];
    const hostOption = takeOption(opts, "--host");
    const fileOption = takeOption(opts, "--file");
    const project = takeFlag(opts, "--project");
    const dryRun = takeFlag(opts, "--dry-run");
    const rewrite = command === "import" ? takeFlag(opts, "--rewrite") : false;
    const force = command === "import" ? takeFlag(opts, "--force") : false;
    const keep = command === "eject" ? takeFlag(opts, "--keep") : false;
    const prune = command === "eject" ? takeFlag(opts, "--prune") : false;
    const noStart = command === "eject" ? true : takeFlag(opts, "--no-start");
    const transport =
      command === "eject" ? undefined : (takeOption(opts, "--transport") ?? "stdio");
    const commandPath = command === "eject" ? undefined : takeOption(opts, "--command");
    const unknown = opts.find((o) => o.startsWith("-"));
    if (unknown) throw new UsageError(`${command}: unknown option ${unknown}`);
    const names = opts;
    if (command === "import" && names.length)
      throw new UsageError("import: takes no server names; it imports every server in the file");
    if (transport !== undefined && transport !== "stdio" && transport !== "http")
      throw new UsageError(`${command}: --transport must be stdio or http`);
    if (!hostOption)
      throw new UsageError(`${command}: --host <${HOST_IDS.join("|")}|all> is required`);
    const scopes: Scope[] = project ? ["user", "local", "project"] : ["user", "local"];
    let targets: Target[];
    if (hostOption === "all") {
      if (fileOption) throw new UsageError(`${command}: --file needs one --host`);
      targets = hostFiles(process.cwd(), scopes).filter((f) => f.exists);
      if (!targets.length) {
        process.stdout.write("no host config files found (sayagain hosts lists the locations)\n");
        return 0;
      }
    } else {
      if (!isHostId(hostOption))
        throw new UsageError(
          `${command}: unknown host ${hostOption}; one of ${HOST_IDS.join(", ")}, all`,
        );
      const host: HostId = hostOption;
      const scope: Scope = project ? "project" : "user";
      if (!HOSTS[host].scopes.includes(scope))
        throw new UsageError(`${command}: ${HOSTS[host].label} has no project-scope config`);
      const file = resolve(fileOption ?? HOSTS[host].file(scope, process.cwd()));
      targets = [{ host, scope, file, path: [HOSTS[host].key] }];
      if (!fileOption && host === "claude-code" && !project)
        targets.push(
          ...hostFiles(process.cwd(), ["local"]).filter((f) => f.host === "claude-code"),
        );
    }
    if (transport === "http") {
      for (const t of targets.filter((t) => !HOSTS[t.host].http))
        process.stdout.write(
          `${HOSTS[t.host].label}: does not accept HTTP entries; skipped (use --transport stdio for it)\n`,
        );
      targets = targets.filter((t) => HOSTS[t.host].http);
    }
    if (
      !dryRun &&
      targets.some((t) => t.host === "claude-code" && t.scope !== "project") &&
      claudeCodeRunning()
    )
      process.stderr.write(
        "note: Claude Code is running; it rewrites ~/.claude.json when a session ends and may undo this change. Close sessions first, or run this again afterwards.\n",
      );
    const log = (l: string) => process.stderr.write(`${l}\n`);
    const label = (t: Target) =>
      `${HOSTS[t.host].label} (${t.scope === "local" ? `local: ${t.project ?? ""}` : t.scope})  ${t.file}`;
    const list = (xs: string[]) => (xs.length ? ` (${xs.join(", ")})` : "");
    const entryOptions = {
      transport: transport as "stdio" | "http",
      ...(commandPath ? { command: commandPath } : {}),
    };
    let anyRewritten = false;
    let failed = false;
    for (const t of targets) {
      try {
        if (command === "import") {
          const r = importHost(t, { log, dryRun, rewrite, force, ...entryOptions });
          const parts = [`imported ${r.imported.length}${list(r.imported)}`];
          if (r.updated.length) parts.push(`updated ${r.updated.length}${list(r.updated)}`);
          if (r.unchanged.length) parts.push(`already registered ${r.unchanged.length}`);
          if (r.rewritten.length) parts.push(`rewritten ${r.rewritten.length}`);
          process.stdout.write(`${dryRun ? "[dry-run] " : ""}${label(t)}\n  ${parts.join(", ")}\n`);
          for (const sk of r.skipped) process.stdout.write(`  skipped ${sk.name}: ${sk.reason}\n`);
          if (r.backup) process.stdout.write(`  backup: ${r.backup}\n`);
          anyRewritten ||= r.rewritten.length > 0;
        } else if (command === "install") {
          const r = installHost(t, names.length ? names : undefined, {
            log,
            dryRun,
            ...entryOptions,
          });
          process.stdout.write(
            `${dryRun ? "[dry-run] " : ""}${label(t)}\n  added ${r.added.length}${list(r.added)}, rewritten ${r.rewritten.length}${list(r.rewritten)}, unchanged ${r.unchanged.length}\n`,
          );
          if (r.backup) process.stdout.write(`  backup: ${r.backup}\n`);
          anyRewritten ||= r.added.length + r.rewritten.length > 0;
        } else {
          const r = ejectHost(t, names.length ? names : undefined, { log, dryRun, keep, prune });
          process.stdout.write(
            `${dryRun ? "[dry-run] " : ""}${label(t)}\n  restored ${r.restored.length}${list(r.restored)}, removed ${r.removed.length}${list(r.removed)}, unregistered ${r.unregistered.length}${list(r.unregistered)}\n`,
          );
          for (const l of r.left) process.stdout.write(`  left ${l.name}: ${l.reason}\n`);
          if (r.backup) process.stdout.write(`  backup: ${r.backup}\n`);
        }
      } catch (err) {
        failed = true;
        process.stderr.write(
          `${label(t)}\n  error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    if (command === "import" && !rewrite && !dryRun)
      process.stdout.write("\nregistered only; add --rewrite to point the host at Say Again\n");
    if (anyRewritten && !dryRun) {
      const caveat = launcherCaveat();
      if (caveat) process.stderr.write(`note: ${caveat}\n`);
      if (!noStart && !(await liveDaemon())) {
        // Started from this shell, the daemon inherits the environment the upstreams expect (PATH, exported tokens).
        const { file, args } = serveArgv();
        const child = spawn(file, args, { detached: true, stdio: "ignore", env: process.env });
        child.on("error", () => undefined);
        child.unref();
        const info = await waitForDaemon(10_000, child.pid);
        process.stdout.write(
          info
            ? `\ndaemon started (pid ${info.pid}) at http://${info.host}:${info.port}\n`
            : "\nthe daemon did not start; run: sayagain serve\n",
        );
      }
      process.stdout.write("restart the host to pick up the change\n");
      process.stdout.write(
        "then: sayagain doctor   (checks routing, working directories and how each tool is classed)\n",
      );
    }
    return failed ? 1 : 0;
  }
  if (command === "tools" || command === "errors" || command === "report") {
    const opts = [...rest];
    const ab = command === "report" && takeFlag(opts, "--ab");
    const weekly = takeFlag(opts, "--weekly");
    // The A/B page defaults to the experiment's scale, a month, so a four-week proof is not read as its last week.
    const sinceOption = takeOption(opts, "--since") ?? (ab ? "30d" : "7d");
    const server = takeOption(opts, "--server");
    const ledgerOption = takeOption(opts, "--ledger");
    const minCallsRaw = command === "tools" ? takeNumber(opts, "--min-calls") : undefined;
    const minCalls = minCallsRaw === undefined ? undefined : Math.max(1, minCallsRaw);
    const json = takeFlag(opts, "--json");
    const toolFilter =
      command === "errors" && opts[0] && !opts[0].startsWith("-") ? opts.shift() : undefined;
    if (opts.length) throw new UsageError(`${command}: unknown option ${opts[0]}`);
    let since: Date;
    try {
      since = parseSince(weekly ? "7d" : sinceOption);
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    const now = Date.now();
    if (since.getTime() >= now) throw new UsageError(`${command}: --since must be in the past`);
    // The report compares with the window before this one, so it needs twice the rows.
    const loadFrom =
      command === "report" ? new Date(since.getTime() - (now - since.getTime())) : since;
    const loaded = await loadRowsSince(loadFrom, ledgerOption);
    const rows = server ? loaded.filter(serverMatcher(server)) : loaded;
    const analysis = { since, ...(minCalls !== undefined ? { minCalls } : {}) };
    if (command === "tools") {
      const stats = toolStats(selectRows(rows, analysis), analysis);
      if (json) {
        process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
        return 0;
      }
      if (!stats.length) {
        process.stdout.write(
          `no tool with ${minCalls ?? 10} or more calls since ${since.toISOString()} (${rows.length} rows)\n`,
        );
        return 0;
      }
      process.stdout.write(
        "tool                              calls  fail%  miscall%  same-retry%  calls-to-recover  unrecovered%  waste/1K calls  p50ms  p95ms  boundary\n",
      );
      for (const t of stats) {
        const b = t.boundary;
        const acts = [
          b.retried ? `retried ${b.retried}` : "",
          b.repaired ? `repaired ${b.repaired}` : "",
          b.held ? `held ${b.held}` : "",
          b.deadLettered ? `dead ${b.deadLettered}` : "",
          b.deduplicated ? `dedup ${b.deduplicated}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        process.stdout.write(
          `${`${t.server}/${t.tool}`.padEnd(33)} ${String(t.calls).padStart(5)}  ${String(t.failureRatePct).padStart(5)}  ${String(t.misCallRatePct).padStart(8)}  ${String(t.identicalRetryPct).padStart(11)}  ${String(t.medianCallsToRecover).padStart(16)}  ${String(t.unrecoveredPct).padStart(12)}  ${kib(t.wasteBytesPer1kCalls).padStart(14)}  ${String(t.p50LatencyMs).padStart(5)}  ${String(t.p95LatencyMs).padStart(5)}  ${acts}\n`,
        );
      }
      return 0;
    }
    if (command === "errors") {
      const sigs = signatureStats(selectRows(rows, analysis), analysis).filter(
        (x) => !toolFilter || x.tool === toolFilter || `${x.server}/${x.tool}` === toolFilter,
      );
      if (json) {
        process.stdout.write(`${JSON.stringify(sigs, null, 2)}\n`);
        return 0;
      }
      if (!sigs.length) {
        process.stdout.write(`no failures since ${since.toISOString()} (${rows.length} rows)\n`);
        return 0;
      }
      for (const x of sigs) {
        process.stdout.write(
          `${x.server}/${x.tool}  x${x.count}  ${x.errorClass}  median ${x.medianCallsToRecover} calls to recover, ${x.unrecovered} unrecovered, ${kib(x.wasteBytes)}  (${when(x.firstSeen)} to ${when(x.lastSeen)})\n    ${x.signature}\n`,
        );
        if (x.topRecoveryPath) process.stdout.write(`    recovery path: ${x.topRecoveryPath}\n`);
        if (x.topShapeChange) process.stdout.write(`    shape change: ${x.topShapeChange}\n`);
        process.stdout.write(`    suggestion: ${x.suggestion}\n`);
      }
      return 0;
    }
    if (ab) {
      const r = abReport(rows, analysis);
      process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : renderAbReport(r));
      return 0;
    }
    const r = buildReport(rows, analysis);
    process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : renderReport(r));
    return 0;
  }

  if (command === "learn") {
    const opts = [...rest];
    const json = takeFlag(opts, "--json");
    const update = takeFlag(opts, "--update");
    const revert = takeOption(opts, "--disable") ?? takeOption(opts, "--revert");
    const enable = takeOption(opts, "--enable");
    const apply = takeOption(opts, "--apply");
    const advise = takeOption(opts, "--advise");
    const reportFor = takeOption(opts, "--report");
    const minEvidence = takeNumber(opts, "--min-evidence");
    if (opts.length) throw new UsageError(`learn: unknown option ${opts[0]}`);
    if (reportFor) {
      const viaDaemon = await daemonLearnReport(reportFor);
      process.stdout.write(
        viaDaemon ??
          upstreamReport(reportFor, await loadRowsSince(new Date(0)), new LearnedStore()),
      );
      return 0;
    }
    if (apply || advise) {
      const id = (apply ?? advise) as string;
      const mode = apply ? "apply" : "advise";
      const viaDaemon = await daemonLearn({ id, state: mode });
      if (viaDaemon) {
        process.stdout.write(`${id}: ${(viaDaemon as { mode?: string }).mode ?? mode}\n`);
        return 0;
      }
      const store = new LearnedStore();
      if (!store.setMode(id, mode)) throw new UsageError(`learn: no coercion ${id}`);
      store.save();
      process.stdout.write(`${id}: ${mode}\n`);
      return 0;
    }
    if (revert || enable) {
      const id = (revert ?? enable) as string;
      const state = revert ? "disable" : "enable";
      const viaDaemon = await daemonLearn({ id, state });
      if (viaDaemon) {
        process.stdout.write(`${id}: ${(viaDaemon as { state: string }).state}\n`);
        return 0;
      }
      const store = new LearnedStore();
      if (
        !store.setState(
          id,
          state === "enable" ? "active" : "disabled",
          state === "enable" ? undefined : "disabled by the operator",
        )
      )
        throw new UsageError(`learn: no intervention ${id}`);
      store.save();
      process.stdout.write(`${id}: ${store.get(id)?.state}\n`);
      return 0;
    }
    let interventions: Intervention[];
    let updatedAt: string;
    const viaDaemon = await daemonLearn(
      update
        ? {
            update: true,
            ...(minEvidence !== undefined ? { minEvidence: Math.max(1, minEvidence) } : {}),
          }
        : undefined,
    );
    if (viaDaemon && "interventions" in viaDaemon) {
      interventions = viaDaemon.interventions as Intervention[];
      updatedAt = viaDaemon.updatedAt;
    } else {
      const store = new LearnedStore();
      // Only --update writes the file: listing must never switch the loop on for a wrap.
      if (update) {
        store.reconcile(
          await loadRowsSince(new Date(0)),
          minEvidence !== undefined ? { minEvidence: Math.max(1, minEvidence) } : {},
        );
        store.save();
      }
      interventions = store.list();
      updatedAt = store.updatedAt;
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({ updatedAt, interventions }, null, 2)}\n`);
      return 0;
    }
    if (!interventions.length) {
      process.stdout.write(
        "nothing learned yet: the loop needs a signature seen at least 3 times with a recovery that changed the arguments or called another tool first\n",
      );
      return 0;
    }
    process.stdout.write(`learned as of ${updatedAt.slice(0, 19).replace("T", " ")} UTC\n`);
    for (const i of interventions) {
      const what =
        i.kind === "coerce" ? `${i.rule} on ${i.path}, mode ${i.mode ?? "advise"}` : (i.fact ?? "");
      const lift = i.after
        ? `before ${i.before?.failureRatePct ?? "?"}% fail (${i.before?.calls ?? 0} calls, median ${i.before?.medianCallsToRecover ?? 0} to recover) -> after ${i.after.failureRatePct}% (${i.after.calls} calls, median ${i.after.medianCallsToRecover})`
        : "";
      process.stdout.write(
        `${i.state.padEnd(8)} ${i.id}\n    ${i.server}/${i.tool}: ${what}  (${i.evidence} occurrences of: ${i.signature.slice(0, 80)})\n${lift ? `    ${lift}\n` : ""}${i.reason ? `    ${i.reason}\n` : ""}`,
      );
    }
    process.stdout.write(
      "\nMode advise offers a coercion as a repair after a failure; mode apply also changes read-only calls before they leave.\nsayagain learn --disable <id> turns one off; --enable <id> turns it back on; --apply <id> and --advise <id> switch a coercion's mode; --report <server> writes the upstream report\n",
    );
    return 0;
  }

  if (command === "audit") {
    const opts = [...rest];
    const json = takeFlag(opts, "--json");
    const noHtml = takeFlag(opts, "--no-html");
    const htmlOut = takeOption(opts, "--html");
    const sourceOption = takeOption(opts, "--source") ?? "all";
    const dir = takeOption(opts, "--dir");
    const project = takeOption(opts, "--project");
    const sinceOption = takeOption(opts, "--since") ?? "30d";
    const minCalls = takeNumber(opts, "--min-calls");
    const top = takeNumber(opts, "--top");
    if (opts.length) throw new UsageError(`audit: unknown option ${opts[0]}`);
    const sources: TranscriptSource[] =
      sourceOption === "all" ? [...TRANSCRIPT_SOURCES] : [parseTranscriptSource(sourceOption)];
    if (dir && sources.length !== 1)
      throw new UsageError("audit: --dir needs --source to say which host wrote the files");
    let since: Date;
    try {
      since = parseSince(sinceOption);
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    if (since.getTime() >= Date.now()) throw new UsageError("audit: --since must be in the past");
    // The page compares with the window before this one, so read twice as far back.
    const loadFrom = new Date(since.getTime() - (Date.now() - since.getTime()));
    const scan = scanTranscripts({
      sources,
      since: loadFrom,
      ...(project !== undefined ? { project } : {}),
      ...(dir && sources[0] ? { dirs: { [sources[0]]: resolve(dir) } } : {}),
    });
    const audit = runAudit(
      scan.sessions,
      {
        since,
        version: PROXY_VERSION,
        ...(minCalls !== undefined ? { minCalls: Math.max(1, minCalls) } : {}),
        ...(top !== undefined ? { top: Math.max(1, top) } : {}),
      },
      scan.files,
    );
    if (json) process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    else process.stdout.write(renderAuditText(audit));
    if (!noHtml) {
      const path =
        htmlOut !== undefined
          ? resolve(htmlOut)
          : homePath("audit", `${audit.generatedAt.replace(/[:.]/g, "-")}.html`);
      mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(path, renderAuditHtml(audit), { mode: 0o600 });
      if (!json) process.stdout.write(`HTML page: ${path}\n`);
    }
    if (!scan.sessions.length && !json) {
      const looked = sources.map((s) => `${s}: ${scan.dirs[s]}`).join(", ");
      process.stdout.write(
        `No transcripts found since ${loadFrom.toISOString().slice(0, 10)} (${looked}).\n`,
      );
    }
    return 0;
  }

  if (command === "contribute") {
    const opts = [...rest];
    const json = takeFlag(opts, "--json");
    const yes = takeFlag(opts, "--yes");
    const status = takeFlag(opts, "--status");
    const forget = takeFlag(opts, "--forget");
    const weekly = takeOption(opts, "--weekly");
    const acceptTerms = takeOption(opts, "--accept-terms");
    const endpointOption = takeOption(opts, "--endpoint");
    const sourceOption = takeOption(opts, "--source") ?? "ledger";
    const dir = takeOption(opts, "--dir");
    const sinceOption = takeOption(opts, "--since") ?? "30d";
    const ledgerOption = takeOption(opts, "--ledger");
    if (opts.length) throw new UsageError(`contribute: unknown option ${opts[0]}`);
    const registry = loadRegistry();
    const settings = contributeSettings(registry);
    const contributor = settings.contributor as string;
    if (acceptTerms !== undefined) {
      if (acceptTerms !== TERMS_VERSION)
        throw new UsageError(
          `contribute: the current terms are version ${TERMS_VERSION} (docs/CONTRIBUTING-DATA.md); got ${JSON.stringify(acceptTerms)}`,
        );
      settings.consent = { termsVersion: TERMS_VERSION, acceptedAt: new Date().toISOString() };
      saveRegistry(registry);
    }
    if (endpointOption !== undefined) {
      checkEndpointOrUsage(endpointOption);
      settings.endpoint = endpointOption;
      saveRegistry(registry);
    }
    const endpoint = settings.endpoint;
    const consented = settings.consent?.termsVersion === TERMS_VERSION;
    if (weekly !== undefined) {
      if (weekly !== "on" && weekly !== "off")
        throw new UsageError("contribute: --weekly takes on or off");
      if (weekly === "on" && !endpoint)
        throw new UsageError("contribute: --weekly on needs an endpoint (--endpoint <url>)");
      if (weekly === "on" && !consented)
        throw new UsageError(`contribute: --weekly on needs --accept-terms ${TERMS_VERSION} first`);
      settings.weekly = weekly === "on";
      saveRegistry(registry);
      process.stdout.write(`weekly contribution: ${weekly}\n`);
      return 0;
    }
    if (forget) {
      // Stop sending and rotate first, so a dead index cannot keep the old id alive.
      const old = contributor;
      const toDelete = [...(settings.pendingForget ?? []), old];
      delete settings.contributor;
      delete settings.lastSentAt;
      settings.weekly = false;
      settings.pendingForget = endpoint ? toDelete : [];
      contributeSettings(registry);
      process.stdout.write(
        `contributor id rotated: ${old} -> ${settings.contributor}; weekly contribution off\n`,
      );
      if (!endpoint) {
        process.stdout.write("no endpoint: nothing to delete remotely\n");
        return 0;
      }
      let failed = 0;
      for (const id of toDelete) {
        try {
          const code = await forgetContributor(id, endpoint, PROXY_VERSION);
          process.stdout.write(`the index answered ${code} to the deletion of ${id}\n`);
          settings.pendingForget = (settings.pendingForget ?? []).filter((x) => x !== id);
        } catch (err) {
          failed++;
          process.stdout.write(
            `the deletion of ${id} at ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}; run --forget again to retry it\n`,
          );
        }
      }
      saveRegistry(registry);
      return failed ? 1 : 0;
    }
    if (status) {
      const s = {
        contributor,
        consent: settings.consent ?? null,
        termsVersion: TERMS_VERSION,
        endpoint: endpoint ?? null,
        weekly: settings.weekly ?? false,
        lastSentAt: settings.lastSentAt ?? null,
        pendingForget: settings.pendingForget ?? [],
        contributions: homePath("contributions"),
      };
      process.stdout.write(
        json
          ? `${JSON.stringify(s, null, 2)}\n`
          : `contributor  ${s.contributor}\nterms        ${s.consent ? `${s.consent.termsVersion} accepted ${s.consent.acceptedAt}` : `not accepted (current: ${TERMS_VERSION})`}\nendpoint     ${s.endpoint ?? "none (ADR-0009 decision 3 pending)"}\nweekly       ${s.weekly ? "on" : "off"}\nlast sent    ${s.lastSentAt ?? "never"}\n${s.pendingForget.length ? `to delete    ${s.pendingForget.join(", ")} (run --forget to retry)\n` : ""}documents    ${s.contributions}\n`,
      );
      return 0;
    }
    let since: Date;
    try {
      since = parseSince(sinceOption);
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    if (since.getTime() >= Date.now())
      throw new UsageError("contribute: --since must be in the past");
    const consent = settings.consent ?? { termsVersion: "none", acceptedAt: "" };
    let rows: LedgerRow[];
    let extras = new Map<string, RowExtra>();
    let sessions: number | undefined;
    let source: Parameters<typeof buildShapeDocument>[1]["source"];
    if (sourceOption === "ledger") {
      if (dir) throw new UsageError("contribute: --dir goes with a transcript --source");
      rows = await loadRowsSince(since, ledgerOption);
      source = "ledger";
    } else {
      const host = parseTranscriptSource(sourceOption);
      const scan = scanTranscripts({
        sources: [host],
        since,
        ...(dir ? { dirs: { [host]: resolve(dir) } } : {}),
      });
      rows = [];
      for (const s of scan.sessions) {
        const out = sessionRows(s);
        rows.push(...out.rows);
        extras = new Map([...extras, ...out.extras]);
      }
      sessions = new Set(scan.sessions.map((x) => x.id)).size; // files can share a session
      source = `${host}-transcripts`;
    }
    const doc = buildShapeDocument(rows, {
      source,
      contributor,
      consent,
      since,
      version: PROXY_VERSION,
      ...(sessions !== undefined ? { sessions } : {}),
      familyOf: (r) => extras.get(r.receipt)?.family ?? "unknown",
      schemaHashOf: (r) => extras.get(r.receipt)?.schemaHash,
    });
    if (!doc.shapes.length) {
      process.stdout.write(
        `nothing to contribute: no tool calls from ${source} since ${since.toISOString().slice(0, 10)}${source === "ledger" ? " (try --source claude-code, codex or cursor)" : ""}\n`,
      );
      return 0;
    }
    const path = writeContribution(doc);
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    process.stdout.write(text);
    if (json) return 0;
    process.stdout.write(`\n${summarizeDocument(doc)}\nwritten to ${path}\n`);
    if (!endpoint) {
      process.stdout.write(
        "No index endpoint is configured yet (ADR-0009, decision 3): nothing was sent. Pass --endpoint <https url> to send to one.\n",
      );
      return 0;
    }
    if (!consented) {
      process.stdout.write(
        `Nothing was sent: the first contribution needs --accept-terms ${TERMS_VERSION} (docs/CONTRIBUTING-DATA.md).\n`,
      );
      return 1;
    }
    let send = yes;
    if (!send) {
      if (!process.stdin.isTTY) {
        process.stdout.write("Nothing was sent: not a terminal, and no --yes.\n");
        return 1;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(
          `Send this to the Tool Reliability Index at ${endpoint}? [y/N] `,
        );
        send = /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    }
    if (!send) {
      process.stdout.write("Nothing was sent.\n");
      return 1;
    }
    const receipt = await sendContribution(doc, endpoint, PROXY_VERSION);
    settings.lastSentAt = new Date().toISOString();
    saveRegistry(registry);
    process.stdout.write(
      `sent: the index answered ${receipt.status}${receipt.receipt ? `, receipt ${receipt.receipt}` : ""}${receipt.url ? `\nyour servers on the index: ${receipt.url}` : ""}\n`,
    );
    return 0;
  }

  if (command === "index") {
    const sub = rest[0];
    const opts = rest.slice(1);
    if (sub !== "build" && sub !== "fixes")
      throw new UsageError("index: expected build or fixes <server>");
    const from = takeOption(opts, "--from");
    const contributionsDir = takeOption(opts, "--contributions") ?? homePath("contributions");
    const outDir = takeOption(opts, "--out") ?? homePath("index");
    let baseUrl = takeOption(opts, "--base-url") ?? "";
    while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1); // no regex: registry-fed input
    const target = sub === "fixes" ? opts.shift() : undefined;
    if (opts.length) throw new UsageError(`index: unknown option ${opts[0]}`);
    if (!from)
      throw new UsageError("index: --from <scan.json> is required (lint --registry --out)");
    if (sub === "fixes" && !target) throw new UsageError("index fixes: expected a server name");
    let scan: Parameters<typeof buildIndex>[0];
    try {
      scan = JSON.parse(readFileSync(resolve(from), "utf8")) as Parameters<typeof buildIndex>[0];
    } catch (err) {
      throw new UsageError(
        `index: cannot read ${from}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(scan.servers) || !scan.selection || !scan.m16)
      throw new UsageError(`index: ${from} is not a registry scan (lint --registry --out)`);
    const contributions: Parameters<typeof buildIndex>[1] = [];
    if (existsSync(contributionsDir))
      for (const f of readdirSync(contributionsDir)
        .filter((x) => x.endsWith(".json"))
        .sort()) {
        try {
          const doc: unknown = JSON.parse(readFileSync(resolve(contributionsDir, f), "utf8"));
          assertShapeDocumentSafe(doc);
          contributions.push(doc);
        } catch (err) {
          process.stderr.write(
            `index: skipping ${f}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    const index = buildIndex(scan, contributions, { version: PROXY_VERSION });
    if (sub === "fixes") {
      const wanted = (target as string).toLowerCase();
      const server = index.servers.find(
        (s) => s.name.toLowerCase() === wanted || s.slug === wanted,
      );
      if (!server) throw new UsageError(`index fixes: no server ${target} in ${from}`);
      process.stdout.write(fixesText(index, server, baseUrl));
      return 0;
    }
    const site = renderIndexSite(index, baseUrl);
    for (const [path, content] of site) {
      const file = resolve(outDir, path);
      mkdirSync(resolve(file, ".."), { recursive: true });
      writeFileSync(file, content);
    }
    const graded = index.servers.filter((s) => s.score !== undefined).length;
    const runtime = index.servers.filter((s) => s.tools.some((t) => t.runtime)).length;
    process.stdout.write(
      `index: ${graded} servers graded, ${runtime} with runtime data from ${contributions.length} contribution${contributions.length === 1 ? "" : "s"}; ${site.size} files written to ${resolve(outDir)}\n`,
    );
    return 0;
  }

  if (command === "lint" && rest.includes("--registry")) {
    const opts = [...rest];
    takeFlag(opts, "--registry");
    const json = takeFlag(opts, "--json");
    const sample = takeNumber(opts, "--sample");
    const first = takeNumber(opts, "--first");
    const seed = takeNumber(opts, "--seed");
    const concurrency = takeNumber(opts, "--concurrency");
    const timeoutOption = takeOption(opts, "--timeout");
    const outFile = takeOption(opts, "--out");
    const registryUrl = takeOption(opts, "--registry-url");
    const allowPrivate = takeFlag(opts, "--allow-private");
    if (opts.length) throw new UsageError(`lint: unknown option ${opts[0]}`);
    if (sample !== undefined && first !== undefined)
      throw new UsageError("lint: --sample and --first are alternatives");
    if (seed !== undefined && sample === undefined)
      throw new UsageError("lint: --seed goes with --sample");
    if (sample === 0 || first === 0)
      throw new UsageError("lint: --sample and --first need a positive number");
    let timeoutMs: number | undefined;
    if (timeoutOption !== undefined) {
      const m = timeoutOption.match(/^(\d+)\s*(ms|s)?$/);
      if (!m) throw new UsageError("lint: --timeout expects a number of seconds, like 10s");
      timeoutMs = Number(m[1]) * (m[2] === "ms" ? 1 : 1000);
      if (timeoutMs <= 0) throw new UsageError("lint: --timeout must be positive");
    }
    const scan = await scanRegistry({
      ...(sample !== undefined ? { sample } : {}),
      ...(first !== undefined ? { first } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(concurrency !== undefined ? { concurrency: Math.max(1, concurrency) } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(registryUrl !== undefined ? { registryUrl } : {}),
      ...(allowPrivate ? { allowPrivate: true } : {}),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    if (outFile !== undefined) {
      mkdirSync(resolve(outFile, ".."), { recursive: true });
      writeFileSync(resolve(outFile), `${JSON.stringify(scan, null, 2)}\n`);
    }
    if (json) {
      const { servers: _servers, ...summary } = scan;
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else process.stdout.write(renderRegistryScan(scan));
    if (outFile !== undefined && !json)
      process.stdout.write(`per-server results: ${resolve(outFile)}\n`);
    return 0;
  }

  if (command === "lint") {
    const opts = [...rest];
    const json = takeFlag(opts, "--json");
    const all = takeFlag(opts, "--all");
    const file = takeOption(opts, "--file");
    const failBelow = takeOption(opts, "--fail-below");
    const name = opts.shift();
    if (opts.length) throw new UsageError(`lint: unknown option ${opts[0]}`);
    if (!all && !file && !name)
      throw new UsageError("lint: expected a server name, --all, or --file <tools.json>");
    if (file && (name || all)) throw new UsageError("lint: --file takes no server name or --all");
    if (failBelow !== undefined && !["A", "B", "C", "D"].includes(failBelow))
      throw new UsageError("lint: --fail-below must be A, B, C or D");
    const sources: { label: string; tools: ToolDefinition[] }[] = [];
    let failedToLoad = 0;
    if (file) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        throw new UsageError(
          `lint: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const obj = parsed as { tools?: ToolDefinition[]; result?: { tools?: ToolDefinition[] } };
      const tools = Array.isArray(parsed)
        ? (parsed as ToolDefinition[])
        : (obj.tools ?? obj.result?.tools);
      if (!tools?.length)
        throw new UsageError(
          `lint: ${file} holds no tools (expected an array, {tools: [...]}, or a tools/list response)`,
        );
      sources.push({ label: file, tools });
    } else {
      const names = all ? Object.keys(loadRegistry().servers) : [name as string];
      if (!names.length)
        throw new UsageError("lint: no servers registered (sayagain add <name> -- <command>)");
      if (!(await liveDaemon()))
        throw new UsageError(
          "lint: the daemon must be running to fetch tool lists (sayagain serve --detach), or pass --file",
        );
      for (const n of names) {
        try {
          const tools = await daemonToolsList(n);
          sources.push({ label: n, tools: (tools ?? []) as ToolDefinition[] });
        } catch (err) {
          failedToLoad++;
          process.stderr.write(`${n}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
    const results = sources.map((src) => ({
      server: src.label,
      tools: src.tools.map((t) => {
        const findings = lintTool(t);
        return { name: t.name, grade: grade(findings), findings };
      }),
    }));
    if (json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    else
      for (const r of results) {
        const dist: Record<string, number> = {};
        for (const t of r.tools) dist[t.grade] = (dist[t.grade] ?? 0) + 1;
        process.stdout.write(
          `${r.server}: ${r.tools.length} tool(s)  ${["A", "B", "C", "D", "F"].map((g) => `${g}:${dist[g] ?? 0}`).join(" ")}\n`,
        );
        for (const t of r.tools) {
          process.stdout.write(`  ${t.grade}  ${t.name}\n`);
          for (const f of t.findings)
            process.stdout.write(
              `       ${f.severity.padEnd(7)} ${f.rule}${f.path ? ` (${f.path})` : ""}: ${f.message}\n`,
            );
        }
      }
    const order = ["A", "B", "C", "D", "F"];
    const belowThreshold = failBelow
      ? results
          .flatMap((r) => r.tools)
          .filter((t) => order.indexOf(t.grade) > order.indexOf(failBelow)).length
      : 0;
    if (belowThreshold)
      process.stderr.write(`lint: ${belowThreshold} tool(s) graded below ${failBelow}\n`);
    return failedToLoad || belowThreshold || !sources.length ? 1 : 0;
  }

  if (command === "ledger") {
    const opts = [...rest];
    const ledgerOption = takeOption(opts, "--ledger");
    const tail = takeNumber(opts, "--tail");
    const json = takeFlag(opts, "--json");
    if (opts.length) throw new UsageError(`ledger: unknown option ${opts[0]}`);
    // A running daemon answers from whatever store it uses; otherwise read the files directly.
    let rows = ledgerOption === undefined ? await daemonLedger(tail ?? 100) : null;
    let ledgerPath = ledgerOption ?? defaultLedgerPath();
    if (rows === null) {
      const registry = loadRegistry();
      if (ledgerOption === undefined && registry.daemon?.store === "sqlite") {
        const storeOptions: Parameters<typeof openStores>[1] = {};
        if (registry.daemon.db !== undefined) storeOptions.sqlitePath = resolve(registry.daemon.db);
        const stores = openStores("sqlite", storeOptions);
        rows = stores.readLedger(tail);
        ledgerPath = storeOptions.sqlitePath ?? "the SQLite store";
        stores.close();
      } else {
        const readOptions: { tail?: number } = {};
        if (tail !== undefined) readOptions.tail = tail;
        rows = readLedger(ledgerPath, readOptions);
      }
    }
    if (json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    if (!rows.length) {
      process.stdout.write(`no calls recorded in ${ledgerPath}\n`);
      return 0;
    }
    for (const r of rows) {
      const err = r.isError
        ? ` ERROR(${r.errorClass ?? "?"}) ${r.errorSignature ?? r.errorCode ?? ""}`.trimEnd()
        : "";
      const bits: string[] = [];
      if (r.duplicateOf) bits.push(`duplicate of ${r.duplicateOf}`);
      if (r.held)
        bits.push(
          `held (${r.held.mode}): ${r.held.cancelled ? "cancelled" : (r.held.decision ?? "pending")}`,
        );
      if (r.attempts) bits.push(`attempts ${r.attempts}`);
      if (r.repairs?.length)
        bits.push(`repaired ${r.repairs.map((c) => `${c.path} ${c.rule}`).join(", ")}`);
      if (r.replayOf) bits.push(`replay of ${r.replayOf}`);
      const extra = bits.length ? `  ${bits.join("; ")}` : "";
      process.stdout.write(
        `${r.ts}  ${r.receipt}  ${r.status.padEnd(13)}  ${r.upstream}/${r.tool} [${r.toolClass}]  ${r.latencyMs}ms${err}${extra}\n`,
      );
    }
    return 0;
  }

  if (command === "holds") {
    const json = rest.includes("--json");
    const holds = await allHolds();
    if (json) {
      process.stdout.write(`${JSON.stringify(holds, null, 2)}\n`);
      return 0;
    }
    if (!holds.length) {
      process.stdout.write("no held calls\n");
      return 0;
    }
    for (const h of holds) {
      const where = h.server ? `${h.server}/` : "";
      process.stdout.write(
        `${h.receipt}  ${where}${h.tool} [${h.toolClass}]  ${h.reason}  since ${h.createdAt}${h.orphaned ? "  (from before a restart: the host is gone; approve runs it for the ledger)" : ""}\n`,
      );
      if (h.intent) process.stdout.write(`    intent: ${h.intent}\n`);
      process.stdout.write(`    arguments: ${JSON.stringify(h.arguments)}\n`);
      process.stdout.write(
        `    sayagain approve ${h.receipt}   |   sayagain reject ${h.receipt}\n`,
      );
    }
    return 0;
  }

  if (command === "approve" || command === "reject") {
    const receipt = rest[0];
    if (!receipt) throw new UsageError(`${command}: expected a receipt`);
    const ok = await decideAnywhere(receipt, command);
    process.stdout.write(
      ok ? `${command}d ${receipt}\n` : `no running boundary holds ${receipt}\n`,
    );
    return ok ? 0 : 1;
  }

  if (command === "deadletters" || command === "dead") {
    const opts = [...rest];
    const json = takeFlag(opts, "--json");
    const deadLetterOption = takeOption(opts, "--deadletter");
    if (opts.length) throw new UsageError(`deadletters: unknown option ${opts[0]}`);
    const live = await allDeadLetters();
    const liveReceipts = new Set(live.map((d) => d.receipt));
    const registry = loadRegistry();
    let storedAll: ReturnType<typeof readDeadLetters>;
    if (deadLetterOption === undefined && registry.daemon?.store === "sqlite") {
      const storeOptions: Parameters<typeof openStores>[1] = {};
      if (registry.daemon.db !== undefined) storeOptions.sqlitePath = resolve(registry.daemon.db);
      const stores = openStores("sqlite", storeOptions);
      storedAll = stores.deadLetters.list();
      stores.close();
    } else storedAll = readDeadLetters(deadLetterOption ?? defaultDeadLetterPath());
    const stored = storedAll.filter((d) => !liveReceipts.has(d.receipt));
    if (json) {
      process.stdout.write(`${JSON.stringify({ live, stored }, null, 2)}\n`);
      return 0;
    }
    if (!live.length && !stored.length) {
      process.stdout.write("no dead-lettered calls\n");
      return 0;
    }
    for (const d of live) {
      process.stdout.write(
        `${d.receipt}  ${d.upstream}/${d.tool}  ${d.errorClass}: ${d.errorSignature}  attempts ${d.attempts}, repairs ${d.repairs}  (live: sayagain replay ${d.receipt})\n`,
      );
      if (d.intent) process.stdout.write(`    intent: ${d.intent}\n`);
    }
    for (const d of stored) {
      process.stdout.write(
        `${d.receipt}  ${d.upstream}/${d.tool}  ${d.errorClass}: ${d.errorSignature}  attempts ${d.attempts}, repairs ${d.repairs}  (stored; start the same wrap to replay)\n`,
      );
    }
    return 0;
  }

  if (command === "replay") {
    const opts = [...rest];
    const argsRaw = takeOption(opts, "--args");
    const receipt = opts[0];
    if (!receipt) throw new UsageError("replay: expected a receipt");
    const args = argsRaw !== undefined ? (JSON.parse(argsRaw) as unknown) : undefined;
    const outcome = await replayAnywhere(receipt, args);
    if (!outcome) {
      process.stdout.write(
        `no running boundary has dead letter ${receipt}; start the same wrap (it reloads its dead letters) and try again\n`,
      );
      return 1;
    }
    process.stdout.write(
      `${outcome.isError ? "failed" : "succeeded"}  ${outcome.receipt}  replay of ${outcome.replayOf}\n${outcome.text}\n`,
    );
    return outcome.isError ? 1 : 0;
  }

  throw new UsageError(`unknown command: ${command}\n${USAGE}`);
}

/** Run the command line and exit with its code. The `sayagain` wrapper package calls this. */
export function runCli(argv: string[] = process.argv.slice(2)): void {
  main(argv).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}

// Self-run only when this file is the entry point (directly, or through npm's bin symlink).
const entry = process.argv[1];
let invokedDirectly = false;
if (entry) {
  try {
    invokedDirectly = realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    invokedDirectly = false;
  }
}
if (invokedDirectly) runCli();
