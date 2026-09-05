import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ask, startControlServer } from "./control.js";
import { HoldQueue } from "./holds.js";

describe("control socket", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it("lists holds and applies decisions over the socket", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(join(tmpdir(), "sayagain-ctl-"));
    const path = join(dir, "t.sock");
    const q = new HoldQueue();
    q.create({
      receipt: "rcpt_x",
      tool: "delete_page",
      toolClass: "destructive",
      reason: "r",
      arguments: { id: 1 },
      intent: "i",
      createdAt: 0,
      expiresAt: 1,
    });
    const server = startControlServer(q, path, { deadletters: () => [], replay: async () => null });
    await new Promise((r) => server.once("listening", r));
    const dl = await ask(path, { op: "deadletters" });
    expect(dl).toMatchObject({ ok: true, deadletters: [] });
    const rp = await ask(path, { op: "replay", receipt: "nope" });
    expect(rp).toMatchObject({ ok: false });
    const list = await ask(path, { op: "list" });
    expect(list.ok && "holds" in list && list.holds[0]).toMatchObject({
      receipt: "rcpt_x",
      intent: "i",
      arguments: { id: 1 },
    });
    const decided = await ask(path, { op: "decide", receipt: "rcpt_x", decision: "approve" });
    expect(decided).toMatchObject({ ok: true, decided: true });
    const again = await ask(path, { op: "decide", receipt: "rcpt_x", decision: "approve" });
    expect(again).toMatchObject({ ok: true, decided: false });
    server.close();
    await new Promise((r) => server.once("close", r));
  });
});
