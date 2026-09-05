/** Error classes and the guidance the boundary appends to a final failure (error rewriting). */

export type ErrorClass = "retryable" | "coercible" | "blocked" | "semantic" | "other";

const CLASSES: [ErrorClass, RegExp][] = [
  [
    "coercible",
    /InputValidationError|invalid (param|argument|input)|schema|required (param|field|property)|missing required|must be (a|an|of type)|expected .{1,40} (but )?(got|received)|not a valid|unexpected (property|field|key)|is required\b/i,
  ],
  [
    "blocked",
    /permission|denied|unauthori[sz]ed|forbidden|\b401\b|\b403\b|EACCES|not allowed|requires? (approval|auth)/i,
  ],
  [
    "retryable",
    /\btimed out\b|\btime-?out\b(?!\s*(must|should|is|param|value))|ETIMEDOUT|deadline exceeded|rate limit|too many requests|\b429\b|ECONNRESET|ECONNREFUSED|socket hang up|unavailable|not running|unresponsive|is stuck|\b50[234]\b/i,
  ],
  [
    "semantic",
    /not found|no such|ENOENT|does not exist|\b404\b|already exists|conflict|\b409\b|EEXIST|not active|not initialized|not loaded|call \w+ first|requires a prior/i,
  ],
];

export function classifyError(text: string, rpcCode?: number): ErrorClass {
  if (rpcCode === -32602) return "coercible";
  if (rpcCode === -32601) return "semantic";
  for (const [cls, re] of CLASSES) if (re.test(text)) return cls;
  return "other";
}

export interface GuidanceContext {
  errorClass: ErrorClass;
  attempts: number;
  repaired: boolean;
  receipt: string;
  status: "executed" | "dead-lettered" | "held";
  tool: string;
}

/** One sentence the model can act on, appended after the upstream's own error text. */
export function guidanceFor(ctx: GuidanceContext): string {
  const tail =
    ctx.status === "dead-lettered"
      ? ` Receipt ${ctx.receipt} is dead-lettered; an operator can replay it with sayagain replay ${ctx.receipt}. Do not retry it yourself.`
      : ` Receipt ${ctx.receipt}.`;
  switch (ctx.errorClass) {
    case "retryable":
      return `Say Again: the upstream did not answer in time${ctx.attempts > 1 ? ` after ${ctx.attempts} attempts` : ""}. Retrying the same call now is unlikely to help; continue with other work or tell the user.${tail}`;
    case "coercible":
      return `Say Again: the arguments were rejected by ${ctx.tool}'s schema${ctx.repaired ? " even after a deterministic repair" : ""}. Check each argument's type against the tool description before calling again.${tail}`;
    case "blocked":
      return `Say Again: this is a permission or authentication failure, not an argument problem. Retrying will not help; tell the user what access is missing.${tail}`;
    case "semantic":
      return `Say Again: the tool could not find or apply what the arguments referred to. Verify the identifier or precondition with a read-only tool before calling again.${tail}`;
    default:
      return `Say Again: the call failed and the error above is the upstream's own message.${tail}`;
  }
}
