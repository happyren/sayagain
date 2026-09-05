#!/usr/bin/env node
import { defaultLedgerPath, JsonlLedger, readLedger } from "./ledger.js";
import { PROXY_VERSION } from "./version.js";
import { wrap } from "./wrap.js";

const USAGE = `sayagain ${PROXY_VERSION}

  sayagain wrap [--ledger <path>] [--name <upstream>] [--no-announce] -- <server command> [args...]
      Run the boundary in-process around one stdio MCP server.
  sayagain ledger [--ledger <path>] [--tail <n>] [--json]
      Read the ledger.
  sayagain --version | --help
`;

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
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
    if (opts.length) {
      process.stderr.write(`wrap: unknown option ${opts[0]}\n`);
      return 2;
    }
    const wrapOptions: Parameters<typeof wrap>[0] = {
      command: serverCommand,
      args: serverArgs,
      ledger: new JsonlLedger(ledgerPath),
      ledgerKind: "jsonl",
      announce,
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
      process.stdout.write(
        `${r.ts}  ${r.receipt}  ${r.status.padEnd(12)}  ${r.upstream}/${r.tool}  ${r.latencyMs}ms${err}\n`,
      );
    }
    return 0;
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
