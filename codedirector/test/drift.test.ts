/**
 * A standalone report or verify judges the tree as it is now — its checks
 * and its scope alike — and names every file that changed after the run.
 *
 * Reproduced on 0.4.5 and on main before this rule (audit finding F5): a
 * clean run edited allowed.txt; protected.txt, denied by the Lock, was then
 * changed by hand; `cdir report` re-ran today's checks but printed the run's
 * old list of changed files — "Done — verified. Only allowed.txt changed,
 * within the agreed scope." — and never mentioned protected.txt.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { loadLock, saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { KeepClause, VibeCheck } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { buildReport } from "../src/report/report";
import { formatReport, summarizeReport } from "../src/report/format";
import { git, makeGitRepo } from "./helpers";

const NODE = process.execPath;
const CLI = path.join(__dirname, "..", "src", "cli.js");
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

const FILES = {
  "allowed.txt": "a\n",
  "notes.txt": "n\n",
  "protected.txt": "p\n",
};

async function setup(keep: KeepClause[] = [], customize?: (lock: VibeCheck) => void): Promise<{ root: string; lock: VibeCheck }> {
  const root = makeGitRepo(FILES);
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "edit allowed", { now: "2026-09-26T00:00:00.000Z", createdBy: "test" });
  lock.keep = keep;
  lock.deny = ["protected.txt"];
  lock.budget = { files: ["allowed.txt"], symbols: [], maxFiles: 1, maxLines: 10 };
  customize?.(lock);
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return { root, lock };
}

async function cleanRun(root: string, lock: VibeCheck): Promise<void> {
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("allowed.txt", "x\n")], { stdio: "pipe" });
  assert.equal(outcome.verdict, "verified", outcome.record.violations.join("; "));
}

const write = (root: string, file: string, text: string) => fs.appendFileSync(path.join(root, file), text);

test("drift: a denied file changed after the run is judged and named — not left out (the audit's case)", async () => {
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  write(root, "protected.txt", "tampered\n");

  const report = await buildReport(root, lock.id);
  assert.equal(report.verdict, "failed");
  assert.deepEqual(report.drift, ["protected.txt"]);
  const p = report.changed.find((c) => c.path === "protected.txt");
  assert.equal(p?.class, "denied", "the report's changed files are the tree's, not the run's old list");
  assert.ok(report.violations.some((v) => v.startsWith("DENY: protected.txt")), report.violations.join("; "));
  const summary = summarizeReport(report);
  assert.doesNotMatch(summary, /Done — verified|Only allowed\.txt changed/);
  assert.match(summary, /^Blocked: protected\.txt is off-limits/);
  assert.match(summary, /1 file changed after the run, not by its command: protected\.txt\./);
  assert.match(formatReport(report), /protected\.txt {2}DENIED \(matches "protected\.txt"\) · changed after the run/);
});

test("drift: an in-budget file edited again after the run is named, and judged by today's checks", async () => {
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  write(root, "allowed.txt", "more\n");
  const report = await buildReport(root, lock.id);
  assert.deepEqual(report.drift, ["allowed.txt"], "same path, different bytes than the run left");
  assert.equal(report.verdict, "verified", "in budget, and every check ran on the tree as it is now");
  assert.match(summarizeReport(report), /1 file changed after the run, not by its command: allowed\.txt\./);
});

test("drift: a change the run made and someone undid is named too", async () => {
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  git(root, ["checkout", "--", "allowed.txt"]);
  const report = await buildReport(root, lock.id);
  assert.deepEqual(report.drift, ["allowed.txt"]);
  assert.deepEqual(report.changed, [], "nothing differs from the baseline any more");
});

test("drift: an untouched tree has none, and the report reads as before", async () => {
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  const report = await buildReport(root, lock.id);
  assert.deepEqual(report.drift, []);
  assert.equal(report.verdict, "verified");
  assert.match(summarizeReport(report), /^Done — verified\. Only allowed\.txt changed, within the agreed scope\./);
  assert.doesNotMatch(summarizeReport(report), /after the run/);
});

test("drift: the line ceiling is measured on the tree as it is now", async () => {
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  write(root, "allowed.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n");
  const report = await buildReport(root, lock.id);
  assert.equal(report.budget?.linesChanged, 12);
  assert.ok(report.violations.includes("BUDGET: 12 lines changed > maxLines 10"), report.violations.join("; "));
});

test("drift: --allow-expand covered the run's own changes, not what came after", async () => {
  const { root, lock } = await setup();
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", `${append("allowed.txt", "x\n")};${append("notes.txt", "x\n")}`], {
    stdio: "pipe",
    allowExpand: true,
  });
  assert.equal(outcome.verdict, "verified");
  assert.equal((await buildReport(root, lock.id)).verdict, "verified", "the override still holds for the run's own changes");
  write(root, "protected.txt", "later\n");
  const report = await buildReport(root, lock.id);
  assert.equal(report.verdict, "failed");
  assert.deepEqual(report.violations.filter((v) => v.startsWith("DENY") || v.startsWith("OUT")), [
    'DENY: protected.txt matches deny pattern "protected.txt"',
  ]);
});

/** The latest run record's path, and the record. */
function latestRecord(root: string): { file: string; record: Record<string, unknown> } {
  const dir = path.join(root, ".codedirector", "runs");
  const file = path.join(dir, fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().pop()!);
  return { file, record: JSON.parse(fs.readFileSync(file, "utf8")) };
}

