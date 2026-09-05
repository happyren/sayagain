/** Masked first line of an error: stable across occurrences, safe to show an operator. */
export function signatureOf(text: unknown): string {
  const cleaned = (
    typeof text === "string"
      ? text
      : text === undefined || text === null
        ? ""
        : JSON.stringify(text)
  ).replace(/<\/?tool_use_error>/g, "");
  const line = cleaned.split("\n").find((l) => l.trim()) ?? "";
  return line
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\b[A-Za-z]:\\[^\s"'`]+/g, "<path>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<path>")
    .replace(/\b[\w.-]+\/[\w.-]+\b/g, "<path>")
    .replace(/\b(?:[\w-]+\.){1,}[a-z]{2,}\b(?=[^\w.]|$)/gi, "<host>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>")
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

/** Text content of an MCP tool result, for error classification only. */
export function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      typeof (block as { text?: unknown }).text === "string"
    )
      parts.push((block as { text: string }).text);
  }
  return parts.join("\n").slice(0, 4000);
}
