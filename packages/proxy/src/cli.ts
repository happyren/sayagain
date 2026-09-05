#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  allDeadLetters,
  allHolds,
  daemonLedger,
  daemonStatus,
  decideAnywhere,
  liveDaemon,
  replayAnywhere,
  stopDaemon,
} from "./client-api.js";
import { startDaemon } from "./daemon.js";
import { defaultDeadLetterPath, readDeadLetters } from "./deadletter.js";
import { defaultLedgerPath, JsonlLedger, readLedger } from "./ledger.js";
import { parseClassOverrides } from "./policy.js";
import {
  addServer,
  isValidServerName,
  loadOrCreateToken,
  loadRegistry,
  readDaemonInfo,
  removeDaemonInfo,
  removeServer,
  type ServerConfig,
  tokenPath,
} from "./registry.js";
import { daemonHealthy, runStdioShim, serveArgv, waitForDaemon } from "./shim.js";
import { openStores, type StoreKind } from "./stores.js";
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
  sayagain serve [--listen 127.0.0.1:7777] [--store jsonl|sqlite] [--db <path>] [--detach]
      Run the daemon: one virtual server per registered upstream at /mcp/<name>, plus the control API.
      The bearer token is in ~/.sayagain/token. SAYAGAIN_HOME moves every file elsewhere.
  sayagain add <name> [--url <url>] [--header k=v]... [--env K[=V]]... [--cwd <dir>] [--class t=c]... [--hold m] [-- <command> [args...]]
      Register an upstream (stdio command, or --url for Streamable HTTP). --env K alone stores "\${K}",
      resolved from the daemon's environment at spawn; so does a \${VAR} inside --header or --env values.
  sayagain remove <name> | sayagain list | sayagain status | sayagain stop
  sayagain stdio <name>
      Thin stdio client for hosts that only spawn commands; starts the daemon if needed.
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

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
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
    const { done } = wrap(wrapOptions);
    return done;
  }

  if (command === "serve") {
    const opts = [...rest];
    const listen = takeOption(opts, "--listen");
    const store = takeOption(opts, "--store");
    const db = takeOption(opts, "--db");
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
    if (listen !== undefined) daemonOptions.listen = listen;
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
    const replaced = addServer(name, config);
    process.stdout.write(`${replaced ? "replaced" : "registered"} ${name} (${config.transport})\n`);
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
      `daemon pid ${s.info.pid} at http://${s.info.host}:${s.info.port} since ${s.info.startedAt} (version ${s.info.version})\n`,
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

const invokedDirectly =
  process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("sayagain");
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
