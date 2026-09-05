#!/usr/bin/env node
/**
 * Release helper. See docs/RELEASING.md.
 *
 *   node scripts/release.mjs minor|patch|X.Y.Z   bump, changelog, branch, PR
 *   node scripts/release.mjs tag                  tag origin/main at its package.json version, push the tag
 *   node scripts/release.mjs notes X.Y.Z          print that version's CHANGELOG section
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sh = (cmd) =>
  execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();
/** Run a command whose output belongs to the terminal (interactive gh prompts). */
const run = (cmd) => {
  execSync(cmd, { stdio: "inherit" });
};
const root = process.cwd();
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [mode, arg] = process.argv.slice(2);

function packageFiles() {
  const files = [join(root, "package.json")];
  for (const d of readdirSync(join(root, "packages")))
    files.push(join(root, "packages", d, "package.json"));
  return files;
}

function bumpVersion(current, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [ma, mi, pa] = current.split(".").map(Number);
  if (how === "minor") return `${ma}.${mi + 1}.0`;
  if (how === "patch") return `${ma}.${mi}.${pa + 1}`;
  if (how === "major") return `${ma + 1}.0.0`;
  throw new Error(`unknown bump: ${how}`);
}

export function sectionFor(version, log = readFileSync(join(root, "CHANGELOG.md"), "utf8")) {
  const heading = `## [${version}]`;
  const start = log.indexOf(heading);
  if (start < 0) throw new Error(`no CHANGELOG section for ${version}`);
  const bodyStart = log.indexOf("\n", start) + 1;
  const next = log.indexOf("\n## [", bodyStart);
  return log.slice(bodyStart, next < 0 ? log.length : next).trim();
}

if (mode === "notes") {
  process.stdout.write(`${sectionFor(arg)}\n`);
} else if (mode === "tag") {
  sh("git fetch -q origin main");
  const head = sh("git rev-parse origin/main");
  const v = JSON.parse(sh(`git show ${head}:package.json`)).version;
  if (sh(`git tag -l v${v}`)) throw new Error(`v${v} already exists`);
  sh(`git tag -a v${v} ${head} -m "Say Again v${v}"`);
  sh(`git push origin v${v}`);
  console.log(
    `tagged origin/main (${head.slice(0, 7)}) as v${v}; the Release workflow takes it from here`,
  );
} else if (mode) {
  if (sh("git status --porcelain")) throw new Error("working tree is not clean");
  if (sh("git branch --show-current") !== "main") throw new Error("run from main");
  const next = bumpVersion(rootPkg.version, mode);
  for (const f of packageFiles()) {
    const pkg = JSON.parse(readFileSync(f, "utf8"));
    pkg.version = next;
    writeFileSync(f, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  if (!/^## \[Unreleased\]/m.test(log)) throw new Error("CHANGELOG.md has no Unreleased section");
  writeFileSync(
    join(root, "CHANGELOG.md"),
    log.replace(/^## \[Unreleased\]\s*$/m, `## [Unreleased]\n\n## [${next}] - ${date}`),
  );
  const branch = `release/v${next}`;
  sh(`git checkout -q -b ${branch}`);
  sh("git add -A");
  sh(`git commit -q -s -m "chore(release): v${next}"`);
  sh(`git push -q -u origin ${branch}`);
  run(
    `gh pr create --base main --title "chore(release): v${next}" --body "Release v${next}. Merge, then run: node scripts/release.mjs tag"`,
  );
} else {
  console.log("usage: release.mjs minor|patch|X.Y.Z | tag | notes X.Y.Z");
  process.exit(2);
}
