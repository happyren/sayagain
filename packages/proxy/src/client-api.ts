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
import { type DaemonInfo, daemonBaseUrl, readDaemonInfo } from "./registry.js";
import { daemonHealthy } from "./shim.js";

export async function daemonFetch(
  info: DaemonInfo,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${daemonBaseUrl(info)}${path}`, {
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

/** Every daemon ledger row at or after `since`, or null when no daemon is live. */
export async function daemonLedgerSince(since: Date): Promise<LedgerRow[] | null> {
  const d = await liveDaemon();
  if (!d) return null;
  return (await (
    await daemonFetch(d, `/api/ledger?since=${encodeURIComponent(since.toISOString())}`)
  ).json()) as LedgerRow[];
}

/** A tools/list from the daemon's boundary for a registered server, or null when no daemon is live. */
export async function daemonToolsList(name: string): Promise<unknown[] | null> {
  const d = await liveDaemon();
  if (!d) return null;
  const res = await daemonFetch(d, `/mcp/${encodeURIComponent(name)}`, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "lint",
      method: "tools/list",
      params: { _meta: { "sh.sayagain/plain": true } },
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string | { message?: string } };
    const detail =
      typeof body.error === "object" && body.error
        ? (body.error.message ?? "")
        : (body.error ?? "");
    throw new Error(`daemon answered ${res.status} for ${name}: ${detail}`);
  }
  const msg = (await res.json()) as {
    result?: { tools?: unknown[] };
    error?: { message?: string };
  };
  if (msg.error) throw new Error(msg.error.message ?? "tools/list failed");
  return msg.result?.tools ?? [];
}

/** The daemon's learning-loop state, or null when no daemon is live. */
export async function daemonLearn(
  action?: { update: true; minEvidence?: number } | { id: string; state: "disable" | "enable" },
): Promise<{ updatedAt: string; interventions: unknown[] } | { id: string; state: string } | null> {
  const d = await liveDaemon();
  if (!d) return null;
  const parse = async (res: Response): Promise<unknown> => {
    if (!res.ok)
      throw new Error(
        ((await res.json().catch(() => ({}))) as { error?: string }).error ??
          `daemon answered ${res.status}`,
      );
    return res.json();
  };
  if (!action)
    return (await parse(await daemonFetch(d, "/api/learn"))) as {
      updatedAt: string;
      interventions: unknown[];
    };
  if (!("id" in action)) {
    const query = action.minEvidence !== undefined ? `?minEvidence=${action.minEvidence}` : "";
    return (await parse(await daemonFetch(d, `/api/learn/update${query}`, { method: "POST" }))) as {
      updatedAt: string;
      interventions: unknown[];
    };
  }
  return (await parse(
    await daemonFetch(d, `/api/learn/${encodeURIComponent(action.id)}/${action.state}`, {
      method: "POST",
    }),
  )) as { id: string; state: string };
}

/** The daemon's tool definition report for a server, or null when no daemon is live. */
export async function daemonLearnReport(server: string): Promise<string | null> {
  const d = await liveDaemon();
  if (!d) return null;
  const res = await daemonFetch(d, `/api/learn/report/${encodeURIComponent(server)}`);
  if (!res.ok) throw new Error(`daemon answered ${res.status} for the report`);
  return res.text();
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
