/**
 * The launcher hosts point at: `~/.sayagain/bin/sayagain` (a shell script;
 * `sayagain.cmd` on Windows). Host entries never change when Node.js or
 * the package moves, because every onboarding command and every daemon
 * start rewrites the launcher with the current paths. It also carries the
 * Say Again home and a PATH with Node.js beside it into hosts that launch
 * without a shell (GUI apps), so the daemon they start can run `npx`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homePath, sayagainHome } from "./home.js";
import { PROXY_VERSION } from "./version.js";

export const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

export const launcherPath = (): string =>
  homePath("bin", process.platform === "win32" ? "sayagain.cmd" : "sayagain");

/** Directories worth having on the daemon's PATH when a GUI host starts it. */
function extraPathDirs(): string[] {
  const dirs = [dirname(process.execPath)];
  for (const d of [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(process.env.HOME ?? "", ".local", "bin"),
  ])
    if (d && existsSync(d) && !dirs.includes(d)) dirs.push(d);
  return dirs;
}

const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** Write (or refresh) the launcher. Returns its path. */
export function ensureLauncher(): string {
  const path = launcherPath();
  const home = sayagainHome();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let text: string;
  if (process.platform === "win32") {
    text = [
      "@echo off",
      "rem Written by sayagain; refreshed by every command that writes host files. Do not edit.",
      `set "SAYAGAIN_HOME=${home}"`,
      `set "PATH=${extraPathDirs().join(";")};%PATH%"`,
      `if not exist "${CLI_PATH}" goto fallback`,
      `if not exist "${process.execPath}" goto fallback`,
      `"${process.execPath}" "${CLI_PATH}" %*`,
      "goto :eof",
      ":fallback",
      "rem The install that wrote this launcher is gone (an npx cache evicted, a Node.js upgrade): fetch the same version.",
      `npx -y -p @sayagain/proxy@${PROXY_VERSION} sayagain %*`,
      "",
    ].join("\r\n");
  } else {
    text = [
      "#!/bin/sh",
      "# Written by sayagain; refreshed by every command that writes host files. Do not edit.",
      `export SAYAGAIN_HOME=${shQuote(home)}`,
      `export PATH=${shQuote(extraPathDirs().join(":"))}:"$PATH"`,
      `if [ -f ${shQuote(CLI_PATH)} ] && [ -x ${shQuote(process.execPath)} ]; then exec ${shQuote(process.execPath)} ${shQuote(CLI_PATH)} "$@"; fi`,
      "# The install that wrote this launcher is gone (an npx cache evicted, a Node.js upgrade): fetch the same version.",
      `exec npx -y -p ${shQuote(`@sayagain/proxy@${PROXY_VERSION}`)} sayagain "$@"`,
      "",
    ].join("\n");
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o700 });
  renameSync(tmp, path);
  chmodSync(path, 0o700);
  return path;
}

/**
 * Why the launcher's target might not survive: the npx cache is evicted, and nvm paths move on
 * upgrade. The launcher then fetches its own version with npx, which needs the network and is slow
 * the first time; a durable install is still worth having.
 */
export function launcherCaveat(): string | undefined {
  const inCache = (path: string) => /[\\/]_npx[\\/]/.test(path);
  if (inCache(CLI_PATH))
    return "sayagain is running from the npx cache, which npm evicts; the launcher then fetches this version with npx (slow the first time, and it needs the network). Install it (npm install -g @sayagain/proxy) and run this command again so the launcher points somewhere durable";
  // This command is durable, but the launcher the hosts use may still point into a cache.
  try {
    if (inCache(readFileSync(launcherPath(), "utf8")))
      return "the launcher the hosts point at runs from the npx cache, which npm evicts; sayagain up points it at this install";
  } catch {
    // no launcher yet: the next onboarding command writes one
  }
  return undefined;
}