test("drift: a baseline deleted after the run is tampering — failed, and the scope it could not judge is named", async () => {
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  fs.rmSync(path.join(root, latestRecord(root).record.baselinePath as string));
  write(root, "protected.txt", "tampered\n");
  const report = await buildReport(root, lock.id);
  assert.equal(report.verdict, "failed", "the run recorded the baseline's hash, and it no longer matches");
  assert.ok(report.violations.some((v) => v.startsWith("BASELINE TAMPERED")), report.violations.join("; "));
  assert.deepEqual(report.changed.map((c) => c.path), ["allowed.txt"], "the run's recorded list, said to be so");
  assert.ok(report.incomplete.some((i) => /^NOT RUN scope · the tree as it is now: the run's baseline .* is missing/.test(i)), report.incomplete.join("; "));
});

test("drift: without a baseline to judge against, a clean record is incomplete — never verified", async () => {
  // A record written before the baseline's hash was kept: nothing to call tampering.
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  const { file, record } = latestRecord(root);
  fs.rmSync(path.join(root, record.baselinePath as string));
  delete record.baselineSha256;
  fs.writeFileSync(file, JSON.stringify(record));
  write(root, "protected.txt", "tampered\n");
  const report = await buildReport(root, lock.id);
  assert.equal(report.verdict, "incomplete");
  assert.deepEqual(report.changed.map((c) => c.path), ["allowed.txt"]);
  assert.match(summarizeReport(report), /^Not verified: scope · the tree as it is now: the run's baseline .* is missing — the changed files shown are the run's recorded list\./);
});

test("drift: a run recorded before file hashes were kept still sees new files, and says what it cannot see", async () => {
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  const { file, record } = latestRecord(root);
  delete record.changedHashes;
  fs.writeFileSync(file, JSON.stringify(record));
  write(root, "allowed.txt", "more\n");
  write(root, "protected.txt", "tampered\n");
  const report = await buildReport(root, lock.id);
  assert.deepEqual(report.drift, ["protected.txt"], "a new path is seen; a later edit to the run's own file cannot be");
  assert.equal(report.verdict, "failed");
});

test("drift: `cdir report` does not change the lock's status; `cdir verify` does", async () => {
  const { root, lock } = await setup();
  await cleanRun(root, lock);
  write(root, "protected.txt", "tampered\n");
  const cdir = (...args: string[]) => spawnSync(NODE, [CLI, ...args, "--root", root], { cwd: root, encoding: "utf8", timeout: 120_000 });

  const rep = cdir("report", lock.id);
  assert.equal(rep.status, 1, rep.stdout + rep.stderr);
  assert.match(rep.stdout, /changed after the run, not by its command: protected\.txt/);
  assert.equal(loadLock(root, lock.id)!.status, "verified", "reading a report is not a verdict on the lock");

  const ver = cdir("verify", lock.id);
  assert.equal(ver.status, 1, ver.stdout + ver.stderr);
  assert.equal(loadLock(root, lock.id)!.status, "failed");
});

test("drift: verify with no run behind it cannot see the changed files — a denied edit is not verified", async () => {
  // The direct-edit path: checkpoint, edit, verify. Reproduced before this
  // rule: "Done — verified", exit 0, over an edit to a denied file.
  const { root, lock } = await setup();
  write(root, "protected.txt", "edited directly\n");
  const report = await buildReport(root, lock.id);
  assert.equal(report.verdict, "incomplete");
  assert.match(report.incomplete[0], /^NOT RUN scope · the changed files: no run of this lock has captured a baseline/);
  assert.match(summarizeReport(report), /^Not verified: scope · the changed files: no run of this lock has captured a baseline/);
  assert.match(formatReport(report), /Changed files: unknown — no run record/);
});
