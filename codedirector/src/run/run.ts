/**
 * `cdir run <lock-id> -- <command...>` — the verified-execution wrapper.
 *
 * Loop (blueprint §16, descoped to Stage 2):
 *   1. Load the ACTIVE Lock (drafts must be activated first).
 *   2. Checkpoint (git tag) before anything.
 *   3. Refresh the index; capture the KEEP baseline (signatures, manifests,
 *      git status) to .codedirector/baselines/ — outside the source tree.
 *   4. Execute the command with inherited stdio.
 *   5. Classify every changed file against the Lock; diff the baseline.
 *      Denied / out-of-budget changes are violations (unless --allow-expand,
 *      a logged override). Nothing is auto-reverted — the human decides.
 *   6. Write the run record to .codedirector/runs/.
 *
 * Exit code: 0 verified — the command succeeded, nothing was violated and
 * every check the Lock requires ran; 1 failed; 3 incomplete — nothing was
 * violated, but a required check did not finish (RUN_EXIT).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { RepoIndex } from "../core/types";
import { buildIndex } from "../core/builder";
import { ensureCodedirectorIgnore, indexDir, stableStringify } from "../core/store";
import { createCheckpoint, Checkpoint } from "../checkpoint";
import { VibeCheck } from "../lock/types";
import { defaultDomains, DomainRegistry } from "../domain/registry";
import { loadLock, saveLock } from "../lock/store";
import { sealViolation } from "../lock/seal";
import { apiHash, apiSignatures, describeApiChange, unindexedReason } from "../lock/check";
import { Baseline, baselineFileHash, captureBaseline, saveBaseline } from "./baseline";
import {
  changedFiles,
  changedLineCount,
  ClassifiedChange,
  classifyChanges,
  fingerprint,
  scopeViolations,
} from "./classify";
import { verifyWithBaseline, VerifyOptions } from "../verify/verify";
import { ProbePutBack, VerificationReport } from "../verify/types";

/** Exit codes of a run, a verify and a report. 2 stays the CLI's usage error. */
export const RUN_EXIT = { verified: 0, failed: 1, incomplete: 3 } as const;

export type RunVerdict = keyof typeof RUN_EXIT;

/** failed beats incomplete beats verified: a broken promise is the first thing to know. */
export function runVerdict(commandSucceeded: boolean, violations: string[], incomplete: string[]): RunVerdict {
  if (!commandSucceeded || violations.length > 0) return "failed";
  return incomplete.length > 0 ? "incomplete" : "verified";
}

export interface KeepResult {
  kind: string;
  detail: string;
  /** ok = verified held · violated = proven broken · deferred = no check could run · custom = human judges */
  status: "ok" | "violated" | "deferred" | "custom";
}

export interface BudgetStats {
  filesChanged: number;
  maxFiles: number;
  linesChanged: number;
  maxLines: number;
}

export interface RunRecord {
  lockId: string;
  command: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  checkpoint: Checkpoint;
  baselinePath: string;
  /** sha256 of the baseline file at capture time — tamper detection. */
  baselineSha256?: string;
  changed: ClassifiedChange[];
  /**
   * Each changed file's bytes as the run left them (sha256, or "absent" for
   * a file it deleted): what a later report compares the tree with to name
   * the files changed after the run. Absent in records written before it
   * existed.
   */
  changedHashes?: Record<string, string>;
  budget: BudgetStats;
  keepResults: KeepResult[];
  violations: string[];
  /**
   * Required checks that did not finish ("NOT RUN <subject>: <reason>").
   * Any entry and the run is incomplete, not verified. Absent in records
   * written before it existed.
   */
  incomplete?: string[];
  /** True when --allow-expand downgraded scope violations to logged overrides. */
  allowExpand: boolean;
  /** Full verification-ladder result (present unless run with verify disabled). */
  verification?: VerificationReport;
}

export class RunError extends Error {}

export function runsDir(rootDir: string): string {
  return path.join(indexDir(rootDir), "runs");
}

export interface RunOptions {
  allowExpand?: boolean;
  /** stdio for the child command (default "inherit"; tests may use "pipe"). */
  stdio?: "inherit" | "pipe";
  /** Run the verification ladder after execution (default true). */
  verify?: boolean;
  /** Options passed through to the verifier (timeouts, env, typecheck toggle). */
  verifyOptions?: VerifyOptions;
  /** Update the Lock's status after the run (verified/incomplete/failed; default true). */
  updateStatus?: boolean;
}

