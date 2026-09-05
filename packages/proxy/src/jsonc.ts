/** JSON with comments and trailing commas, as VS Code writes it. Parse tolerantly; report whether comments were present. */

export interface JsoncResult {
  value: unknown;
  hadComments: boolean;
}

/**
 * Strip a leading BOM, `//` and block comments outside strings, and trailing
 * commas before `}` or `]`. Strings are copied verbatim, so a `,]` or `//`
 * inside one is untouched.
 */
export function stripJsonc(input: string): { text: string; hadComments: boolean } {
  const text = input.replace(/^\uFEFF/, "");
  let out = "";
  let hadComments = false;
  let i = 0;
  const skipCommentsAndSpace = (from: number): number => {
    let j = from;
    for (;;) {
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text[j] === "/" && text[j + 1] === "/") {
        while (j < text.length && text[j] !== "\n") j++;
        continue;
      }
      if (text[j] === "/" && text[j + 1] === "*") {
        const end = text.indexOf("*/", j + 2);
        j = end < 0 ? text.length : end + 2;
        continue;
      }
      return j;
    }
  };
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
    if (c === ",") {
      const next = text[skipCommentsAndSpace(i + 1)];
      if (next === "}" || next === "]") {
        i++;
        continue; // trailing comma: drop it, keep whatever whitespace or comment follows
      }
    }
    out += c;
    i++;
  }
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
