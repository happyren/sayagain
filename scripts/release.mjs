#!/usr/bin/env node
/**
 * Release helper. See docs/RELEASING.md.
 *
 *   node scripts/release.mjs minor|patch|X.Y.Z   bump, changelog, branch, PR
 *   node scripts/release.mjs tag                  tag main at the release commit, push the tag
 *   node scripts/release.mjs notes X.Y.Z          print that version's CHANGELOG section
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sh = (cmd, opts = {}) =>
  execSync(cmd, { stdio: ["ignore", "pipe", "inherit"], ...opts })
    .toString()
    .trim();
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

function sectionFor(version) {
  const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const re = new RegExp(
    `^## \\[${version.replace(/\./g, "\\.")}\\][^\n]*\n([\\s\\S]*?)(?=^## \\[|\\Z)`,
    "m",
  );
  const m = log.match(re);
  if (!m) throw new Error(`no CHANGELOG section for ${version}`);
  return m[1].trim();
}

if (mode === "notes") {
  process.stdout.write(`${sectionFor(arg)}\n`);
} else if (mode === "tag") {
  const branch = sh("git branch --show-current");
  if (branch !== "main") throw new Error("run from main");
  sh("git fetch -q origin main");
  if (sh("git rev-parse HEAD") !== sh("git rev-parse origin/main"))
    throw new Error("main is not up to date with origin");
  const v = rootPkg.version;
  const subject = sh("git log -1 --format=%s");
  if (subject !== `chore(release): v${v}`)
    throw new Error(`HEAD is not the release commit for v${v} (subject: ${subject})`);
  sh(`git tag -a v${v} -m "Say Again v${v}"`);
  sh(`git push origin v${v}`);
  console.log(`tagged and pushed v${v}; the Release workflow takes it from here`);
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
  sh(
    `gh pr create --base main --title "chore(release): v${next}" --body "Release v${next}. Merge, then run: node scripts/release.mjs tag"`,
    { stdio: "inherit" },
  );
} else {
  console.log("usage: release.mjs minor|patch|X.Y.Z | tag | notes X.Y.Z");
  process.exit(2);
}
