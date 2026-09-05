/**
 * The operator's page. Plain DOM, one module, no framework: tables, a live
 * holds inbox, and buttons that POST with the bearer token. The token comes
 * in on the query string once and lives in sessionStorage from then on.
 */

export {};

type Json = Record<string, unknown>;

const params = new URLSearchParams(location.search);
const queryToken = params.get("token");
if (queryToken) {
  sessionStorage.setItem("sayagain.token", queryToken);
  history.replaceState(null, "", location.pathname + location.hash);
}
const token = sessionStorage.getItem("sayagain.token") ?? "";
const NO_TOKEN = "this tab has no token: run `sayagain ui` to open the page with one";

const $ = (sel: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    $("#status").textContent = token
      ? "not authorised: the daemon's token changed; run `sayagain ui` again"
      : NO_TOKEN;
    throw new Error("401");
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const fmtWhen = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};
const report = (err: unknown): void => {
  $("#status").textContent = err instanceof Error ? err.message : String(err);
};
const kib = (n: number): string =>
  n < 1024 ? `${Math.round(n)} B` : `${(n / 1024).toFixed(1)} KiB`;
const table = (head: string[], rows: string[][]): string =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

// ---------------------------------------------------------------- screens

interface Hold {
  receipt: string;
  tool: string;
  toolClass: string;
  reason: string;
  intent?: string;
  arguments: unknown;
  createdAt: string;
  expiresAt: string;
  server?: string;
  mode?: string;
  orphaned?: boolean;
}

async function renderHolds(): Promise<void> {
  const holds = await api<Hold[]>("/api/holds");
  const el = $("#holds");
  if (!holds.length) {
    el.innerHTML = `<p class="empty">No held calls. Destructive calls stop here until you decide.</p>`;
    return;
  }
  el.innerHTML = holds
    .map(
      (
        h,
      ) => `<article class="hold${h.orphaned ? " orphaned" : ""}" data-receipt="${esc(h.receipt)}">
  <header><strong>${esc(h.server ?? "")}/${esc(h.tool)}</strong> <span class="pill">${esc(h.toolClass)}</span> <span class="pill">${esc(h.mode ?? "pre")}</span> <time>${esc(fmtWhen(h.createdAt))} · expires ${esc(fmtWhen(h.expiresAt))}</time></header>
  <p>${esc(h.reason)}${h.orphaned ? " · from before a restart: the host is gone; approving runs it for the ledger" : ""}</p>
  ${h.intent ? `<p class="intent">intent: ${esc(h.intent)}</p>` : ""}
  <pre>${esc(JSON.stringify(h.arguments, null, 2))}</pre>
  <footer><button data-decide="approve">Approve</button> <button data-decide="reject" class="secondary">Reject</button> <code>${esc(h.receipt)}</code></footer>
</article>`,
    )
    .join("");
}

interface ServerRow {
  name: string;
  transport: string;
  target: string;
  started: boolean;
  upstream: string | null;
  ready: boolean;
  sessions: number;
  url: string;
}

async function renderServers(): Promise<void> {
  const [servers, health] = await Promise.all([
    api<ServerRow[]>("/api/servers"),
    api<Json>("/api/health"),
  ]);
  $("#servers").innerHTML =
    `<p>daemon ${esc(health.version)} · pid ${esc(health.pid)} · store ${esc(health.ledger)} · spans ${health.otlp ? `to ${esc(health.otlp)}` : "not exported"}</p>` +
    table(
      ["server", "transport", "target", "state", "sessions", "url"],
      servers.map((s) => [
        esc(s.name),
        esc(s.transport),
        `<code>${esc(s.target)}</code>`,
        s.started ? (s.ready ? `ready (${esc(s.upstream)})` : "starting") : "idle",
        String(s.sessions),
        `<code>${esc(s.url)}</code>`,
      ]),
    );
}

interface DeadLetter {
  receipt: string;
  ts: string;
  upstream: string;
  tool: string;
  errorClass: string;
  errorSignature: string;
  attempts: number;
  repairs: number;
  intent?: string;
}

