/** Where Say Again keeps its files: $SAYAGAIN_HOME, else ~/.sayagain. */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const sayagainHome = (): string => process.env.SAYAGAIN_HOME || join(homedir(), ".sayagain");
export const homePath = (...parts: string[]): string => join(sayagainHome(), ...parts);
export function ensureHome(): string {
  const h = sayagainHome();
  mkdirSync(h, { recursive: true });
  return h;
}
