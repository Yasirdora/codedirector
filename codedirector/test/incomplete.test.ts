/**
 * A check the Lock requires that did not finish is never "verified".
 *
 * Reproduced on 0.4.5 and on main before this rule: a verifyCommand stopped
 * by its timeout ended "Done — verified. … verifyCommand timed out after
 * 300ms", exit 0, and the Lock was marked verified — only a violation could
 * block the verdict, and a check that never finished is not a violation.
 *
 * Three outcomes now: failed (a violation, or the command failed) beats
 * incomplete (nothing violated, a required check did not finish) beats
 * verified. Required = every KEEP clause but custom, and the verifyCommand.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { loadLock, lockPathFor, saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { KeepClause, VibeCheck } from "../src/lock/types";
import { formatRunReport, RUN_EXIT, runVerdict, runWithLock, RunError } from "../src/run/run";
import { isRequiredCheck, VerificationItem } from "../src/verify/types";
import { buildReport, finalizeLockStatus } from "../src/report/report";
import { formatReport, formatReportMarkdown, summarizeReport } from "../src/report/format";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;
const CLI = path.join(__dirname, "..", "src", "cli.js");
/** Sleeps longer than any timeout these tests set, shorter than the default. */
const SLOW = `${JSON.stringify(NODE)} -e "setTimeout(()=>{},3000)"`;
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

const FILES = {
  "src/math.js": `export function add(a, b) { return a + b; }\n`,
  "src/render.js": `import { add } from "./math.js";\nconsole.log(\`sum=\${add(2, 3)}\`);\n`,
  "src/secret.js": `export const SECRET = 1;\n`,
  "test/math.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n`,
  "package.json": '{"name":"fixture","type":"module","dependencies":{}}\n',
};

async function setup(keep: KeepClause[], customize?: (lock: VibeCheck) => void): Promise<{ root: string; lock: VibeCheck }> {
  const root = makeGitRepo(FILES);
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make math faster", { now: "2026-09-26T00:00:00.000Z", createdBy: "test" });
  lock.keep = keep;
  lock.deny = ["src/secret.js"];
  lock.budget = { files: ["src/math.js"], symbols: [], maxFiles: 2, maxLines: 400 };
  customize?.(lock);
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return { root, lock };
}

const edit = [NODE, "-e", append("src/math.js", "// faster\n")];

test("incomplete: a verifyCommand that times out is not verified — exit 3, the lock says incomplete, the report says why", async () => {
  const { root, lock } = await setup([{ kind: "no-new-dependency" }], (l) => {
    l.verifyCommand = SLOW;
    l.verifyTimeoutMs = 300;
  });
  const outcome = await runWithLock(root, lock.id, edit, { stdio: "pipe" });
  assert.equal(outcome.verdict, "incomplete");
  assert.equal(outcome.exitCode, RUN_EXIT.incomplete);
  assert.equal(outcome.exitCode, 3);
  assert.deepEqual(outcome.record.violations, [], "a check that did not finish is not a violation");
  assert.equal(outcome.record.incomplete?.length, 1);
  assert.match(outcome.record.incomplete![0], /^NOT RUN verifyCommand · .* timed out after 300ms/);
  assert.equal(loadLock(root, lock.id)!.status, "incomplete");
  assert.match(formatRunReport(outcome), /NOT VERIFIED — 1 required check\(s\) did not finish/);

  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });
  assert.equal(report.verdict, "incomplete");
  assert.deepEqual(report.incomplete, outcome.record.incomplete);
  const summary = summarizeReport(report);
  assert.match(summary, /^Not verified: verifyCommand · .* did not finish — verifyCommand timed out after 300ms\./);
  assert.doesNotMatch(summary, /Done — verified|your judgment: verifyCommand/, "the reason is the outcome, not a judgment call");
  const text = formatReport(report);
  assert.match(text, /verdict: INCOMPLETE/);
  assert.match(text, /\? REQUIRED verifyCommand · /);
  assert.match(formatReportMarkdown(report), /\*\*INCOMPLETE\*\*/);
  // the held promise is still reported as held
  assert.ok(report.items.some((i) => i.clauseKind === "no-new-dependency" && i.verdict === "held"));
});