async function renderDeadLetters(): Promise<void> {
  const rows = await api<DeadLetter[]>("/api/deadletters");
  const el = $("#deadletters");
  if (!rows.length) {
    el.innerHTML = `<p class="empty">No dead letters.</p>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (d) => `<article class="dead" data-receipt="${esc(d.receipt)}">
  <header><strong>${esc(d.upstream)}/${esc(d.tool)}</strong> <span class="pill">${esc(d.errorClass)}</span> <time>${esc(fmtWhen(d.ts))}</time></header>
  <p>${esc(d.errorSignature)} · ${d.attempts} attempt(s), ${d.repairs} repair(s)</p>
  ${d.intent ? `<p class="intent">intent: ${esc(d.intent)}</p>` : ""}
  <footer><button data-replay>Replay</button> <input placeholder="edited arguments as JSON, optional" size="48"> <code>${esc(d.receipt)}</code></footer>
</article>`,
    )
    .join("");
}

interface LedgerRow {
  ts: string;
  receipt: string;
  upstream: string;
  tool: string;
  toolClass: string;
  status: string;
  isError: boolean;
  errorClass?: string;
  errorSignature?: string;
  latencyMs: number;
  held?: { mode: string; decision?: string; cancelled?: boolean };
  attempts?: number;
  repairs?: { path: string; rule: string }[];
  duplicateOf?: string;
  replayOf?: string;
}

let ledgerRows: LedgerRow[] = [];
async function loadLedger(): Promise<void> {
  ledgerRows = await api<LedgerRow[]>("/api/ledger?tail=200");
  renderLedger();
}
function renderLedger(): void {
  const rows = ledgerRows;
  const filter = ($("#ledger-filter") as HTMLInputElement).value.trim().toLowerCase();
  const shown = rows
    .filter(
      (r) =>
        !filter ||
        `${r.upstream}/${r.tool} ${r.status} ${r.errorClass ?? ""}`.toLowerCase().includes(filter),
    )
    .reverse();
  $("#ledger").innerHTML = table(
    ["when", "server/tool", "class", "status", "latency", "notes", "receipt"],
    shown.map((r) => [
      esc(fmtWhen(r.ts)),
      `${esc(r.upstream)}/${esc(r.tool)}`,
      esc(r.toolClass),
      `<span class="pill ${r.isError ? "bad" : ""}">${esc(r.status)}${r.isError ? ` · ${esc(r.errorClass ?? "error")}` : ""}</span>`,
      `${r.latencyMs} ms`,
      esc(
        [
          r.errorSignature,
          r.held
            ? `held (${r.held.mode}): ${r.held.cancelled ? "cancelled" : (r.held.decision ?? "undecided")}`
            : "",
          r.attempts ? `attempts ${r.attempts}` : "",
          r.repairs?.length
            ? `repaired ${r.repairs.map((x) => `${x.path} ${x.rule}`).join(", ")}`
            : "",
          r.duplicateOf ? `duplicate of ${r.duplicateOf}` : "",
          r.replayOf ? `replay of ${r.replayOf}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      `<code>${esc(r.receipt)}</code>`,
    ]),
  );
}

interface ToolStat {
  server: string;
  tool: string;
  calls: number;
  failureRatePct: number;
  misCallRatePct: number;
  retryRatePct: number;
  identicalRetryPct: number;
  medianCallsToRecover: number;
  unrecoveredPct: number;
  wasteBytesPer1kCalls: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  boundary: Record<string, number>;
}

const since = (): string => ($("#since") as HTMLSelectElement).value;