export interface RunOutcome {
  record: RunRecord;
  recordPath: string;
  verdict: RunVerdict;
  /** RUN_EXIT[verdict]: 0 verified · 1 failed · 3 incomplete. */
  exitCode: number;
}

function checkKeepClauses(
  rootDir: string,
  lock: VibeCheck,
  baseline: Baseline,
  indexAfter: RepoIndex,
  domains: DomainRegistry,
): KeepResult[] {
  const results: KeepResult[] = [];
  for (const clause of lock.keep) {
    switch (clause.kind) {
      case "api-unchanged": {
        for (const id of clause.symbols ?? []) {
          const before = baseline.signatures[id];
          const after = apiSignatures(indexAfter, id);
          const unindexed = unindexedReason(indexAfter, id);
          if (unindexed) {
            results.push({ kind: clause.kind, detail: `${id} — ${unindexed}`, status: "deferred" });
          } else if (before === undefined) {
            results.push({ kind: clause.kind, detail: `${id} — not captured in the baseline (did not resolve pre-run)`, status: "deferred" });
          } else if (after.length === 0) {
            results.push({ kind: clause.kind, detail: `${id} no longer exists`, status: "violated" });
          } else if (apiHash(after) !== before) {
            results.push({ kind: clause.kind, detail: describeApiChange(id, baseline.signatureTexts?.[id], after), status: "violated" });
          } else {
            results.push({ kind: clause.kind, detail: `signature unchanged: ${id}`, status: "ok" });
          }
        }
        break;
      }
      case "no-new-dependency": {
        for (const [m, before] of Object.entries(baseline.manifests)) {
          const p = path.join(rootDir, m);
          if (!fs.existsSync(p)) {
            results.push({ kind: clause.kind, detail: `${m} deleted`, status: "violated" });
            continue;
          }
          // The same fingerprint the baseline took (package.json's is its
          // dependency maps): a raw hash here reported every package.json as
          // changed whenever verification was switched off.
          const after = domains.manifestFingerprint(m, fs.readFileSync(p, "utf8"));
          results.push(
            after === before
              ? { kind: clause.kind, detail: `${m} unchanged`, status: "ok" }
              : { kind: clause.kind, detail: `${m} changed`, status: "violated" },
          );
        }
        // a manifest that did not exist before but exists now is a new dependency surface
        for (const { path: m } of domains.dependencyManifests()) {
          if (!(m in baseline.manifests) && fs.existsSync(path.join(rootDir, m))) {
            results.push({ kind: clause.kind, detail: `${m} appeared`, status: "violated" });
          }
        }
        break;
      }
      case "output-unchanged":
        results.push({
          kind: clause.kind,
          detail: `${clause.command ?? "(no command)"} — not run: verification disabled`,
          status: "deferred",
        });
        break;
      case "tests-pass":
        results.push({
          kind: clause.kind,
          detail: `${clause.glob ?? "(no glob)"} — not run: verification disabled`,
          status: "deferred",
        });
        break;
      case "custom":
        results.push({
          kind: clause.kind,
          detail: `${clause.text ?? ""} — not machine-checkable; human judges`,
          status: "custom",
        });
        break;
    }
  }
  return results;
}

/** Map verification items back onto the Stage 2 KeepResult record shape. */
function keepResultsFromVerification(report: VerificationReport): KeepResult[] {
  return report.items
    .filter((i) => i.source === "keep-clause")
    .map((i) => {
      const kind = i.clauseKind ?? "custom";
      if (i.verdict === "held") return { kind, detail: i.detail, status: "ok" as const };
      if (i.verdict === "violated") return { kind, detail: i.detail, status: "violated" as const };
      if (kind === "custom") {
        const text = i.subject.replace(/^custom · /, "");
        return { kind, detail: `${text} — not machine-checkable; human judges`, status: "custom" as const };
      }
      const label = i.subject.includes(" · ") ? i.subject.slice(i.subject.indexOf(" · ") + 3) : i.subject;
      return { kind, detail: `${label} — unchecked: ${i.reason ?? i.detail}`, status: "deferred" as const };
    });
}

