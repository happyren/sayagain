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
  /** The exact command that addresses it, runnable as printed. */
  fix?: string | undefined;
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
  /** The command the daemon runs, so a fix can be printed in full rather than as a placeholder. */
  command?: string | undefined;
  args?: string[] | undefined;
  /** Project directories a host started this server in, recorded at import. */
  projectOrigins: string[];
  /** Environment or header references the daemon's own environment does not define. */
  unresolvedRefs?: string[] | undefined;
  /** The class table, when the tools could be listed. */
  classes?: ClassReport | undefined;
  /** Why the tools could not be listed. */
  probeError?: string | undefined;
}

export interface DoctorHold {
  receipt: string;
  tool: string;
  createdAt: number;
  decision?: string | undefined;
  orphaned?: boolean | undefined;
}

export interface DoctorInput {
  cliVersion: string;
  daemon: {
    running: boolean;
    version?: string | undefined;
    arm?: string | null | undefined;
    /** The address the daemon listens on. */
    listen?: string | undefined;
    /** The hold mode for servers with none of their own: "never" is what `sayagain up` writes. */
    holdDefault?: string | null | undefined;
  };
  hosts: DoctorHost[];
  servers: DoctorServer[];
  /** Calls recorded in the last seven days, and how many each server contributed. */
  ledger: { total: number; byServer: Record<string, number> };
  /** Calls waiting for a decision right now. */
  holds?: DoctorHold[];
  /** Whether the class tables were gathered at all (--no-probe, or no daemon to ask). */
  probed: boolean;
  /** The caller could not have probed (the daemon reporting on itself): no note about it. */
  probeNotApplicable?: boolean;
  launcherCaveat?: string | undefined;
  hostRunning?: boolean;
  now?: number;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** Verb agreement, so a finding about a single tool still reads like a sentence. */
const agree = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const list = (xs: string[], cap = 4): string =>
  xs.length <= cap ? xs.join(", ") : `${xs.slice(0, cap).join(", ")} and ${xs.length - cap} more`;

const ORDER: Record<Severity, number> = { error: 0, warning: 1, note: 2, ok: 3 };
const DAY = 86_400_000;

/** The whole check. Findings are gathered by area, then ordered by severity, most serious first. */
export function doctorFindings(input: DoctorInput): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);
  const now = input.now ?? Date.now();

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
    if (
      input.daemon.listen &&
      !/^(127\.0\.0\.1|\[?::1\]?|localhost)(:|$)/.test(input.daemon.listen)
    )
      add({
        severity: "warning",
        title: `the daemon listens on ${input.daemon.listen}, which is not loopback`,
        detail:
          "every process that can reach that address and holds the token can approve a held call.",
        fix: "sayagain stop && sayagain serve --listen 127.0.0.1:7777 --detach",
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
  if (input.daemon.holdDefault === "never")
    add({
      severity: "note",
      title: "holds are off: no call waits for a decision",
      detail:
        "sayagain up starts this way, so a fresh install observes first. Destructive calls and writes with an unknown outcome go through; a write the boundary can read back is still read back. Turn holds on once the page has shown you what the boundary sees.",
      fix: "sayagain up --hold",
    });

  if (input.launcherCaveat)
    add({
      severity: "warning",
      title: "the launcher is not the one hosts point at",
      detail: input.launcherCaveat,
    });

  // ---- hosts
  const files = input.hosts.filter((h) => h.exists);
  if (!files.length)
    add({
      severity: "note",
      title: "no host configuration file was found",
      detail: "nothing on this machine is configured to use MCP servers yet.",
      fix: "sayagain hosts",
    });
  if (!input.servers.length)
    add({
      severity: files.length ? "warning" : "note",
      title: "no server is registered",
      detail: "the boundary has nothing to sit in front of.",
      fix: "sayagain import --host all --rewrite",
    });

  for (const h of files)
    if (h.error)
      add({
        severity: "warning",
        title: `${h.label} (${h.scope}) could not be read`,
        detail: `${h.file}: ${h.error}`,
      });

  // Local scope has one target per project directory, and a machine can hold dozens of them; one
  // finding per host and scope says the same thing without burying everything else.
  const groups = new Map<string, DoctorHost[]>();
  for (const h of files.filter((x) => !x.error && x.servers.length > x.wrapped.length))
    groups.set(`${h.host}|${h.scope}`, [...(groups.get(`${h.host}|${h.scope}`) ?? []), h]);
  for (const [key, group] of groups) {
    const [host = "", scope = ""] = key.split("|");
    const first = group[0] as DoctorHost;
    const direct = [
      ...new Set(group.flatMap((h) => h.servers.filter((s) => !h.wrapped.includes(s)))),
    ];
    const where =
      group.length > 1 ? `${scope}, ${plural(group.length, "project")}` : (first.project ?? scope);
    add({
      severity: "warning",
      title: `${first.label} (${where}) ${agree(direct.length, "calls a server", "calls servers")} directly: ${list(direct)}`,
      detail:
        "their calls never reach the boundary, so they are absent from the ledger and every report.",
      fix: `sayagain import --host ${host}${scope === "project" ? " --project" : ""} --rewrite`,
    });
  }

  const anyWrapped = files.some((h) => h.wrapped.length > 0);
  if (files.length && input.servers.length && !anyWrapped)
    add({
      severity: "error",
      title: "no host routes any server through Say Again",
      detail: "nothing is being recorded.",
      fix: "sayagain import --host all --rewrite",
    });

  // A server configured in one project only is not bypassing the boundary, but it is unavailable
  // and unrecorded everywhere else, which is rarely what the operator meant.
  for (const h of files.filter((f) => f.scope !== "user"))
    for (const name of h.wrapped) {
      const sameHostUser = files.find((u) => u.host === h.host && u.scope === "user");
      if (sameHostUser && !sameHostUser.servers.includes(name))
        add({
          severity: "note",
          title: `${name} is configured in ${h.project ?? h.scope} only`,
          detail: `${h.label} has no entry for it anywhere else, so work in another directory cannot call it and nothing of it is recorded there.`,
          fix: `sayagain install --host ${h.host} ${name}`,
        });
    }

  // ---- servers
  for (const s of input.servers) {
    if (s.transport === "stdio" && s.cwd === undefined && s.projectOrigins.length) {
      const command = [s.command, ...(s.args ?? [])].filter(Boolean).join(" ");
      add({
        severity: "warning",
        title: `${s.name} runs without a working directory`,
        detail:
          "the host started it inside a project; the daemon starts it from its own directory, so a server that finds its project by the current directory will not find it.",
        ...(command
          ? { fix: `sayagain add ${s.name} --cwd ${s.projectOrigins[0]} -- ${command}` }
          : {}),
      });
    }

    if (s.unresolvedRefs?.length)
      add({
        severity: "warning",
        title: `${s.name} needs ${list(s.unresolvedRefs)} from the daemon's environment`,
        detail:
          "the daemon inherits the shell that started it; an unset reference resolves to empty, and the server answers as though the credential were wrong.",
        fix: `export ${s.unresolvedRefs[0]}=... && sayagain stop && sayagain serve --detach`,
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
    if (!total) {
      add({
        severity: "warning",
        title: `${s.name} listed no tools`,
        detail: "the upstream started and answered, but it offers nothing to call.",
      });
      continue;
    }

    if (c.fallback === total)
      add({
        severity: "warning",
        title: `${s.name} declares no annotations on any of its ${plural(total, "tool")}`,
        detail: `every call takes the cautious fallback, so none is retried after a retryable failure, and reads counted as writes dilute M9: the report shows less risk than there is.`,
        fix: `sayagain classes ${s.name} --suggest`,
      });
    else if (c.fallback)
      add({
        severity: "note",
        title: `${plural(c.fallback, "tool")} of ${s.name} ${agree(c.fallback, "takes", "take")} the cautious fallback`,
        detail: "no retry after a retryable failure, and a write in the report's counts.",
        fix: `sayagain classes ${s.name} --suggest`,
      });

    const held = c.rows.filter((r) => r.toolClass === "destructive");
    const heldReads = held.filter((r) => r.suggestion?.direction === "lower");
    if (heldReads.length)
      add({
        severity: "warning",
        title: `${plural(heldReads.length, "tool")} of ${s.name} ${agree(heldReads.length, "is", "are")} held on every call although the name reads like a read`,
        detail: `${list(heldReads.map((r) => r.tool))}: each waits for an approval before it leaves.`,
        fix: `sayagain classes ${s.name} --suggest`,
      });
    else if (held.length > total / 2)
      add({
        severity: "note",
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

  if (!input.probed && !input.probeNotApplicable && input.servers.length)
    add({
      severity: "note",
      title: "tool classes were not checked",
      detail: "the upstreams were not started, so nothing here says how their tools are classed.",
      fix: "sayagain classes --all",
    });

  // ---- calls waiting on a person: the north-star metric sitting in the operator's own queue
  const waiting = (input.holds ?? []).filter((h) => !h.decision);
  if (waiting.length) {
    const oldest = Math.min(...waiting.map((h) => h.createdAt));
    const days = Math.floor((now - oldest) / DAY);
    const orphaned = waiting.filter((h) => h.orphaned).length;
    add({
      severity: days >= 1 ? "warning" : "note",
      title: `${plural(waiting.length, "call")} ${agree(waiting.length, "is", "are")} waiting for a decision`,
      detail: `${list(waiting.map((h) => h.tool))}${days >= 1 ? `; the oldest has waited ${plural(days, "day")}` : ""}${orphaned ? `, and ${orphaned} lost the host that asked` : ""}. Until they are decided, their writes have no known outcome.`,
      fix: "sayagain holds",
    });
  }

  // ---- traffic
  if (input.daemon.running && anyWrapped) {
    if (!input.ledger.total)
      add({
        severity: "note",
        title: "no calls recorded in the last seven days",
        detail: "a host that was already running keeps its old server processes; restart it.",
      });
    else {
      const silent = input.servers
        .filter((s) => !(input.ledger.byServer[s.name] ?? 0))
        .map((s) => s.name);
      if (silent.length)
        add({
          severity: "note",
          title: `no calls recorded for ${list(silent)}`,
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

  // Stable within a severity, so each area keeps the order it was gathered in.
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => ORDER[a.f.severity] - ORDER[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}

const MARK: Record<Severity, string> = {
  error: "error  ",
  warning: "warning",
  note: "note   ",
  ok: "ok     ",
};

export function renderDoctor(findings: Finding[]): string {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${MARK[f.severity]}  ${f.title}`);
    if (f.detail) lines.push(`           ${f.detail}`);
    if (f.fix) lines.push(`           fix: ${f.fix}`);
  }
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const errors = count("error");
  const warnings = count("warning");
  const notes = count("note");
  lines.push("");
  lines.push(
    errors || warnings
      ? `${plural(errors, "error")}, ${plural(warnings, "warning")}, ${plural(notes, "note")}; most serious first.`
      : notes
        ? `nothing is broken; ${plural(notes, "note")} worth reading.`
        : "nothing to fix.",
  );
  return `${lines.join("\n")}\n`;
}