test("incomplete: a tests-pass run that times out, and an output check that cannot finish, are incomplete too", async () => {
  const tests = await setup([{ kind: "tests-pass", glob: "test/*.test.js" }]);
  const slowTests = await runWithLock(tests.root, tests.lock.id, edit, { stdio: "pipe", verifyOptions: { testTimeoutMs: 1 } });
  assert.equal(slowTests.verdict, "incomplete", slowTests.record.incomplete?.join("; "));
  assert.match(slowTests.record.incomplete![0], /^NOT RUN tests-pass · test\/\*\.test\.js: test run timed out/);

  // Fast at the baseline, hangs after the change: the output was never compared.
  const out = await setup([{ kind: "output-unchanged", command: "node src/render.js" }]);
  const hung = await runWithLock(out.root, out.lock.id, [NODE, "-e", append("src/math.js", "for(;;){}\n")], { stdio: "pipe", verifyOptions: { outputTimeoutMs: 1500 } });
  assert.equal(hung.verdict, "incomplete", hung.record.violations.join("; "));
  assert.match(hung.record.incomplete![0], /^NOT RUN output-unchanged · node src\/render\.js: command could not run at verify time: timed out/);
});

test("incomplete: a violation beats a check that did not finish — failed, exit 1", async () => {
  const { root, lock } = await setup([], (l) => {
    l.verifyCommand = SLOW;
    l.verifyTimeoutMs = 300;
  });
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/secret.js", "// x\n")], { stdio: "pipe" });
  assert.equal(outcome.verdict, "failed");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.record.incomplete?.length, 1, "still named");
  assert.match(formatRunReport(outcome), /Also not run \(1\):/);
  assert.equal(loadLock(root, lock.id)!.status, "failed");

  const report = await buildReport(root, lock.id, { verification: outcome.record.verification, run: outcome.record });
  assert.equal(report.verdict, "failed");
  assert.match(summarizeReport(report), /^Blocked: src\/secret\.js is off-limits/);
});

test("incomplete: custom clauses and the ladder's own typecheck are named, not required — the run is verified", async () => {
  const { root, lock } = await setup([{ kind: "custom", text: "still reads well" }]);
  const outcome = await runWithLock(root, lock.id, edit, { stdio: "pipe" });
  const unchecked = outcome.record.verification!.items.filter((i) => i.verdict === "unchecked").map((i) => i.source);
  assert.deepEqual(unchecked.sort(), ["keep-clause", "typecheck"], "both are in the Unchecked bucket");
  assert.equal(outcome.verdict, "verified");
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.record.incomplete, []);
});

test("incomplete: which checks are required", () => {
  const item = (over: Partial<VerificationItem>): VerificationItem => ({
    source: "keep-clause", subject: "s", verdict: "unchecked", evidenceClass: "unchecked", detail: "d", ...over,
  });
  assert.equal(isRequiredCheck(item({ source: "verify-command" })), true);
  for (const kind of ["api-unchanged", "no-new-dependency", "tests-pass", "output-unchanged"] as const) {
    assert.equal(isRequiredCheck(item({ clauseKind: kind })), true, kind);
  }
  assert.equal(isRequiredCheck(item({ clauseKind: "custom" })), false);
  assert.equal(isRequiredCheck(item({ source: "typecheck" })), false);

  assert.equal(runVerdict(true, [], []), "verified");
  assert.equal(runVerdict(true, [], ["NOT RUN x: y"]), "incomplete");
  assert.equal(runVerdict(true, ["DENY: a"], ["NOT RUN x: y"]), "failed");
  assert.equal(runVerdict(false, [], ["NOT RUN x: y"]), "failed");
});