export async function runWithLock(
  rootDir: string,
  lockId: string,
  command: string[],
  opts: RunOptions = {},
): Promise<RunOutcome> {
  if (command.length === 0) throw new RunError("no command given — usage: cdir run <lock-id> -- <command...>");

  const lock = loadLock(rootDir, lockId);
  if (!lock) throw new RunError(`no such lock: ${lockId} (see \`cdir lock ls\`)`);
  if (lock.status === "draft") {
    throw new RunError(`lock ${lockId} is a draft — review it and run \`cdir lock activate ${lockId}\` first`);
  }
  if (lock.status === "abandoned") {
    throw new RunError(`lock ${lockId} has status "abandoned" — it cannot run again`);
  }
  // Sealed contract: an active Lock whose content drifted from the approved
  // hash refuses to run until the user re-approves (lock check + activate).
  const seal = sealViolation(rootDir, lock);
  if (seal) throw new RunError(seal);

  ensureCodedirectorIgnore(rootDir);

  // 1. checkpoint before anything
  const checkpoint = createCheckpoint(rootDir);

  // 2. refresh index + capture baseline (outside the source tree)
  const domains = opts.verifyOptions?.domains ?? defaultDomains();
  const { index: indexBefore } = await buildIndex(rootDir, { domains });
  const vo = opts.verify === false ? { typecheck: false } : (opts.verifyOptions ?? {});
  // What any probe — before the command or after it — changed and had put back: the report names it.
  const putBack: ProbePutBack[] = [];
  const baseline: Baseline = captureBaseline(rootDir, lock, indexBefore, checkpoint.tag, {
    typecheck: vo.typecheck,
    typecheckTimeoutMs: vo.typecheckTimeoutMs,
    env: vo.env,
    putBack,
    domains,
  });
  const baselinePath = saveBaseline(rootDir, baseline);
  // Hash the baseline at capture: the executed command could edit files under
  // .codedirector/baselines/ and fake a "held" verdict. The hash goes into
  // the run record; verify re-hashes and invalidates on mismatch. (True
  // oracle separation — baseline outside the writable tree — is a later phase.)
  const baselineSha256 = baselineFileHash(baselinePath);

  // 3. execute
  const startedAt = new Date().toISOString();
  const child = spawnSync(command[0], command.slice(1), {
    cwd: rootDir,
    stdio: opts.stdio ?? "inherit",
    shell: false,
  });
  const finishedAt = new Date().toISOString();
  const commandExit = child.error ? 127 : (child.status ?? 1);

  // 4. classify changes against the Lock (delta vs pre-run baseline, not vs HEAD)
  const changed = classifyChanges(rootDir, lock, baseline);
  const untracked = changedFiles(rootDir, baseline)
    .filter((c) => c.status === "??" || c.status === "!!")
    .map((c) => c.path);
  const linesChanged = changedLineCount(rootDir, untracked, baseline);
  const budget: BudgetStats = {
    filesChanged: changed.length,
    maxFiles: lock.budget.maxFiles,
    linesChanged,
    maxLines: lock.budget.maxLines,
  };

  // 5. verification ladder against the baseline (Stage 3): structural diffs,
  //    typecheck, tests, verifyCommand, output hashes, custom. keepResults on
  //    the record are derived from it; with verify disabled we fall back to
  //    the Stage 2 structural-only diff.
  const { index: indexAfter } = await buildIndex(rootDir, { domains });
  const baselineRel = path.relative(rootDir, baselinePath).split(path.sep).join("/");
  const verification =
    opts.verify === false
      ? undefined
      : verifyWithBaseline(rootDir, lock, baseline, baselineRel, indexAfter, {
          expectedBaselineSha256: baselineSha256,
          ...opts.verifyOptions,
          putBack,
        });
  const keepResults = verification
    ? keepResultsFromVerification(verification)
    : checkKeepClauses(rootDir, lock, baseline, indexAfter, domains);

  // One wording, one place: a standalone verify rebuilds these from the same
  // function when it judges this run against a Lock that has since changed.
  const scope = scopeViolations(changed, budget);
  const keepViolations = verification
    ? verification.violations
    : keepResults
        .filter((r) => r.status === "violated")
        .map((r) => `KEEP ${r.kind}: ${r.detail}`);

  const allowExpand = opts.allowExpand === true;
  // --allow-expand is the logged override for SCOPE growth only; a broken
  // KEEP clause is never overridden (the rule that gives the Lock teeth).
  const violations = allowExpand ? keepViolations : [...scope, ...keepViolations];
  // What the Lock requires and nobody checked. With verification off, that
  // is every deferred clause and the verifyCommand, which did not run.
  const incomplete = verification
    ? verification.incomplete
    : [
        ...keepResults.filter((r) => r.status === "deferred").map((r) => `NOT RUN ${r.kind}: ${r.detail}`),
        ...(lock.verifyCommand ? [`NOT RUN verifyCommand · ${lock.verifyCommand}: verification disabled`] : []),
      ];

  const record: RunRecord = {
    lockId: lock.id,
    command,
    startedAt,
    finishedAt,
    exitCode: commandExit,
    checkpoint,
    baselinePath: path.relative(rootDir, baselinePath),
    baselineSha256,
    changed,
    changedHashes: Object.fromEntries(changed.map((c) => [c.path, fingerprint(rootDir, c.path)])),
    budget,
    keepResults,
    violations,
    incomplete,
    allowExpand,
    ...(verification ? { verification } : {}),
  };
  fs.mkdirSync(runsDir(rootDir), { recursive: true });
  const ts = startedAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const recordPath = path.join(runsDir(rootDir), `${lock.id}-${ts}.json`);
  fs.writeFileSync(recordPath, stableStringify(record), "utf8");

  const verdict = runVerdict(commandExit === 0, violations, incomplete);

  // The Lock's status is the latest verdict.
  if (opts.updateStatus !== false) {
    lock.status = verdict;
    saveLock(rootDir, lock);
  }

  return { record, recordPath, verdict, exitCode: RUN_EXIT[verdict] };
}

