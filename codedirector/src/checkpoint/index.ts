/**
 * Checkpoint / undo — the safety net that makes low-friction approval
 * defensible (blueprint §19): checkpoint before every execution, one
 * command to restore, no understanding required.
 *
 * Strategy: git tag `cdir/ckpt-<timestamp>` at HEAD, plus a byte snapshot of
 * dirty / untracked / skip-worktree files under .codedirector/ckpt-blobs/.
 * Undo resets --hard to the tagged ref, then restores that snapshot so a
 * checkpoint taken over a dirty tree actually comes back (including
 * skip-worktree files that `git reset --hard` would otherwise leave), and
 * removes again what was absent at checkpoint time.
 *
 * What undo will change is computed once, as a plan (`planUndo`): every file
 * as it is now against the file as it was at the checkpoint. The refusal
 * preview, the result and the post-undo check are all that one plan.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isGitRepo } from "../core/git";
import { indexDir, stableStringify } from "../core/store";

export interface Checkpoint {
  /** "ckpt-<yyyymmddThhmmssmmm>" */
  id: string;
  /** Git tag: "cdir/ckpt-<...>" */
  tag: string;
  /** HEAD commit sha at checkpoint time. */
  ref: string;
  createdAt: string;
  /** True when the working tree had uncommitted changes at checkpoint time. */
  dirty: boolean;
  /** sha256 of `git status --porcelain` output at checkpoint time. */
  statusHash: string;
  /** Relative dir under .codedirector holding dirty-file bytes, when dirty. */
  blobDir?: string;
}

export interface UndoRecord {
  at: string;
  checkpointId: string;
  ref: string;
  forced: boolean;
  /** Files that differed from the checkpoint and were put back. */
  lostFiles: string[];
}

interface CheckpointStore {
  checkpoints: Checkpoint[];
  undos: UndoRecord[];
}

export function checkpointsPath(rootDir: string): string {
  return path.join(indexDir(rootDir), "checkpoints.json");
}

function loadStore(rootDir: string): CheckpointStore {
  const p = checkpointsPath(rootDir);
  if (!fs.existsSync(p)) return { checkpoints: [], undos: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as CheckpointStore;
    return { checkpoints: data.checkpoints ?? [], undos: data.undos ?? [] };
  } catch {
    return { checkpoints: [], undos: [] };
  }
}

function saveStore(rootDir: string, store: CheckpointStore): void {
  fs.mkdirSync(indexDir(rootDir), { recursive: true });
  fs.writeFileSync(checkpointsPath(rootDir), stableStringify(store), "utf8");
}

function git(rootDir: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    ...(input !== undefined ? { input } : { stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[] }),
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function unquotePath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replace(/\\"/g, '"');
  return p;
}

/** Paths on one porcelain line: rename SOURCE and target both included. */
export function porcelainLinePaths(line: string): string[] {
  if (!line.trim()) return [];
  let rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  if (arrow !== -1) {
    return [unquotePath(rest.slice(0, arrow)), unquotePath(rest.slice(arrow + 4))];
  }
  return [unquotePath(rest)];
}

/** Paths reported by `git status --porcelain` (rename source AND target). */
export function dirtyPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    out.push(...porcelainLinePaths(line));
  }
  return [...new Set(out)].sort();
}

/**
 * `git status --porcelain`, untracked files listed one by one. Without
 * `--untracked-files=all` git collapses an untracked folder to a single
 * `?? dir/` line: the checkpoint cannot read it (EISDIR), the baseline cannot
 * hash it, and a folder that existed before a run read as that run's change
 * (eDraft IL-0028, .githooks/). Every consumer wants files, not folders.
 */
export function gitStatusPorcelain(rootDir: string): string {
  return git(rootDir, ["status", "--porcelain", "--untracked-files=all"]);
}

/**
 * `git status --porcelain` with Code Director's own state directory
 * (.codedirector/) filtered out — locks, baselines, and run records are
 * tool state, not user work, and must not count as "dirty".
 */
export function workTreeStatusPorcelain(rootDir: string): string {
  return gitStatusPorcelain(rootDir)
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      // A dirty .gitignore is the user's work: cdir never writes it (IL-0020).
      return !dirtyPaths(line).some((p) => p.split("/").includes(".codedirector"));
    })
    .join("\n");
}

/**
 * Prefix of rootDir within its git work tree ("" when rootDir IS the git
 * root). Git reports paths relative to the work-tree root; when rootDir is
 * a subdirectory, callers must translate.
 */
