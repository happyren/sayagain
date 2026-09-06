/**
 * The page's first screen: is it working, what did the boundary do, what should the operator do
 * next. Everything here exists elsewhere already (the servers, the ledger, the holds, the doctor);
 * this composes it so a person who just ran `sayagain up` can answer those three questions in a
 * minute, without reading a table they do not yet know how to read.
 */
import { finalRows } from "./analysis.js";
import { type DoctorHost, doctorFindings, type Finding } from "./doctor.js";
import { HOSTS, hostFiles, type Scope } from "./hosts.js";
import { launcherCaveat } from "./launcher.js";
import type { LedgerRow } from "./ledger.js";
import { inspectHost } from "./onboarding.js";
import { type Registry, unresolvedRefs } from "./registry.js";

/** Every host config file in these scopes, with what it names and what goes through Say Again. */
export function hostRowsFor(cwd: string, scopes: Scope[]): DoctorHost[] {
  return hostFiles(cwd, scopes).map((f) => {
    const base: DoctorHost = {
      label: HOSTS[f.host].label,
      host: f.host,
      scope: f.scope,
      file: f.file,
      project: f.project,
      exists: f.exists,
      servers: [],
      wrapped: [],
      error: undefined,
    };
    if (!f.exists) return base;
    try {
      return { ...base, ...inspectHost(f) };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export interface OverviewServer {
  name: string;
  transport: string;
  /** Whether the daemon has started this upstream, and whether it answered initialize. */
  started: boolean;
  ready: boolean;
  upstream: string | null;
  sessions: number;
  /** In the window: calls the boundary recorded, how many failed, how many are waiting now. */
  calls: number;
  failures: number;
  held: number;
  lastSeen: string | null;
}

export interface Overview {
  generatedAt: string;
  window: { days: number; since: string };
  daemon: {
    version: string;
    startedAt: string;
    listen: string;
    arm: string | null;
    /** The hold mode servers without one of their own use; "never" is what `sayagain up` writes. */
    hold: string;
  };
  servers: OverviewServer[];
  /** Calls the boundary recorded in the window, over every server. */
  calls: number;
  /** The doctor's findings, most serious first, each with the command that fixes it. */
  doctor: Finding[];
}

export interface OverviewInput {
  registry: Registry;
  version: string;
  listen: string;
  arm: string | null;
  startedAt: string;
  /** Ledger rows in the window; attempts, holds and read-backs are folded per call here. */
  rows: LedgerRow[];
  /** What the daemon knows about each started upstream. */
  live: Record<string, { ready: boolean; upstream: string | null; sessions: number }>;
  holds: {
    receipt: string;
    tool: string;
    server?: string | undefined;
    createdAt: number;
    orphaned?: boolean | undefined;
  }[];
  cwd: string;
  now?: number;
  days?: number;
}

export function overviewFor(input: OverviewInput): Overview {
  const now = input.now ?? Date.now();
  const days = input.days ?? 7;
  const since = new Date(now - days * 86_400_000).toISOString();
  const byServer = new Map<string, { calls: number; failures: number; lastSeen: string | null }>();
  // The same rows the report counts: one per call, the last word on it, no read-backs or replays.
  for (const row of finalRows(input.rows)) {
    const key = row.server ?? row.upstream;
    const s = byServer.get(key) ?? { calls: 0, failures: 0, lastSeen: null };
    s.calls++;
    if (row.isError) s.failures++;
    if (s.lastSeen === null || row.ts > s.lastSeen) s.lastSeen = row.ts;
    byServer.set(key, s);
  }
  const heldBy = new Map<string, number>();
  for (const h of input.holds) if (h.server) heldBy.set(h.server, (heldBy.get(h.server) ?? 0) + 1);
  const servers: OverviewServer[] = Object.entries(input.registry.servers).map(([name, cfg]) => {
    const live = input.live[name];
    const stats = byServer.get(name) ?? { calls: 0, failures: 0, lastSeen: null };
    return {
      name,
      transport: cfg.transport,
      started: live !== undefined,
      ready: live?.ready ?? false,
      upstream: live?.upstream ?? null,
      sessions: live?.sessions ?? 0,
      calls: stats.calls,
      failures: stats.failures,
      held: heldBy.get(name) ?? 0,
      lastSeen: stats.lastSeen,
    };
  });
  const hold = input.registry.daemon?.hold ?? "destructive";
  const ledgerByServer: Record<string, number> = {};
  let total = 0;
  for (const [name, s] of byServer) {
    ledgerByServer[name] = s.calls;
    total += s.calls;
  }
  const caveat = launcherCaveat();
  const doctor = doctorFindings({
    cliVersion: input.version,
    daemon: {
      running: true,
      version: input.version,
      arm: input.arm,
      listen: input.listen,
      holdDefault: hold,
    },
    hosts: hostRowsFor(input.cwd, ["user", "local"]),
    servers: Object.entries(input.registry.servers).map(([name, cfg]) => ({
      name,
      transport: cfg.transport,
      cwd: cfg.cwd,
      command: cfg.command,
      args: cfg.args,
      projectOrigins: [
        ...new Set(
          Object.values(cfg.origins ?? {})
            .map((o) => o.project)
            .filter((p): p is string => typeof p === "string"),
        ),
      ],
      unresolvedRefs: [...new Set([...unresolvedRefs(cfg.env), ...unresolvedRefs(cfg.headers)])],
    })),
    ledger: { total, byServer: ledgerByServer },
    holds: input.holds.map((h) => ({
      receipt: h.receipt,
      tool: h.tool,
      createdAt: h.createdAt,
      orphaned: h.orphaned,
    })),
    // The daemon does not start its own upstreams to ask for their tools; `sayagain doctor` does.
    probed: false,
    ...(caveat ? { launcherCaveat: caveat } : {}),
    now,
  });
  return {
    generatedAt: new Date(now).toISOString(),
    window: { days, since },
    daemon: {
      version: input.version,
      startedAt: input.startedAt,
      listen: input.listen,
      arm: input.arm,
      hold,
    },
    servers,
    calls: total,
    doctor,
  };
}
