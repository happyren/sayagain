/** JSON with comments and trailing commas, as VS Code writes it. Parse tolerantly; report whether comments were present. */

export interface JsoncResult {
  value: unknown;
  hadComments: boolean;
}

/** Strip // and block comments outside strings, and trailing commas before } or ]. */
export function stripJsonc(text: string): { text: string; hadComments: boolean } {
  let out = "";
  let hadComments = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      hadComments = true;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      hadComments = true;
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas: a comma followed only by whitespace and a closing bracket.
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return { text: out, hadComments };
}

export function parseJsonc(text: string): JsoncResult {
  const stripped = stripJsonc(text);
  return { value: JSON.parse(stripped.text), hadComments: stripped.hadComments };
}

/** The indentation a JSON file uses (2 spaces, 4 spaces, a tab), defaulting to 2 spaces. */
export function detectIndent(text: string): string {
  const m = text.match(/^\n?( +|\t)"/m) ?? text.match(/\n( +|\t)\S/);
  return m?.[1] ?? "  ";
}
