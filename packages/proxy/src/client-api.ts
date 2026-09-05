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
import { type DaemonInfo, readDaemonInfo } from "./registry.js";
import { daemonHealthy } from "./shim.js";

async function daemonFetch(
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

export async function daemonStatus(): Promise<{
  info: DaemonInfo;
  health: unknown;
  servers: unknown;
} | null> {
  const d = await liveDaemon();
  if (!d) return null;
  const health = await (await daemonFetch(d, "/api/health")).json();
  const servers = await (await daemonFetch(d, "/api/servers")).json();
  return { info: d, health, servers };
}

export async function stopDaemon(): Promise<boolean> {
  const d = await liveDaemon();
  if (!d) return false;
  await daemonFetch(d, "/api/shutdown", { method: "POST" }).catch(() => undefined);
  return true;
}
