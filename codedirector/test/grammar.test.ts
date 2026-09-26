/**
 * A grammar that cannot load makes its language's files unparsed — named,
 * with the reason — and never stops the rest of the index.
 *
 * Reproduced on fc4a2db (audit finding): in an install without
 * tree-sitter-wasms, `cdir index` on a TypeScript-only project failed —
 * "Cannot find module 'tree-sitter-wasms/out/tree-sitter-swift.wasm'",
 * exit 1 — as did every command that indexes. Every grammar was loaded
 * before anything was parsed.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { installedGrammar, LangKey, StructuralParser } from "../src/core/parser";
import { draftLock } from "../src/lock/draft";
import { checkLock } from "../src/lock/check";
import { VibeCheck } from "../src/lock/types";
import { captureBaseline } from "../src/run/baseline";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { runWithLock } from "../src/run/run";
import { buildReport } from "../src/report/report";
import { verifyWithBaseline } from "../src/verify/verify";
import { incompleteChecks } from "../src/verify/types";
import { makeGitRepo } from "./helpers";

const PKG = path.join(__dirname, "..", "..");
const SWIFT = "public struct Model {\n    public func refresh() -> Int { 1 }\n}\n";
const TS = "export function add(a: number, b: number) { return a + b; }\n";

/** A parser whose Swift grammar is missing, as in an install without tree-sitter-wasms; records what it was asked to load. */
function brokenSwift(asked: LangKey[] = []): StructuralParser {
  return new StructuralParser((lang) => {
    asked.push(lang);
    if (lang === "swift") throw new Error("Cannot find module 'tree-sitter-wasms/out/tree-sitter-swift.wasm'\nRequire stack:\n- x");
    return installedGrammar(lang);
  });
}

const SWIFT_REASON = "Swift grammar unavailable (Cannot find module 'tree-sitter-wasms/out/tree-sitter-swift.wasm')";

test("grammar: a TypeScript-only project never loads the Swift grammar", async () => {
  const asked: LangKey[] = [];
  const root = makeGitRepo({ "math.ts": TS });
  const { index, stats } = await buildIndex(root, { parser: brokenSwift(asked) });
  assert.deepEqual(asked, ["typescript"], "only the grammar the project needs");
  assert.deepEqual(stats.unavailable, []);
  assert.ok(index.files["math.ts"].symbols.some((s) => s.id === "math.ts#add"));
});

test("grammar: a missing Swift grammar leaves the Swift files unparsed, named — the rest is indexed", async () => {
  const root = makeGitRepo({ "math.ts": TS, "App/Model.swift": SWIFT });
  const { index, stats } = await buildIndex(root, { parser: brokenSwift() });
  assert.ok(index.files["math.ts"].symbols.some((s) => s.id === "math.ts#add"));
  assert.equal(index.files["App/Model.swift"].unavailable, SWIFT_REASON);
  assert.deepEqual(index.files["App/Model.swift"].symbols, []);
  assert.deepEqual(stats.unavailable, [{ reason: SWIFT_REASON, files: ["App/Model.swift"] }]);
  assert.equal(stats.filesParsed, 1);
});

test("grammar: once the grammar is there, the next build parses the file — an unparsed file is not cached", async () => {
  const root = makeGitRepo({ "App/Model.swift": SWIFT });
  await buildIndex(root, { parser: brokenSwift() });
  const { index, stats } = await buildIndex(root);
  assert.equal(index.files["App/Model.swift"].unavailable, undefined);
  assert.ok(index.files["App/Model.swift"].symbols.some((s) => s.id === "App/Model.swift#Model.refresh"));
  assert.equal(stats.filesParsed, 1, "retried, though its bytes did not change");
});

function lockFor(root: string, index: Awaited<ReturnType<typeof buildIndex>>["index"]): VibeCheck {
  const { lock } = draftLock(root, index, "keep the model", { now: "2026-09-26T00:00:00.000Z", createdBy: "test" });
  lock.keep = [{ kind: "api-unchanged", symbols: ["App/Model.swift#Model.refresh"] }];
  lock.budget = { files: ["App/Model.swift"], symbols: [], maxFiles: 1, maxLines: 10 };
  lock.status = "active";
  return lock;
}