test("incomplete: a standalone verify with no baseline cannot verify what needs one", async () => {
  const { root, lock } = await setup([{ kind: "api-unchanged", symbols: ["src/math.js#add"] }]);
  const report = await buildReport(root, lock.id);
  assert.equal(report.verdict, "incomplete");
  assert.match(report.incomplete[0], /^NOT RUN api-unchanged · src\/math\.js#add: no pre-change baseline/);
  finalizeLockStatus(root, report);
  assert.equal(loadLock(root, lock.id)!.status, "incomplete");
});

test("incomplete: with verification switched off, required clauses and the verifyCommand did not run", async () => {
  const { root, lock } = await setup(
    [{ kind: "api-unchanged", symbols: ["src/math.js#nope"] }, { kind: "tests-pass", glob: "test/*.test.js" }],
    (l) => {
      l.verifyCommand = "npm test";
    },
  );
  const outcome = await runWithLock(root, lock.id, edit, { stdio: "pipe", verify: false });
  assert.equal(outcome.verdict, "incomplete");
  assert.deepEqual(outcome.record.incomplete, [
    "NOT RUN api-unchanged: src/math.js#nope — not captured in the baseline (did not resolve pre-run)",
    "NOT RUN tests-pass: test/*.test.js — not run: verification disabled",
    "NOT RUN verifyCommand · npm test: verification disabled",
  ]);
});

test("incomplete: an incomplete lock edited after approval is refused, like verified and failed ones", async () => {
  const { root, lock } = await setup([], (l) => {
    l.verifyCommand = SLOW;
    l.verifyTimeoutMs = 300;
  });
  await runWithLock(root, lock.id, edit, { stdio: "pipe" });
  assert.equal(loadLock(root, lock.id)!.status, "incomplete");
  const p = lockPathFor(root, lock.id)!;
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/deny:\n(  - .*\n)+/, "deny: []\n"));
  await assert.rejects(
    () => runWithLock(root, lock.id, [NODE, "-e", append("src/secret.js", "// x\n")], { stdio: "pipe" }),
    (e: unknown) => e instanceof RunError && /seal mismatch/.test((e as Error).message),
  );
  assert.equal(fs.readFileSync(path.join(root, "src/secret.js"), "utf8"), FILES["src/secret.js"]);
});

test("incomplete: the CLI — run and verify exit 3 until the check finishes, then verify exits 0 and the lock is verified", () => {
  // The audit's reproduction, through the command line. cwd is the temp
  // repo too, so nothing here can reach another repository.
  const root = makeGitRepo(FILES);
  const cdir = (args: string[], command: string[] = []) =>
    spawnSync(NODE, [CLI, ...args, "--root", root, ...(command.length > 0 ? ["--", ...command] : [])], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
  cdir(["lock", "new", "edit math", "--budget-files", "src/math.js", "--verify-command", SLOW]);
  const lockDir = path.join(root, ".codedirector", "locks");
  const file = path.join(lockDir, fs.readdirSync(lockDir)[0]);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^verifyCommand: .*$/m, (m) => `${m}\nverifyTimeoutMs: 300`));
  const act = cdir(["lock", "activate", "IL-0001"]);
  assert.equal(act.status, 0, act.stderr);

  const run = cdir(["run", "IL-0001"], edit);
  assert.equal(run.status, 3, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /Done — verified/);
  assert.match(run.stdout, /Not verified: verifyCommand · .* did not finish — verifyCommand timed out after 300ms/);

  const again = cdir(["verify", "IL-0001"]);
  assert.equal(again.status, 3, again.stdout + again.stderr);
  assert.match(again.stdout, /verdict: INCOMPLETE/);

  const longer = cdir(["verify", "IL-0001", "--test-timeout", "20000"]);
  assert.equal(longer.status, 0, longer.stdout + longer.stderr);
  assert.match(longer.stdout, /^Done — verified\./);
  assert.equal(loadLock(root, "IL-0001")!.status, "verified");
});

test("incomplete: run_locked over MCP is an error that says not verified, never a success", async () => {
  const { root, lock } = await setup([], (l) => {
    l.verifyCommand = SLOW;
    l.verifyTimeoutMs = 300;
  });
  const transport = new StdioClientTransport({ command: NODE, args: [CLI, "mcp", "--root", root], stderr: "pipe" });
  const client = new Client({ name: "cdir-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const r = (await client.callTool({ name: "run_locked", arguments: { lockId: lock.id, command: edit } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const text = r.content.map((c) => c.text).join("\n");
    assert.equal(r.isError, true, text.slice(0, 300));
    assert.match(text, new RegExp(`^run ${lock.id} INCOMPLETE — nothing was violated, but a required check did not finish`));
    assert.doesNotMatch(text, /succeeded|Done — verified/);
  } finally {
    await client.close();
  }
});