export function gitPrefix(rootDir: string): string {
  try {
    return git(rootDir, ["rev-parse", "--show-prefix"]).trim();
  } catch {
    return "";
  }
}

/**
 * Translate a git-root-relative path to rootDir-relative. Returns null when
 * the path lies outside rootDir's subtree.
 */
export function toRootRelative(prefix: string, gitPath: string): string | null {
  if (!prefix) return gitPath;
  if (gitPath.startsWith(prefix)) return gitPath.slice(prefix.length);
  return null;
}

function timestampId(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`
  );
}

export class CheckpointError extends Error {}

interface BlobMeta {
  hidden: Array<{ path: string; flag: "S" | "h" }>;
  untracked: string[];
  files: string[];
  /**
   * Paths git lists that did not exist at checkpoint time — deleted, or a
   * rename's source. `git reset --hard` recreates them, so undo removes them
   * again. Absent in checkpoints made before this was recorded.
   */
  absent?: string[];
}

function blobRoot(rootDir: string, id: string): string {
  return path.join(indexDir(rootDir), "ckpt-blobs", id);
}

/**
 * Absolute path for a git-root-relative path. rootDir may be a subdirectory
 * of the git work tree — translate via the prefix (walking up with ../ for
 * paths outside rootDir's subtree).
 */
function gitPathAbs(rootDir: string, gitPath: string): string {
  const prefix = gitPrefix(rootDir);
  if (!prefix) return path.join(rootDir, gitPath);
  const rel = toRootRelative(prefix, gitPath);
  if (rel !== null) return path.join(rootDir, rel);
  const up = prefix.split("/").filter(Boolean).map(() => "..").join("/");
  return path.resolve(rootDir, up, gitPath);
}

function writeCheckpointBlobs(rootDir: string, id: string): string {
  const dir = blobRoot(rootDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const untracked: string[] = [];
  const absent: string[] = [];
  const hidden: BlobMeta["hidden"] = [];

  const status = gitStatusPorcelain(rootDir);
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const st = line.slice(0, 2);
    for (const p of porcelainLinePaths(line)) {
      if (p.split("/").includes(".codedirector")) continue;
      const abs = gitPathAbs(rootDir, p);
      try {
        const data = fs.readFileSync(abs);
        const dest = path.join(dir, "files", p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
        files.push(p);
      } catch {
        // Audit finding F1b: a file deleted before the checkpoint was skipped
        // here as "vanished", so undo's reset brought it back. Recorded now.
        if (!lexists(abs)) absent.push(p);
      }
      if (st === "??") untracked.push(p);
    }
  }

  try {
    const ls = git(rootDir, ["ls-files", "-v"]);
    for (const line of ls.split("\n")) {
      if (line.length < 3) continue;
      const flag = line[0];
      if (flag !== "S" && flag !== "h") continue;
      const p = line.slice(2);
      hidden.push({ path: p, flag });
      const abs = gitPathAbs(rootDir, p);
      try {
        const data = fs.readFileSync(abs);
        const dest = path.join(dir, "files", p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
        if (!files.includes(p)) files.push(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* not a git repo — shouldn't happen */
  }

  const meta: BlobMeta = {
    hidden,
    untracked: [...new Set(untracked)].sort(),
    files: [...new Set(files)].sort(),
    absent: [...new Set(absent)].sort(),
  };
  fs.writeFileSync(path.join(dir, "meta.json"), stableStringify(meta));
  return path.relative(indexDir(rootDir), dir).split(path.sep).join("/");
}

function restoreCheckpointBlobs(rootDir: string, id: string): void {
  const dir = blobRoot(rootDir, id);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) return;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as BlobMeta;

  for (const h of meta.hidden) {
    try {
      git(rootDir, [
        "update-index",
        h.flag === "S" ? "--no-skip-worktree" : "--no-assume-unchanged",
        "--",
        h.path,
      ]);
    } catch {
      /* ignore */
    }
  }

  for (const p of meta.files) {
    const src = path.join(dir, "files", p);
    if (!fs.existsSync(src)) continue;
    const dest = gitPathAbs(rootDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  for (const h of meta.hidden) {
    try {
      git(rootDir, [
        "update-index",
        h.flag === "S" ? "--skip-worktree" : "--assume-unchanged",
        "--",
        h.path,
      ]);
    } catch {
      /* ignore */
    }
  }

  // What was absent at the checkpoint is absent again (the reset recreated it).
  for (const p of meta.absent ?? []) {
    try {
      fs.rmSync(gitPathAbs(rootDir, p), { force: true });
    } catch {
      /* a directory now stands there — the post-undo check names it */
    }
  }
}

/** Whether a regular file (not a directory, not a symlink) is at this path. */
function isFile(abs: string): boolean {
  try {
    return fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Whether anything — a file, a directory, a dangling symlink — is at this path. */
function lexists(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function readMeta(rootDir: string, id: string): BlobMeta | null {
  const metaPath = path.join(blobRoot(rootDir, id), "meta.json");
  return fs.existsSync(metaPath) ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as BlobMeta) : null;
}

/** One file undo puts back, and how. */
export interface UndoChange {
  /** Git-root-relative path. */
  path: string;
  how: "reverted" | "restored" | "removed";
}

/** What undo will change: computed once, shown before, reported after, checked after. */
export interface UndoPlan {
  /** Files that differ from the checkpoint: put back as they were. */
  changes: UndoChange[];
  /** Untracked files created after the checkpoint: deleted, unless kept. */
  created: string[];
  /** Commits made since the checkpoint, which leave the branch. */
  commitsSince: number;
}

const HOW: Record<UndoChange["how"], string> = {
  reverted: "reverted to the checkpoint",
  restored: "restored (deleted after the checkpoint)",
  removed: "removed (absent at the checkpoint)",
};

/**
 * Every file as it is now against the file as it was at the checkpoint: the
 * snapshot's bytes where the checkpoint copied it (it was dirty, untracked
 * or hidden), absent where it recorded it absent, and otherwise the
 * checkpoint commit's content — compared the way git would store the file
 * (`hash-object` applies the path's filters), so line-ending and LFS
 * conversions are not mistaken for changes.
 *
 * The refusal used to list every path dirty NOW as "will be LOST" —
 * including untracked files and edits made before the checkpoint, which
 * undo restores exactly as they were (audit finding F1b).
 */
export function planUndo(rootDir: string, ckpt: Checkpoint): UndoPlan {
  const top = git(rootDir, ["rev-parse", "--show-toplevel"]).trim();
  const meta = readMeta(rootDir, ckpt.id);
  const snapshot = new Set(meta?.files ?? []);
  const absentThen = new Set(meta?.absent ?? []);
  const untrackedThen = new Set(meta?.untracked ?? []);
  const own = (p: string) => p.split("/").includes(".codedirector");

  const candidates = new Set<string>([...snapshot, ...absentThen]);
  const untrackedNow = new Set<string>();
  for (const line of gitStatusPorcelain(rootDir).split("\n")) {
    if (!line.trim()) continue;
    for (const p of porcelainLinePaths(line)) {
      candidates.add(p);
      if (line.startsWith("??")) untrackedNow.add(p);
    }
  }
  let commitsSince = 0;
  try {
    for (const p of git(top, ["diff", "--name-only", "-z", ckpt.ref, "HEAD"]).split("\0")) if (p) candidates.add(p);
    commitsSince = parseInt(git(top, ["rev-list", "--count", `${ckpt.ref}..HEAD`]).trim(), 10) || 0;
  } catch {
    /* the checkpoint commit is gone — the reset will say so */
  }

  const paths = [...candidates].filter((p) => !own(p)).sort();
  // The checkpoint commit's entry for each path that is neither in the
  // snapshot nor recorded absent. Not a file (a submodule): not undo's to judge.
  const fromRef = paths.filter((p) => !snapshot.has(p) && !absentThen.has(p));
  const refBlob = new Map<string, { sha: string; link: boolean }>();
  const notFiles = new Set<string>();
  for (let i = 0; i < fromRef.length; i += 200) {
    const out = git(top, ["ls-tree", "-r", "-z", "--full-tree", ckpt.ref, "--", ...fromRef.slice(i, i + 200)]);
    for (const entry of out.split("\0")) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(entry);
      if (!m) continue;
      if (m[2] === "blob") refBlob.set(m[4], { sha: m[3], link: m[1] === "120000" });
      else notFiles.add(m[4]);
    }
  }
  // A file as git would store it: the path's filters applied (hash-object);
  // a symlink as its target text, which is what git stores for one.
  const nowBlob = new Map<string, string>();
  const regular = fromRef.filter((p) => refBlob.has(p) && !refBlob.get(p)!.link && isFile(path.join(top, p)));
  if (regular.length > 0) {
    const shas = git(top, ["hash-object", "--stdin-paths"], regular.join("\n") + "\n").trim().split("\n");
    regular.forEach((p, i) => nowBlob.set(p, shas[i]));
  }
  for (const p of fromRef) {
    if (!refBlob.get(p)?.link) continue;
    try {
      const target = Buffer.from(fs.readlinkSync(path.join(top, p)));
      nowBlob.set(p, createHash("sha1").update(`blob ${target.length}\0`).update(target).digest("hex"));
    } catch {
      /* not a symlink now: differs */
    }
  }

  const changes: UndoChange[] = [];
  const created: string[] = [];
  const bytes = (abs: string): string | null => {
    try {
      return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    } catch {
      return null; // a directory, or unreadable: not the bytes the checkpoint kept
    }
  };
  for (const p of paths) {
    if (notFiles.has(p)) continue;
    const abs = path.join(top, p);
    const existsNow = lexists(abs);
    let existedThen: boolean;
    let same: boolean;
    if (absentThen.has(p)) {
      existedThen = false;
      same = !existsNow;
    } else if (snapshot.has(p)) {
      existedThen = true;
      const kept = bytes(path.join(blobRoot(rootDir, ckpt.id), "files", p));
      same = existsNow && kept !== null && kept === bytes(abs);
    } else if (refBlob.has(p)) {
      existedThen = true;
      same = existsNow && nowBlob.get(p) === refBlob.get(p)!.sha;
    } else {
      existedThen = false;
      same = !existsNow;
    }
    if (same) continue;
    if (!existedThen && untrackedNow.has(p) && !untrackedThen.has(p)) created.push(p);
    else changes.push({ path: p, how: !existsNow ? "restored" : existedThen ? "reverted" : "removed" });
  }
  return { changes, created, commitsSince };
}

/** The plan in words, one line per change — the refusal's preview. */
function describePlan(plan: UndoPlan, keepUntracked: boolean): string[] {
  const lines = plan.changes.map((c) => `  ${c.path} — ${HOW[c.how]}`);
  for (const p of plan.created) {
    lines.push(`  ${p} — ${keepUntracked ? "kept (created after the checkpoint; --keep-untracked)" : "deleted (created after the checkpoint)"}`);
  }
  if (plan.commitsSince > 0) {
    lines.push(
      `  ${plan.commitsSince === 1 ? "1 commit" : `${plan.commitsSince} commits`} made since the checkpoint ` +
        `${plan.commitsSince === 1 ? "leaves" : "leave"} the branch (still in the reflog)`,
    );
  }
  return lines;
}

function clearSkipFlags(rootDir: string): void {
  try {
    const ls = git(rootDir, ["ls-files", "-v"]);
    for (const line of ls.split("\n")) {
      if (line.length < 3) continue;
      const flag = line[0];
      if (flag !== "S" && flag !== "h") continue;
      try {
        git(rootDir, [
          "update-index",
          flag === "S" ? "--no-skip-worktree" : "--no-assume-unchanged",
          "--",
          line.slice(2),
        ]);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Delete the given git-root-relative paths; returns those actually removed. */
function deleteGitPaths(rootDir: string, paths: string[]): string[] {
  const removed: string[] = [];
  for (const p of paths) {
    try {
      fs.rmSync(gitPathAbs(rootDir, p), { recursive: true, force: true });
      removed.push(p);
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/** Create a checkpoint at HEAD. Requires a git repo with at least one commit. */
export function createCheckpoint(rootDir: string): Checkpoint {
  if (!isGitRepo(rootDir)) {
    throw new CheckpointError("not a git repository — checkpoints need git (run `git init` first)");
  }
  let ref: string;
  try {
    ref = git(rootDir, ["rev-parse", "HEAD"]).trim();
  } catch {
    throw new CheckpointError("no commits yet — make an initial commit before checkpointing");
  }
  const status = workTreeStatusPorcelain(rootDir);
  const id = `ckpt-${timestampId()}`;
  const tag = `cdir/${id}`;
  git(rootDir, ["tag", tag, ref]);

  const dirty = status.trim() !== "";
  let blobDir: string | undefined;
  // Always snapshot hidden flags / dirty bytes so skip-worktree files restore.
  blobDir = writeCheckpointBlobs(rootDir, id);

  const ckpt: Checkpoint = {
    id,
    tag,
    ref,
    createdAt: new Date().toISOString(),
    dirty,
    statusHash: createHash("sha256").update(status, "utf8").digest("hex"),
    blobDir,
  };
  const store = loadStore(rootDir);
  store.checkpoints.push(ckpt);
  saveStore(rootDir, store);
  return ckpt;
}

export function latestCheckpoint(rootDir: string): Checkpoint | null {
  const store = loadStore(rootDir);
  return store.checkpoints.length > 0 ? store.checkpoints[store.checkpoints.length - 1] : null;
}

export interface UndoResult {
  checkpoint: Checkpoint;
  forced: boolean;
  /** Files that differed from the checkpoint and were put back (the plan's changes). */
  lostFiles: string[];
  /** Untracked files created after the checkpoint that undo DELETED. */
  deletedUntracked: string[];
  /** Untracked files created after the checkpoint, left in place by --keep-untracked. */
  untrackedRemaining: string[];
  /**
   * Files that still differ from the checkpoint after the undo — checked, not
   * assumed. Empty when the tree is the checkpoint's.
   */
  notRestored: string[];
}

export interface UndoOptions {
  force?: boolean;
  /**
   * Preserve untracked files created after the checkpoint. By default undo
   * deletes them (this changed from v0.1.0, which left them in place) so the
   * tree matches the checkpoint exactly; the deleted list is reported.
   */
  keepUntracked?: boolean;
}

/**
 * Restore the working tree to the latest checkpoint.
 *
 * Guard: if the checkpoint was taken over a DIRTY tree, refuse unless
 * `force` — restoring discards uncommitted work made since the checkpoint.
 * The refusal lists exactly what would change (planUndo). With --force, the
 * dirty tree as of checkpoint time is restored from the blob snapshot (not
 * merely HEAD), and what was absent then is absent again.
 *
 * NOTE (changed from v0.1.0): untracked files created AFTER the checkpoint
 * are deleted by default — pass `keepUntracked` (`--keep-untracked`) to
 * preserve them.
 */
export function undo(rootDir: string, opts: UndoOptions = {}): UndoResult {
  if (!isGitRepo(rootDir)) {
    throw new CheckpointError("not a git repository — nothing to undo");
  }
  const ckpt = latestCheckpoint(rootDir);
  if (!ckpt) {
    throw new CheckpointError("no checkpoint recorded — nothing to undo");
  }
  const keepUntracked = opts.keepUntracked === true;
  const plan = planUndo(rootDir, ckpt);

  if (ckpt.dirty && !opts.force) {
    const described = describePlan(plan, keepUntracked);
    const lines = [
      `refusing to undo: checkpoint ${ckpt.id} was taken over a dirty working tree.`,
      ``,
      `What ` + "`cdir undo --force`" + ` will do:`,
      `  git reset --hard ${ckpt.ref.slice(0, 12)}  (${ckpt.tag})`,
      `  then put every file back as it was at the checkpoint — its uncommitted and untracked files included`,
      ``,
      `What will be LOST (changes made since the checkpoint):`,
      ...(described.length > 0 ? described : [`  (nothing has changed since the checkpoint — undo would change no file)`]),
      ``,
      `Re-run with --force if that is what you want.`,
    ];
    throw new CheckpointError(lines.join("\n"));
  }

  clearSkipFlags(rootDir);
  git(rootDir, ["reset", "--hard", ckpt.ref]);
  let deletedUntracked: string[] = [];
  if (!keepUntracked && plan.created.length > 0) {
    // Announce BEFORE deleting, so the notice names what is lost.
    process.stderr.write(
      `cdir undo: deleting ${plan.created.length} untracked file(s) created after the checkpoint:\n` +
        plan.created.map((p) => `  ${p}`).join("\n") +
        `\n(pass --keep-untracked to preserve them)\n`,
    );
    deletedUntracked = deleteGitPaths(rootDir, plan.created);
  }
  restoreCheckpointBlobs(rootDir, ckpt.id);

  // Checked, not assumed: the tree against the checkpoint, the same way.
  const left = planUndo(rootDir, ckpt);
  const notRestored = [...left.changes.map((c) => c.path), ...(keepUntracked ? [] : left.created)].sort();

  const lostFiles = plan.changes.map((c) => c.path);
  const record: UndoRecord = {
    at: new Date().toISOString(),
    checkpointId: ckpt.id,
    ref: ckpt.ref,
    forced: opts.force === true,
    lostFiles,
  };
  const store = loadStore(rootDir);
  store.undos.push(record);
  saveStore(rootDir, store);

  return {
    checkpoint: ckpt,
    forced: opts.force === true,
    lostFiles,
    deletedUntracked,
    untrackedRemaining: keepUntracked ? plan.created : [],
    notRestored,
  };
}
