import { describe, expect, it } from "vitest";
import { LineSplitter } from "./jsonrpc.js";

describe("LineSplitter", () => {
  it("reassembles a multi-byte character split across chunks", () => {
    const text = `{"t":"${"日本語".repeat(3)}"}\n`;
    const bytes = Buffer.from(text, "utf8");
    const s = new LineSplitter();
    const lines = [
      ...s.push(bytes.subarray(0, 8)),
      ...s.push(bytes.subarray(8, 9)),
      ...s.push(bytes.subarray(9)),
    ];
    expect(lines).toEqual([text.trimEnd()]);
    expect(lines[0]).not.toContain("�");
  });
  it("keeps a partial tail until flush", () => {
    const s = new LineSplitter();
    expect(s.push("a\nb")).toEqual(["a"]);
    expect(s.flush()).toBe("b");
    expect(s.flush()).toBeNull();
  });
});