async function renderTools(): Promise<void> {
  const rows = await api<ToolStat[]>(`/api/tools?since=${since()}&minCalls=1`);
  $("#tools").innerHTML = rows.length
    ? table(
        [
          "server/tool",
          "calls",
          "fail %",
          "mis-call %",
          "retried %",
          "identical %",
          "calls to recover",
          "unrecovered %",
          "waste / 1K calls",
          "p50",
          "p95",
          "boundary",
        ],
        rows.map((t) => [
          `${esc(t.server)}/${esc(t.tool)}`,
          String(t.calls),
          String(t.failureRatePct),
          String(t.misCallRatePct),
          String(t.retryRatePct),
          String(t.identicalRetryPct),
          String(t.medianCallsToRecover),
          String(t.unrecoveredPct),
          kib(t.wasteBytesPer1kCalls),
          `${t.p50LatencyMs} ms`,
          `${t.p95LatencyMs} ms`,
          esc(
            Object.entries(t.boundary)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k} ${v}`)
              .join(", "),
          ),
        ]),
      )
    : `<p class="empty">No calls in this window.</p>`;
}

interface SignatureStat {
  server: string;
  tool: string;
  signature: string;
  errorClass: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  medianCallsToRecover: number;
  unrecovered: number;
  wasteBytes: number;
  topRecoveryPath?: string;
  topShapeChange?: string;
  suggestion: string;
}

async function renderErrors(): Promise<void> {
  const rows = await api<SignatureStat[]>(`/api/errors?since=${since()}`);
  $("#errors").innerHTML = rows.length
    ? rows
        .map(
          (x) => `<article class="sig">
  <header><strong>${esc(x.server)}/${esc(x.tool)}</strong> <span class="pill">${esc(x.errorClass)}</span> ×${x.count} · median ${x.medianCallsToRecover} calls to recover · ${x.unrecovered} unrecovered · ${esc(kib(x.wasteBytes))} · ${esc(fmtWhen(x.firstSeen))} to ${esc(fmtWhen(x.lastSeen))}</header>
  <pre>${esc(x.signature)}</pre>
  ${x.topRecoveryPath ? `<p>recovery path: <code>${esc(x.topRecoveryPath)}</code></p>` : ""}
  ${x.topShapeChange ? `<p>shape change: <code>${esc(x.topShapeChange)}</code></p>` : ""}
  <p class="suggestion">${esc(x.suggestion)}</p>
</article>`,
        )
        .join("")
    : `<p class="empty">No failures in this window.</p>`;
}

async function renderReport(): Promise<void> {
  const r = await api<Json>(`/api/report?since=${since()}`);
  const ns = r.northStar as {
    failureTaxBytesPer1kCalls: number;
    unacknowledgedWritesPer1kWrites: number;
  };
  const b = r.boundary as Json;
  const held = b.held as Json;
  const rec = r.recovery as Json;
  const prev = r.previous as Json | undefined;
  const byServer = r.byServer as {
    server: string;
    calls: number;
    failureRatePct: number;
    addressablePct: number;
  }[];
  const sigs = r.topSignatures as SignatureStat[];
  $("#report").innerHTML = `
<section class="cards">
  <div class="card"><h3>unacknowledged writes</h3><p class="big">${esc(ns.unacknowledgedWritesPer1kWrites)}</p><p>per 1K writes without a known outcome</p></div>
  <div class="card"><h3>failure tax</h3><p class="big">${esc(kib(ns.failureTaxBytesPer1kCalls))}</p><p>recovery traffic per 1K calls${prev ? ` · was ${esc(kib(prev.failureTaxBytesPer1kCalls as number))}` : ""}</p></div>
  <div class="card"><h3>calls</h3><p class="big">${esc(r.calls)}</p><p>${esc(r.writes)} writes${prev ? ` · was ${esc(prev.calls)}` : ""}</p></div>
  <div class="card"><h3>the boundary</h3><p>retry ${esc(b.retriesResolved)} · repair ${esc(b.repairsResolved)} · held ✓${esc(held.approved)} ✗${esc(held.rejected)} ?${esc(held.undecided)} · dead ${esc(b.deadLettered)} · dedup ${esc(b.deduplicated)}</p></div>
</section>
<h3>By server</h3>
${table(
  ["server", "calls", "fail %", "addressable %"],
  byServer.map((s) => [
    esc(s.server),
    String(s.calls),
    String(s.failureRatePct),
    String(s.addressablePct),
  ]),
)}
<h3>Recovery</h3>
<p>${esc(rec.failures)} failures, ${esc(rec.recovered)} recovered · retried ${esc(rec.retryRatePct)}% (identical ${esc(rec.identicalRetryPct)}%) · median ${esc(rec.medianCalls)} calls, ${esc(kib(rec.medianBytes as number))}</p>
<h3>Top signatures</h3>
${
  sigs.length
    ? sigs
        .map(
          (x) =>
            `<p><strong>${esc(x.server)}/${esc(x.tool)}</strong> ×${x.count} ${esc(x.errorClass)}: <code>${esc(x.signature)}</code></p>`,
        )
        .join("")
    : `<p class="empty">none</p>`
}`;
}

interface Intervention {
  id: string;
  kind: "coerce" | "hint";
  server: string;
  tool: string;
  signature: string;
  path?: string;
  rule?: string;
  fact?: string;
  evidence: number;
  activatedAt: string;
  state: "active" | "disabled" | "reverted";
  mode?: "advise" | "apply";
  reason?: string;
  before?: { calls: number; failureRatePct: number; medianCallsToRecover: number };
  after?: { calls: number; failureRatePct: number; medianCallsToRecover: number };
}

async function renderLearn(): Promise<void> {
  const { updatedAt, interventions } = await api<{
    updatedAt: string;
    interventions: Intervention[];
  }>("/api/learn");
  const el = $("#learn");
  if (!interventions.length) {
    el.innerHTML = `<p class="empty">Nothing learned yet. The loop needs a signature seen at least three times with a recovery that changed the arguments or called another tool first. Last pass: ${esc(fmtWhen(updatedAt))}.</p>`;
    return;
  }
  const lift = (i: Intervention) =>
    i.after
      ? `${esc(i.before?.failureRatePct ?? "?")}% fail (${esc(i.before?.calls ?? 0)} calls) &rarr; ${esc(i.after.failureRatePct)}% (${esc(i.after.calls)} calls)`
      : "not measured yet";
  el.innerHTML =
    `<p class="empty">Last pass: ${esc(fmtWhen(updatedAt))}. An intervention reverts itself after 20 calls without a lower failure rate.</p>` +
    interventions
      .map(
        (i) => `<article class="learned ${esc(i.state)}" data-id="${esc(i.id)}">
  <header><strong>${esc(i.server)}/${esc(i.tool)}</strong> <span class="pill">${esc(i.kind)}</span> <span class="pill ${i.state === "active" ? "" : "bad"}">${esc(i.state)}</span>${i.kind === "coerce" ? ` <span class="pill" title="${i.mode === "apply" ? "changes read-only calls before they leave, and repairs after a failure" : "offered as a repair after a failure; never changes a call before it leaves"}">mode ${i.mode === "apply" ? "apply" : "advise"}</span>` : ""} <time>${esc(i.evidence)} occurrences</time></header>
  <p>${esc(i.kind === "coerce" ? `${i.rule} on ${i.path}` : (i.fact ?? ""))}</p>
  <pre>${esc(i.signature)}</pre>
  <p class="suggestion">${lift(i)}${i.reason ? ` &middot; ${esc(i.reason)}` : ""}</p>
  <footer>${i.state === "active" ? `<button data-learn="disable" class="secondary">Turn off</button>` : `<button data-learn="enable">Turn on</button>`}${i.kind === "coerce" && i.state === "active" ? (i.mode === "apply" ? ` <button data-learn="advise" class="secondary">Switch to advise</button>` : ` <button data-learn="apply" class="secondary">Switch to apply</button>`) : ""} <code>${esc(i.id)}</code></footer>
</article>`,
      )
      .join("");
}

// ---------------------------------------------------------------- wiring

const screens: Record<string, () => Promise<void>> = {
  holds: renderHolds,
  servers: renderServers,
  deadletters: renderDeadLetters,
  ledger: loadLedger,
  tools: renderTools,
  errors: renderErrors,
  report: renderReport,
  learn: renderLearn,
};

let current = location.hash.slice(1) || "holds";
async function show(name: string): Promise<void> {
  const screen = Object.hasOwn(screens, name) ? name : "holds";
  current = screen;
  $("#window").hidden = !["tools", "errors", "report"].includes(screen);
  for (const a of document.querySelectorAll<HTMLAnchorElement>("nav a"))
    a.classList.toggle("active", a.dataset.screen === screen);
  for (const s of document.querySelectorAll<HTMLElement>("main > section"))
    s.hidden = s.id !== `screen-${screen}`;
  $("#status").textContent = token ? "" : NO_TOKEN;
  if (!token) return;
  try {
    await screens[screen]?.();
  } catch (err) {
    report(err);
  }
}

/** Disable a button while its request is in flight, so a second click cannot send it twice. */
async function busy(button: HTMLElement, work: () => Promise<unknown>): Promise<void> {
  const b = button as HTMLButtonElement;
  b.disabled = true;
  try {
    await work();
  } catch (err) {
    report(err);
  } finally {
    b.disabled = false;
  }
}

document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const decide = t.closest<HTMLElement>("[data-decide]");
  if (decide) {
    const receipt = decide.closest<HTMLElement>("[data-receipt]")?.dataset.receipt ?? "";
    const decision = decide.dataset.decide === "reject" ? "reject" : "approve";
    void busy(decide, () =>
      api(`/api/holds/${encodeURIComponent(receipt)}/${decision}`, { method: "POST" }).then(() =>
        renderHolds(),
      ),
    );
    return;
  }
  const replay = t.closest<HTMLElement>("[data-replay]");
  if (replay) {
    const box = replay.closest<HTMLElement>("[data-receipt]");
    const receipt = box?.dataset.receipt ?? "";
    const raw = box?.querySelector("input")?.value.trim();
    let body = "{}";
    if (raw) {
      try {
        body = JSON.stringify({ arguments: JSON.parse(raw) });
      } catch {
        $("#status").textContent = "edited arguments must be JSON";
        return;
      }
    }
    void busy(replay, () =>
      api<{ isError: boolean; text: string }>(`/api/replay/${encodeURIComponent(receipt)}`, {
        method: "POST",
        body,
      }).then((o) => {
        $("#status").textContent = `replay ${o.isError ? "failed" : "succeeded"}: ${o.text}`;
        return renderDeadLetters();
      }),
    );
    return;
  }
  const learn = t.closest<HTMLElement>("[data-learn]");
  if (learn) {
    const id = learn.closest<HTMLElement>("[data-id]")?.dataset.id ?? "";
    const wanted = learn.dataset.learn ?? "";
    const action = ["enable", "apply", "advise"].includes(wanted) ? wanted : "disable";
    void busy(learn, () =>
      api(`/api/learn/${encodeURIComponent(id)}/${action}`, { method: "POST" }).then(() =>
        renderLearn(),
      ),
    );
    return;
  }
  if (t.id === "learn-update") {
    void busy(t, () => api("/api/learn/update", { method: "POST" }).then(() => renderLearn()));
    return;
  }
  const nav = t.closest<HTMLAnchorElement>("nav a[data-screen]");
  if (nav) {
    ev.preventDefault();
    location.hash = nav.dataset.screen ?? "holds";
  }
});
window.addEventListener("hashchange", () => void show(location.hash.slice(1)));
$("#since").addEventListener("change", () => void show(current));
$("#ledger-filter").addEventListener("input", () => renderLedger());
$("#refresh").addEventListener("click", () => void show(current));

// Live updates: EventSource cannot set headers, so this one GET carries the token on the query
// string, which the daemon accepts for streams only.
const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
for (const name of ["hold", "hold-decided", "hold-resumed"])
  events.addEventListener(name, () => void (current === "holds" && renderHolds()));
events.addEventListener(
  "dead-letter",
  () => void (current === "deadletters" && renderDeadLetters()),
);
events.addEventListener("row", () => void (current === "ledger" && loadLedger().catch(report)));
events.addEventListener("learned", () => void (current === "learn" && renderLearn().catch(report)));
events.onerror = () => {
  // The browser reconnects on its own after a dropped connection, but not after a refused one.
  $("#status").textContent =
    events.readyState === EventSource.CLOSED
      ? token
        ? "live updates stopped: the daemon refused the token; run `sayagain ui` again"
        : NO_TOKEN
      : "event stream disconnected; reconnecting";
};
events.onopen = () => {
  if ($("#status").textContent?.includes("reconnecting")) $("#status").textContent = "";
};

void show(current);
