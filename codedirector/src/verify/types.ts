/**
 * Verification engine types (blueprint §17): every claim the system makes
 * carries exactly one evidence class, and the Unchecked bucket is always
 * named, never silently empty.
 *
 * Evidence classes:
 *  - measured:   observed differentially, pre and post, same harness
 *                (test runs, output hashes, verifyCommand)
 *  - proven:     structurally guaranteed, no execution needed
 *                (signature hash match, manifest diff, clean typecheck)
 *  - asserted:   claimed without a differential check; a claim without an
 *                artifact reference is automatically Asserted (enforced in
 *                code by enforceArtifactRule, not by discipline)
 *  - unchecked:  no check exists or none could run — named, with the reason
 */

import { KeepClauseKind } from "../lock/types";
import { PutBack } from "../run/tree";

export type EvidenceClass = "measured" | "proven" | "asserted" | "unchecked";

export const EVIDENCE_CLASSES: EvidenceClass[] = ["proven", "measured", "asserted", "unchecked"];

/** held = the claim was checked and held · violated = checked and broken · unchecked = no check ran */
export type Verdict = "held" | "violated" | "unchecked";

export type VerificationSource = "keep-clause" | "typecheck" | "verify-command";

export interface VerificationItem {
  source: VerificationSource;
  /** Present when source is "keep-clause". */
  clauseKind?: KeepClauseKind;
  /** Short label, e.g. "api-unchanged · src/util.js#add". */
  subject: string;
  verdict: Verdict;
  evidenceClass: EvidenceClass;
  /** What was found (e.g. "signature changed: src/util.js#add"). */
  detail: string;
  /**
   * Pointer to the evidence: which baseline file, which command, which exit
   * code. A held claim without an artifactRef is downgraded to Asserted by
   * enforceArtifactRule — schema-enforced, not voluntary.
   */
  artifactRef?: string;
  /** Why the claim is unchecked (required when verdict is "unchecked"). */
  reason?: string;
}

/** What one probe (a verifyCommand, a test run, the typecheck…) left behind and had put back. */
export interface ProbePutBack extends PutBack {
  /** The check that ran: "verifyCommand · npm test". */
  probe: string;
}

export interface VerificationReport {
  lockId: string;
  verifiedAt: string;
  /** Baseline the differential checks ran against (repo-relative), if any. */
  baselinePath?: string;
  /** True when the baseline file's hash no longer matches the run record. */
  baselineTampered?: boolean;
  items: VerificationItem[];
  /**
   * Files a probe changed or added, put back as they were before it — with
   * where its versions were moved. Absent when every probe left the tree as
   * it found it. Includes the baseline's probes when a run passes them in.
   */
  putBack?: ProbePutBack[];
  /** "KEEP <kind>: <detail>" / "VERIFY <source>: <detail>" for every violated item. */
  violations: string[];
  /**
   * "NOT RUN <subject>: <reason>" for every required check that did not
   * finish (see isRequiredCheck). Any entry makes the outcome incomplete —
   * never verified.
   */
  incomplete: string[];
  /** Items per evidence class (all four keys always present). */
  counts: Record<EvidenceClass, number>;
}

/**
 * A check the Lock itself asks for: every KEEP clause but custom, and the
 * verifyCommand. When one of these did not finish — timed out, could not
 * run, had no baseline to compare against — the run is not verified: it is
 * incomplete, whatever else held. Reproduced before this rule: a
 * verifyCommand stopped by its timeout still ended "Done — verified", exit
 * 0, because only violations could block the verdict.
 *
 * Not required, and only named in the Unchecked bucket: a custom clause
 * (a human judges it, by definition), and the typecheck the ladder adds on
 * its own (the Lock did not ask for it; a Lock that needs it puts it in the
 * verifyCommand).
 */
export function isRequiredCheck(item: VerificationItem): boolean {
  if (item.source === "verify-command") return true;
  return item.source === "keep-clause" && item.clauseKind !== undefined && item.clauseKind !== "custom";
}

/** The required checks that did not finish, as "NOT RUN <subject>: <reason>". */
export function incompleteChecks(items: VerificationItem[]): string[] {
  return items
    .filter((i) => i.verdict === "unchecked" && isRequiredCheck(i))
    .map((i) => `NOT RUN ${i.subject}: ${i.reason ?? i.detail}`);
}

export function countByClass(items: VerificationItem[]): Record<EvidenceClass, number> {
  const counts: Record<EvidenceClass, number> = { proven: 0, measured: 0, asserted: 0, unchecked: 0 };
  for (const item of items) counts[item.evidenceClass]++;
  return counts;
}

/**
 * The schema law from blueprint §14/§22: a claim without an artifact
 * reference is automatically Asserted. Applied to every report before
 * rendering; violations keep their class (a broken check IS the artifact,
 * recorded in detail), only "held" claims can be downgraded.
 */
export function enforceArtifactRule(items: VerificationItem[]): VerificationItem[] {
  return items.map((item) => {
    if (
      item.verdict === "held" &&
      (item.evidenceClass === "proven" || item.evidenceClass === "measured") &&
      !item.artifactRef
    ) {
      return {
        ...item,
        evidenceClass: "asserted",
        detail: `${item.detail} (no artifact reference — downgraded to Asserted by schema rule)`,
      };
    }
    return item;
  });
}
