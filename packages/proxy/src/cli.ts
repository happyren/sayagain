#!/usr/bin/env node
import { decideEverywhere, listAllHolds } from "./control.js";
import { defaultLedgerPath, JsonlLedger, readLedger } from "./ledger.js";
import { parseClassOverrides } from "./policy.js";
import { PROXY_VERSION } from "./version.js";
import { wrap } from "./wrap.js";

const USAGE = `sayagain ${PROXY_VERSION}

  sayagain wrap [options] -- <server command> [args...]
      Run the boundary in-process around one stdio MCP server.
      --ledger <path>          JSONL ledger (default ~/.sayagain/ledger.jsonl)
      --name <upstream>        upstream name until initialize reveals it
      --no-announce            do not append the boundary sentence to instructions
      --hold destructive|always|never   which calls are held before leaving (default destructive)
      --hold-wait <ms>         how long a held call waits for a decision (default 120000)
      --class <tool>=<class>   override a tool's class (read-only, idempotent-write, write, destructive); repeatable
      --dedupe-window <ms>     retention for idempotency keys and write fingerprints (default 30000)
  sayagain ledger [--ledger <path>] [--tail <n>] [--json]
      Read the ledger.
  sayagain holds [--json]
      List calls held by every running boundary on this machine.
  sayagain approve <receipt> | sayagain reject <receipt>
      Decide a held call.
  sayagain --version | --help
`;

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
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
    if (sep < 0 || sep === rest.length - 1) {
      process.stderr.write("wrap: expected -- followed by the server command\n");
      return 2;
    }
    const opts = rest.slice(0, sep);
    const [serverCommand, ...serverArgs] = rest.slice(sep + 1);
    if (!serverCommand) return 2;
    const ledgerPath = takeOption(opts, "--ledger") ?? defaultLedgerPath();
    const upstreamName = takeOption(opts, "--name");
    const announce = !takeFlag(opts, "--no-announce");
    const hold = takeOption(opts, "--hold");
    const holdWait = takeOption(opts, "--hold-wait");
    const dedupeWindow = takeOption(opts, "--dedupe-window");
    const classes = parseClassOverrides(takeAll(opts, "--class"));
    if (opts.length) {
      process.stderr.write(`wrap: unknown option ${opts[0]}\n`);
      return 2;
    }
    if (hold !== undefined && hold !== "destructive" && hold !== "always" && hold !== "never") {
      process.stderr.write(`wrap: --hold must be destructive, always or never\n`);
      return 2;
    }
    const policy: NonNullable<Parameters<typeof wrap>[0]["policy"]> = { classes };
    if (hold !== undefined) policy.hold = hold;
    if (holdWait !== undefined) policy.holdWaitMs = Number(holdWait);
    if (dedupeWindow !== undefined) policy.dedupeWindowMs = Number(dedupeWindow);
    const wrapOptions: Parameters<typeof wrap>[0] = {
      command: serverCommand,
      args: serverArgs,
      ledger: new JsonlLedger(ledgerPath),
      ledgerKind: "jsonl",
      announce,
      policy,
    };
    if (upstreamName !== undefined) wrapOptions.upstreamName = upstreamName;
    const { done } = wrap(wrapOptions);
    return done;
  }

  if (command === "ledger") {
    const opts = [...rest];
    const ledgerPath = takeOption(opts, "--ledger") ?? defaultLedgerPath();
    const tailRaw = takeOption(opts, "--tail");
    const json = takeFlag(opts, "--json");
    const readOptions: { tail?: number } = {};
    if (tailRaw !== undefined) readOptions.tail = Number(tailRaw);
    const rows = readLedger(ledgerPath, readOptions);
    if (json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    if (!rows.length) {
      process.stdout.write(`no calls recorded in ${ledgerPath}\n`);
      return 0;
    }
    for (const r of rows) {
      const err = r.isError ? ` ERROR ${r.errorSignature ?? r.errorCode ?? ""}`.trimEnd() : "";
      const extra = r.duplicateOf
        ? ` duplicate of ${r.duplicateOf}`
        : r.held
          ? ` held: ${r.held.decision ?? "pending"}`
          : "";
      process.stdout.write(
        `${r.ts}  ${r.receipt}  ${r.status.padEnd(12)}  ${r.upstream}/${r.tool} [${r.toolClass}]  ${r.latencyMs}ms${err}${extra}\n`,
      );
    }
    return 0;
  }

  if (command === "holds") {
    const json = rest.includes("--json");
    const holds = await listAllHolds();
    if (json) {
      process.stdout.write(`${JSON.stringify(holds, null, 2)}\n`);
      return 0;
    }
    if (!holds.length) {
      process.stdout.write("no held calls\n");
      return 0;
    }
    for (const h of holds) {
      process.stdout.write(
        `${h.receipt}  ${h.tool} [${h.toolClass}]  since ${h.createdAt}  expires ${h.expiresAt}\n`,
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
    if (!receipt) {
      process.stderr.write(`${command}: expected a receipt\n`);
      return 2;
    }
    const ok = await decideEverywhere(receipt, command);
    process.stdout.write(
      ok ? `${command}d ${receipt}\n` : `no running boundary holds ${receipt}\n`,
    );
    return ok ? 0 : 1;
  }

  process.stderr.write(`unknown command: ${command}\n${USAGE}`);
  return 2;
}

const invokedDirectly =
  process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("sayagain");
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
