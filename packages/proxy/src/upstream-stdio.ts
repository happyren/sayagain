/** An upstream reached by spawning a command and speaking newline-delimited JSON-RPC on its stdio. */
import { type ChildProcess, spawn } from "node:child_process";
import { LineSplitter } from "./jsonrpc.js";
import type { Upstream } from "./transport.js";

export interface StdioUpstreamOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  log?: (line: string) => void;
}

export class StdioUpstream implements Upstream {
  private child: ChildProcess | undefined;
  private lineHandlers: ((line: string) => void)[] = [];
  private closeHandlers: ((reason: string, code: number | null) => void)[] = [];
  private closed = false;
  private stdinEnded = false;

  constructor(private readonly options: StdioUpstreamOptions) {}

  get ready(): boolean {
    return !!this.child && !this.closed && !this.stdinEnded && !!this.child.stdin?.writable;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  onLine(cb: (line: string) => void): void {
    this.lineHandlers.push(cb);
  }
  onClose(cb: (reason: string, code: number | null) => void): void {
    this.closeHandlers.push(cb);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        stdio: ["pipe", "pipe", "inherit"],
        env: this.options.env ?? process.env,
        ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
      });
      this.child = child;
      const lines = new LineSplitter();
      let exitCode: number | null = null;
      const finish = (reason: string) => {
        if (this.closed) return;
        this.closed = true;
        const rest = lines.flush();
        if (rest) for (const h of this.lineHandlers) h(rest);
        for (const h of this.closeHandlers) h(reason, exitCode);
      };
      child.on("error", (err) => {
        this.options.log?.(
          `sayagain: cannot run upstream "${this.options.command}": ${err.message}`,
        );
        exitCode = 1;
        finish(`cannot run upstream: ${err.message}`);
        resolve();
      });
      child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE")
          this.options.log?.(`sayagain: upstream stdin error: ${err.message}`);
        this.stdinEnded = true;
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        for (const line of lines.push(chunk)) for (const h of this.lineHandlers) h(line);
      });
      child.on("exit", (code) => {
        exitCode = code ?? 0;
      });
      child.on("close", () => finish("upstream exited"));
      child.on("spawn", () => resolve());
    });
  }

  send(line: string): boolean {
    if (!this.ready || !this.child?.stdin) return false;
    this.child.stdin.write(line);
    return true;
  }

  /** Close the upstream's stdin; a well-behaved server exits. */
  end(): void {
    if (this.child?.stdin && !this.stdinEnded) {
      this.stdinEnded = true;
      this.child.stdin.end();
    }
  }

  stop(): void {
    this.end();
    if (this.child && !this.closed) this.child.kill();
  }

  kill(signal?: NodeJS.Signals): void {
    this.child?.kill(signal);
  }
}
