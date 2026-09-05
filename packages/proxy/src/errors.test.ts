import { describe, expect, it } from "vitest";
import { classifyError, guidanceFor } from "./errors.js";

describe("classifyError", () => {
  it("maps text and codes to classes, schema errors before timeouts", () => {
    expect(classifyError("Error: Request timed out")).toBe("retryable");
    expect(classifyError("Invalid params: limit must be a number")).toBe("coercible");
    expect(classifyError("Invalid params: timeout must be a number")).toBe("coercible");
    expect(classifyError("permission denied")).toBe("blocked");
    expect(classifyError("page 'x' not found")).toBe("semantic");
    expect(classifyError("something odd")).toBe("other");
    expect(classifyError("anything", -32602)).toBe("coercible");
    expect(classifyError("anything", -32601)).toBe("semantic");
    expect(classifyError("upstream returned 503")).toBe("retryable");
  });
});

describe("guidanceFor", () => {
  it("names the receipt and the replay command when dead-lettered", () => {
    const g = guidanceFor({
      errorClass: "coercible",
      attempts: 2,
      repaired: true,
      receipt: "rcpt_1",
      status: "dead-lettered",
      tool: "strict",
    });
    expect(g).toContain("sayagain replay rcpt_1");
    expect(g).toContain("deterministic repair");
  });
});
