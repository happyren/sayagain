/** Where Say Again keeps its files: $SAYAGAIN_HOME, else ~/.sayagain. */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const sayagainHome = (): string =>
  resolve(process.env.SAYAGAIN_HOME || join(homedir(), ".sayagain"));
export const homePath = (...parts: string[]): string => join(sayagainHome(), ...parts);
/** Create the home directory (0700: it holds tokens, hold arguments and dead letters). */
export function ensureHome(): string {
  const h = sayagainHome();
  mkdirSync(h, { recursive: true, mode: 0o700 });
  return h;
}
