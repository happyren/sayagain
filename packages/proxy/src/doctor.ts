/**
 * One command that checks the whole setup and says what to run next (ADR-0012).
 *
 * Everything here is a pure function over a snapshot the CLI gathers, so the checks can be tested
 * without a daemon, a host or a home directory.
 */
import type { ClassReport } from "./classes.js";

export type Severity = "error" | "warning" | "note" | "ok";

export interface Finding {
  severity: Severity;
  /** Short, specific, and about one thing. */
  title: string;
  /** Why it matters, in the boundary's own terms. */
  detail?: string | undefined;
  /** The exact command that addresses it. */
  fix?: string;
}

export interface DoctorHost {
  label: string;
  host: string;
  scope: string;
  file: string;
  project?: string | undefined;
  exists: boolean;
  /** Every server the file names. */
  servers: string[];
  /** Those of them that go through Say Again. */
  wrapped: string[];
  error?: string | undefined;
}

export interface DoctorServer {
  name: string;
  transport: string;
  cwd?: string | undefined;
  /** Project directories this server was imported from, if any. */
  projectOrigins: string[];
  /** The class table, when the tools could be listed. */
  classes?: ClassReport | undefined;
  /** Why the tools could not be listed. */
  probeError?: string | undefined;
}

export interface DoctorInput {
  cliVersion: string;
  daemon: { running: boolean; version?: string | undefined; arm?: string | null | undefined };
  hosts: DoctorHost[];
  servers: DoctorServer[];
  /** Calls recorded in the last seven days, and how many each server contributed. */
  ledger: { total: number; byServer: Record<string, number> };
  launcherCaveat?: string | undefined;
  hostRunning?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** Verb agreement, so a finding about a single tool still reads like a sentence. */
const agree = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The whole check, in the order an operator would want to read it. */
export function doctorFindings(input: DoctorInput): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);

  // ---- the daemon
  if (!input.daemon.running)
    add({
      severity: "error",
      title: "no daemon is running",
      detail: "hosts pointed at Say Again cannot reach their servers until it is up.",
      fix: "sayagain serve --detach",
    });
  else {
    if (input.daemon.version && input.daemon.version !== input.cliVersion)
      add({
        severity: "warning",
        title: `the daemon runs ${input.daemon.version} but this command is ${input.cliVersion}`,
        detail: "the running daemon keeps its own code until it restarts.",
        fix: "sayagain stop && sayagain serve --detach",
      });
    add({
      severity: "ok",
      title: `daemon ${input.daemon.version ?? "?"} is running`,
      detail:
        typeof input.daemon.arm === "string"
          ? `the A/B protocol is on, arms assigned by ${input.daemon.arm} (docs/measurement.md 5.4).`
          : undefined,
    });
  }

  if (input.launcherCaveat)
    add({
      severity: "warning",
      title: "the launcher needs attention",
      detail: input.launcherCaveat,
    });

  // ---- hosts
  const files = input.hosts.filter((h) => h.exists);
  for (const h of files) {
    if (h.error) {
      add({
        severity: "warning",
        title: `${h.label} (${h.scope}) could not be read`,
        detail: `${h.file}: ${h.error}`,
      });
      continue;
    }
    const direct = h.servers.filter((s) => !h.wrapped.includes(s));
    if (direct.length)
      add({
        severity: "warning",
        title: `${h.label} (${h.scope}) calls ${plural(direct.length, "server")} directly: ${direct.join(", ")}`,
        detail:
          "their calls never reach the boundary, so they are absent from the ledger and every report.",
        fix: `sayagain import --host ${h.host}${h.scope === "project" ? " --project" : ""} --rewrite`,
      });
  }
  const anyWrapped = files.some((h) => h.wrapped.length > 0);
  if (files.length && !anyWrapped)
    add({
      severity: "error",
      title: "no host routes any server through Say Again",
      detail: "nothing is being recorded.",
      fix: "sayagain import --host all --rewrite",
    });

  // A server wrapped in one scope and absent from another is the trap: it works in one project and
  // silently bypasses the boundary everywhere else.
  const userScopes = files.filter((h) => h.scope === "user");
  for (const h of files.filter((f) => f.scope !== "user"))
    for (const name of h.wrapped) {
      const sameHostUser = userScopes.find((u) => u.host === h.host);
      if (sameHostUser && !sameHostUser.servers.includes(name))
        add({
          severity: "note",
          title: `${name} goes through Say Again only in ${h.project ?? h.scope}`,
          detail: `${h.label} calls it directly from every other directory, where it stays out of the ledger.`,
          fix: `sayagain install --host ${h.host} ${name}`,
        });
    }

  // ---- servers
  for (const s of input.servers) {
    if (s.transport === "stdio" && s.cwd === undefined && s.projectOrigins.length)
      add({
        severity: "warning",
        title: `${s.name} runs without a working directory`,
        detail:
          "the host started it inside a project; the daemon starts it from its own directory, so a server that finds its project by the current directory will not find it.",
        fix: `sayagain add ${s.name} --cwd ${s.projectOrigins[0]} -- <the same command>`,
      });

    if (s.probeError) {
      add({
        severity: "warning",
        title: `${s.name} could not be asked for its tools`,
        detail: s.probeError,
      });
      continue;
    }
    const c = s.classes;
    if (!c) continue;
    const total = c.rows.length;
    if (!total) continue;

    if (c.fallback === total)
      add({
        severity: "warning",
        title: `${s.name} declares no annotations on any of its ${plural(total, "tool")}`,
        detail: `every call falls back to the cautious class, so none is retried after a retryable failure and none is coerced before it leaves. ${plural(c.counts.write, "tool")} counted as writes inflate the denominator of the north-star rate.`,
        fix: `sayagain classes ${s.name} --suggest`,
      });
    else if (c.fallback)
      add({
        severity: "note",
        title: `${plural(c.fallback, "tool")} of ${s.name} ${agree(c.fallback, "takes", "take")} the cautious fallback`,
        detail: "they take the cautious fallback: no retry, and a write in the report's counts.",
        fix: `sayagain classes ${s.name} --suggest`,
      });

    const held = c.rows.filter((r) => r.toolClass === "destructive");
    const heldReads = held.filter((r) => r.suggestion?.toolClass === "read-only");
    if (heldReads.length)
      add({
        severity: "error",
        title: `${plural(heldReads.length, "tool")} of ${s.name} ${agree(heldReads.length, "is", "are")} held on every call although the name reads like a read`,
        detail: `${heldReads
          .slice(0, 4)
          .map((r) => r.tool)
          .join(
            ", ",
          )}${heldReads.length > 4 ? ", ..." : ""}: each waits for an approval before it leaves.`,
        fix: `sayagain classes ${s.name} --suggest`,
      });
    else if (held.length > total / 2)
      add({
        severity: "warning",
        title: `${s.name} declares ${held.length} of ${total} tools destructive`,
        detail: "each one waits for a decision under the default hold policy.",
        fix: `sayagain classes ${s.name}`,
      });

    const contradictory = c.rows.filter((r) => r.warning?.startsWith("declared both"));
    if (contradictory.length)
      add({
        severity: "note",
        title: `${plural(contradictory.length, "tool")} of ${s.name} ${agree(contradictory.length, "declares itself", "declare themselves")} both read-only and destructive`,
        detail: "the boundary takes the read-only side; the server's own schema is worth a look.",
        fix: `sayagain lint ${s.name}`,
      });
  }

  // ---- traffic
  if (input.daemon.running && anyWrapped) {
    if (!input.ledger.total)
      add({
        severity: "note",
        title: "no calls recorded in the last seven days",
        detail: "restart the host after wrapping it, or its sessions keep the old entries.",
      });
    else {
      const silent = input.servers
        .filter((s) => !(input.ledger.byServer[s.name] ?? 0))
        .map((s) => s.name);
      if (silent.length && silent.length < input.servers.length)
        add({
          severity: "note",
          title: `no calls recorded for ${silent.join(", ")}`,
          detail: "either the agents have not used them, or their host still calls them directly.",
        });
    }
  }

  if (input.hostRunning)
    add({
      severity: "note",
      title: "Claude Code is running",
      detail: "it rewrites ~/.claude.json when a session ends and can undo a change made now.",
    });

  return out;
}

const MARK: Record<Severity, string> = { error: "!!", warning: " !", note: " ·", ok: " ✓" };

export function renderDoctor(findings: Finding[]): string {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${MARK[f.severity]} ${f.title}`);
    if (f.detail) lines.push(`     ${f.detail}`);
    if (f.fix) lines.push(`     fix: ${f.fix}`);
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  lines.push("");
  lines.push(
    errors || warnings
      ? `${plural(errors, "error")}, ${plural(warnings, "warning")}; the fixes above are in the order they matter.`
      : "nothing to fix.",
  );
  return `${lines.join("\n")}\n`;
}
