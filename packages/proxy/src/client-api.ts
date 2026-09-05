/** The CLI's view of a running daemon, with the per-process sockets of `wrap` as the fallback. */
import {
  type DeadLetterSummary,
  decideEverywhere,
  type HoldSummary,
  listAllDeadLetters,
  listAllHolds,
  type ReplayOutcome,
  replayEverywhere,
} from "./control.js";
import type { Decision } from "./holds.js";
import type { LedgerRow } from "./ledger.js";
import { type DaemonInfo, readDaemonInfo } from "./registry.js";
import { daemonHealthy } from "./shim.js";

export async function daemonFetch(
  info: DaemonInfo,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://${info.host}:${info.port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function liveDaemon(): Promise<DaemonInfo | null> {
  const info = readDaemonInfo();
  return info && (await daemonHealthy(info)) ? info : null;
}

export async function allHolds(): Promise<HoldSummary[]> {
  const out: HoldSummary[] = [];
  const d = await liveDaemon();
  if (d) out.push(...((await (await daemonFetch(d, "/api/holds")).json()) as HoldSummary[]));
  out.push(...(await listAllHolds()));
  return out;
}

export async function decideAnywhere(receipt: string, decision: Decision): Promise<boolean> {
  const d = await liveDaemon();
  if (d) {
    const r = (await (
      await daemonFetch(d, `/api/holds/${encodeURIComponent(receipt)}/${decision}`, {
        method: "POST",
      })
    ).json()) as { decided?: boolean };
    if (r.decided) return true;
  }
  return decideEverywhere(receipt, decision);
}

export async function allDeadLetters(): Promise<DeadLetterSummary[]> {
  const out: DeadLetterSummary[] = [];
  const d = await liveDaemon();
  if (d)
    out.push(...((await (await daemonFetch(d, "/api/deadletters")).json()) as DeadLetterSummary[]));
  out.push(...(await listAllDeadLetters()));
  return out;
}

export async function replayAnywhere(
  receipt: string,
  args: unknown,
): Promise<ReplayOutcome | null> {
  const d = await liveDaemon();
  if (d) {
    const res = await daemonFetch(d, `/api/replay/${encodeURIComponent(receipt)}`, {
      method: "POST",
      body: JSON.stringify(args === undefined ? {} : { arguments: args }),
    });
    if (res.ok) {
      const r = (await res.json()) as ReplayOutcome | { error: string };
      if (!("error" in r)) return r;
    }
  }
  return replayEverywhere(receipt, args);
}

/** The daemon's ledger tail, or null when no daemon is live. */
export async function daemonLedger(tail: number): Promise<LedgerRow[] | null> {
  const d = await liveDaemon();
  if (!d) return null;
  return (await (
    await daemonFetch(d, `/api/ledger?tail=${Math.max(0, Math.floor(tail))}`)
  ).json()) as LedgerRow[];
}

export interface ServerStatus {
  name: string;
  transport: string;
  target: string;
  started: boolean;
  upstream: string | null;
  ready: boolean;
  sessions: number;
  url: string;
}

export async function daemonStatus(): Promise<{
  info: DaemonInfo;
  health: Record<string, unknown>;
  servers: ServerStatus[];
} | null> {
  const d = await liveDaemon();
  if (!d) return null;
  const health = (await (await daemonFetch(d, "/api/health")).json()) as Record<string, unknown>;
  const servers = (await (await daemonFetch(d, "/api/servers")).json()) as ServerStatus[];
  return { info: d, health, servers };
}

/** Ask the daemon to shut down and wait (bounded) until it no longer answers. */
export async function stopDaemon(timeoutMs = 8000): Promise<boolean> {
  const d = await liveDaemon();
  if (!d) return false;
  await daemonFetch(d, "/api/shutdown", { method: "POST" }).catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const info = readDaemonInfo();
    if (!info || info.pid !== d.pid) return true;
    if (!(await daemonHealthy(info, 500))) return true;
  }
  return true;
}