test("grammar: api-unchanged on a file that could not be read is Unchecked with the reason — not 'no longer exists'", async () => {
  const root = makeGitRepo({ "App/Model.swift": SWIFT });
  const { index: before } = await buildIndex(root, { persist: false });
  const lock = lockFor(root, before);
  const baseline = captureBaseline(root, lock, before, undefined, { typecheck: false });
  const { index: after } = await buildIndex(root, { persist: false, parser: brokenSwift() });
  const report = verifyWithBaseline(root, lock, baseline, "b.json", after, { typecheck: false });
  const item = report.items.find((i) => i.clauseKind === "api-unchanged")!;
  assert.equal(item.verdict, "unchecked", item.detail);
  assert.equal(item.reason, `App/Model.swift was not indexed: ${SWIFT_REASON}`);
  assert.deepEqual(report.violations, []);
  assert.equal(incompleteChecks(report.items).length, 1, "a required check that could not run: the run is incomplete");
});

test("grammar: lock check says why a symbol is not in the index", async () => {
  const root = makeGitRepo({ "App/Model.swift": SWIFT });
  const { index } = await buildIndex(root, { persist: false, parser: brokenSwift() });
  const result = checkLock(root, lockFor(root, index), index);
  assert.ok(
    result.errors.includes(`symbol not in index: App/Model.swift#Model.refresh — App/Model.swift was not indexed: ${SWIFT_REASON}`),
    result.errors.join("\n"),
  );
});

/** This package, built, in an install without tree-sitter-wasms — the audit's setup. */
function brokenInstall(): string {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-broken-install-"));
  fs.cpSync(path.join(PKG, "dist", "src"), path.join(pkg, "dist", "src"), { recursive: true });
  fs.copyFileSync(path.join(PKG, "package.json"), path.join(pkg, "package.json"));
  fs.mkdirSync(path.join(pkg, "node_modules"));
  for (const name of fs.readdirSync(path.join(PKG, "node_modules"))) {
    if (name === "tree-sitter-wasms") continue;
    fs.symlinkSync(path.join(PKG, "node_modules", name), path.join(pkg, "node_modules", name));
  }
  return path.join(pkg, "dist", "src", "cli.js");
}

test("grammar: in an install without the Swift grammar, `cdir index` works — silent for TypeScript, naming the Swift files it could not read", () => {
  const cli = brokenInstall();
  const tsOnly = makeGitRepo({ "math.ts": TS });
  const a = spawnSync(process.execPath, [cli, "index", "--root", tsOnly], { cwd: tsOnly, encoding: "utf8", timeout: 60_000 });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /Indexed 1 files: 1 parsed/);
  assert.equal(a.stderr, "", "a TypeScript project never hears about Swift");

  const mixed = makeGitRepo({ "math.ts": TS, "App/Model.swift": SWIFT });
  const b = spawnSync(process.execPath, [cli, "index", "--root", mixed], { cwd: mixed, encoding: "utf8", timeout: 60_000 });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(
    b.stderr,
    `cdir: ${SWIFT_REASON} — 1 file(s) not indexed (App/Model.swift); checks that need them report Unchecked\n`,
  );
});

test("grammar: the report does not invent test coverage for a file it could not read — it says it could not", async () => {
  const root = makeGitRepo({ "App/Model.swift": SWIFT });
  const { index } = await buildIndex(root);
  const lock = lockFor(root, index);
  lock.keep = [];
  saveLock(root, lock);
  sealLock(root, lock);
  const outcome = await runWithLock(root, lock.id, [process.execPath, "-e", 'require("fs").appendFileSync("App/Model.swift","// x\\n")'], { stdio: "pipe" });
  // A machine with the broken install and no index yet (an unchanged file keeps the facts already read).
  fs.rmSync(path.join(root, ".codedirector", "index.json"));
  const { index: unread } = await buildIndex(root, { persist: false, parser: brokenSwift() });
  const report = await buildReport(root, lock.id, { verification: outcome.record.verification, run: outcome.record, index: unread });
  assert.deepEqual(
    report.findings.map((f) => f.text),
    [`1 file(s) changed in-budget (App/Model.swift) were not indexed — ${SWIFT_REASON}; their structure and test coverage are unknown`],
  );
});