/** Human-readable violation report printed after a failed run. */
export function formatRunReport(outcome: RunOutcome): string {
  const r = outcome.record;
  const lines: string[] = [];
  lines.push(
    `run ${r.lockId} · command exited ${r.exitCode} · ` +
      `${r.changed.length} file(s) changed (${r.budget.filesChanged}/${r.budget.maxFiles} files, ` +
      `${r.budget.linesChanged}/${r.budget.maxLines} lines)`,
  );
  lines.push(`checkpoint: ${r.checkpoint.tag} — restore with \`cdir undo\``);
  lines.push(`record: ${outcome.recordPath}`);
  if (r.keepResults.length > 0) {
    lines.push(`KEEP:`);
    for (const k of r.keepResults) {
      const mark = k.status === "ok" ? "✓" : k.status === "violated" ? "✗" : k.status === "deferred" ? "~" : "?";
      lines.push(`  ${mark} ${k.kind}: ${k.detail}`);
    }
  }
  if (r.changed.length > 0) {
    lines.push(`changed files:`);
    for (const c of r.changed) {
      const tag =
        c.class === "denied" ? "DENIED" : c.class === "out-of-budget" ? "OUT-OF-BUDGET" : "in-budget";
      lines.push(`  ${c.path}  [${tag}]`);
    }
  }
  if (r.violations.length > 0) {
    lines.push(``, `VIOLATIONS (${r.violations.length}):`);
    for (const v of r.violations) lines.push(`  ✗ ${v}`);
    lines.push(
      ``,
      `Nothing was reverted automatically — you decide:`,
      `  cdir undo            restore the checkpoint (${r.checkpoint.tag})`,
      `  cdir run ${r.lockId} --allow-expand -- ...   re-run accepting the expanded scope (logged override)`,
    );
  } else if (r.allowExpand) {
    lines.push(``, `note: --allow-expand was passed; out-of-budget scope was accepted (logged override).`);
  }
  const incomplete = r.incomplete ?? [];
  if (outcome.verdict === "incomplete") {
    lines.push(``, `NOT VERIFIED — ${incomplete.length} required check(s) did not finish:`);
    for (const i of incomplete) lines.push(`  ? ${i}`);
    const recheck = incomplete.some((i) => /timed out/.test(i))
      ? `  cdir verify ${r.lockId} --test-timeout <ms>   check again, with more time for tests and the verifyCommand`
      : `  cdir verify ${r.lockId}   check again once the reason above is dealt with`;
    lines.push(
      ``,
      `Nothing was violated and nothing was reverted, but nothing is verified either. You decide:`,
      recheck,
      `  cdir undo            restore the checkpoint (${r.checkpoint.tag})`,
    );
  } else if (incomplete.length > 0) {
    lines.push(``, `Also not run (${incomplete.length}):`);
    for (const i of incomplete) lines.push(`  ? ${i}`);
  }
  return lines.join("\n");
}
