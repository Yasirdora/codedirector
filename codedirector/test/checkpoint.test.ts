/**
 * Checkpoint / undo tests in temp git repos.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  CheckpointError,
  createCheckpoint,
  latestCheckpoint,
  undo,
} from "../src/checkpoint";
import { spawnSync } from "node:child_process";
import { git, makeGitRepo } from "./helpers";

test("checkpoint/undo round-trip restores a modified tracked file", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  const ckpt = createCheckpoint(root);
  assert.equal(ckpt.dirty, false);
  assert.equal(latestCheckpoint(root)?.id, ckpt.id);

  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 2;\n");
  const result = undo(root);
  assert.equal(result.checkpoint.id, ckpt.id);
  assert.equal(result.forced, false);
  assert.deepEqual(result.lostFiles, ["src/a.ts"]);
  assert.equal(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const v = 1;\n");
});

test(".codedirector tool state does not count as a dirty tree", () => {
  const root = makeGitRepo();
  fs.mkdirSync(path.join(root, ".codedirector", "locks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codedirector", "locks", "IL-0001-x.yaml"), "id: x\n");
  const ckpt = createCheckpoint(root);
  assert.equal(ckpt.dirty, false, "untracked .codedirector state ignored");
});

test("undo refuses over a checkpoint taken with a dirty tree, unless --force", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  // dirty the tree BEFORE the checkpoint
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 2;\n");
  const ckpt = createCheckpoint(root);
  assert.equal(ckpt.dirty, true);

  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 3;\n");
  assert.throws(() => undo(root), CheckpointError, "dirty checkpoint refuses without --force");
  try {
    undo(root);
  } catch (e) {
    assert.ok(e instanceof CheckpointError);
    assert.ok(e.message.includes("src/a.ts"), "refusal names what will be lost");
    assert.ok(e.message.includes("--force"));
  }
  // file untouched by the refused undo
  assert.equal(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const v = 3;\n");

  const result = undo(root, { force: true });
  assert.equal(result.forced, true);
  assert.equal(
    fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"),
    "export const v = 2;\n",
    "force-undo restores checkpoint-time dirty bytes, not merely HEAD",
  );
});

test("undo reports untracked files left behind and logs every undo", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 2;\n");
  fs.writeFileSync(path.join(root, "new.ts"), "export const n = 0;\n");
  const result = undo(root);
  assert.equal(fs.existsSync(path.join(root, "new.ts")), false, "undo removes untracked files created after the checkpoint");
  assert.ok(!result.untrackedRemaining.includes("new.ts"));

  const store = JSON.parse(
    fs.readFileSync(path.join(root, ".codedirector", "checkpoints.json"), "utf8"),
  );
  assert.equal(store.undos.length, 1, "undo logged");
  assert.equal(store.undos[0].forced, false);
});

test("checkpoint requires a git repo and a commit", () => {
  const root = makeGitRepo();
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  assert.throws(() => createCheckpoint(root), /not a git repository/);

  const empty = makeGitRepo();
  git(empty, ["rm", "-rq", "--cached", "."]);
  fs.rmSync(path.join(empty, ".git"), { recursive: true, force: true });
  git(empty, ["init", "-q"]);
  assert.throws(() => createCheckpoint(empty), /no commits yet/);
});

test("undo with no checkpoints fails cleanly", () => {
  const root = makeGitRepo();
  assert.throws(() => undo(root), /no checkpoint recorded/);
});

test("undo --keep-untracked preserves post-checkpoint untracked files", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 2;\n");
  fs.writeFileSync(path.join(root, "new.ts"), "export const n = 0;\n");
  const result = undo(root, { keepUntracked: true });
  assert.equal(fs.existsSync(path.join(root, "new.ts")), true, "kept");
  assert.equal(fs.readFileSync(path.join(root, "new.ts"), "utf8"), "export const n = 0;\n");
  assert.deepEqual(result.deletedUntracked, []);
  assert.ok(result.untrackedRemaining.includes("new.ts"));
  assert.equal(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const v = 1;\n");
});

test("undo without --keep-untracked reports the deleted untracked files", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "new.ts"), "export const n = 0;\n");
  const result = undo(root);
  assert.deepEqual(result.deletedUntracked, ["new.ts"]);
  assert.equal(fs.existsSync(path.join(root, "new.ts")), false);
});

// ---------------------------------------------------------------------
// Undo restores the checkpoint exactly, and says exactly what it will do.
//
// Reproduced on 0.4.5 and on main before this rule (audit finding F1b): a
// tracked file deleted BEFORE the checkpoint came back after `undo --force`
// (`git reset --hard` recreates it; the snapshot never recorded it was
// gone). And the refusal's "What will be LOST" listed every path dirty now —
// including pre-existing untracked files and edits the undo restores exactly
// as they were.

/** The paths the refusal message lists under "What will be LOST". */
function preview(root: string): string[] {
  try {
    undo(root);
  } catch (e) {
    const text = (e as Error).message;
    const start = text.indexOf("What will be LOST");
    if (start === -1) return [];
    return text
      .slice(start)
      .split("\n")
      .slice(1)
      .filter((l) => l.startsWith("  "))
      .map((l) => l.trim());
  }
  assert.fail("undo over a dirty checkpoint must refuse without force");
}

test("undo: a file deleted before the checkpoint stays deleted; one deleted after it comes back", () => {
  const root = makeGitRepo({ "keep.txt": "a\n", "deleted.txt": "gone\n", "later.txt": "l\n" });
  fs.rmSync(path.join(root, "deleted.txt"));
  createCheckpoint(root);
  fs.appendFileSync(path.join(root, "keep.txt"), "x\n");
  fs.rmSync(path.join(root, "later.txt"));
  const result = undo(root, { force: true });
  assert.equal(fs.existsSync(path.join(root, "deleted.txt")), false, "absent at the checkpoint, absent after undo");
  assert.equal(fs.readFileSync(path.join(root, "later.txt"), "utf8"), "l\n", "deleted since the checkpoint: restored");
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "a\n");
  assert.deepEqual(result.lostFiles, ["keep.txt", "later.txt"]);
  assert.deepEqual(result.notRestored, []);
});

test("undo: a rename made before the checkpoint is kept — the old path does not come back", () => {
  const root = makeGitRepo({ "old.txt": "o\n", "other.txt": "t\n" });
  git(root, ["mv", "old.txt", "new.txt"]);
  createCheckpoint(root);
  fs.appendFileSync(path.join(root, "other.txt"), "x\n");
  const result = undo(root, { force: true });
  assert.equal(fs.existsSync(path.join(root, "old.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "o\n");
  assert.deepEqual(result.notRestored, []);
});

test("undo preview: lists what undo changes — not the dirt it restores exactly as it was", () => {
  const root = makeGitRepo({ "a.txt": "a\n", "b.txt": "b\n", "gone.txt": "g\n" });
  fs.writeFileSync(path.join(root, "a.txt"), "a before\n"); // dirty before, untouched since
  fs.writeFileSync(path.join(root, "notes.md"), "mine\n"); // untracked before, untouched since
  fs.rmSync(path.join(root, "gone.txt")); // deleted before
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "b.txt"), "b since\n"); // changed since
  fs.writeFileSync(path.join(root, "made.txt"), "new\n"); // created since

  const listed = preview(root);
  assert.deepEqual(listed, ["b.txt — reverted to the checkpoint", "made.txt — deleted (created after the checkpoint)"]);

  const result = undo(root, { force: true });
  assert.deepEqual(result.lostFiles, ["b.txt"], "the preview and the result are one plan");
  assert.deepEqual(result.deletedUntracked, ["made.txt"]);
  assert.deepEqual(result.untrackedRemaining, []);
  assert.deepEqual(result.notRestored, []);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "a before\n");
  assert.equal(fs.readFileSync(path.join(root, "notes.md"), "utf8"), "mine\n");
  assert.equal(fs.existsSync(path.join(root, "gone.txt")), false);
});

test("undo preview: nothing changed since the checkpoint — says so, and undo changes nothing", () => {
  const root = makeGitRepo({ "a.txt": "a\n" });
  fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "notes.md"), "mine\n");
  createCheckpoint(root);
  let message = "";
  try {
    undo(root);
  } catch (e) {
    message = (e as Error).message;
  }
  assert.match(message, /nothing has changed since the checkpoint/);
  assert.doesNotMatch(message, /a\.txt|notes\.md/);
  const result = undo(root, { force: true });
  assert.deepEqual(result.lostFiles, []);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "dirty\n");
});

test("undo preview: commits made since the checkpoint are named — they leave the branch", () => {
  const root = makeGitRepo({ "a.txt": "a\n" });
  fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
  createCheckpoint(root);
  git(root, ["commit", "-qam", "since"]);
  let message = "";
  try {
    undo(root);
  } catch (e) {
    message = (e as Error).message;
  }
  assert.match(message, /1 commit made since the checkpoint leaves the branch \(still in the reflog\)/);
});

test("undo --keep-untracked: the kept files are the ones created since, nothing else", () => {
  const root = makeGitRepo({ "a.txt": "a\n" });
  fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "made.txt"), "new\n");
  const result = undo(root, { force: true, keepUntracked: true });
  assert.deepEqual(result.untrackedRemaining, ["made.txt"], "restored dirt is not an untracked file left in place");
  assert.deepEqual(result.notRestored, []);
});

test("undo, from the command line: the refusal and the result name the same files, and nothing else", () => {
  const root = makeGitRepo({ "a.txt": "a\n", "b.txt": "b\n", "deleted.txt": "d\n" });
  fs.writeFileSync(path.join(root, "notes.md"), "mine\n");
  fs.rmSync(path.join(root, "deleted.txt"));
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "b.txt"), "b since\n");
  const cli = path.join(__dirname, "..", "src", "cli.js");
  const cdir = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "undo", ...args, "--root", root], { cwd: root, encoding: "utf8", timeout: 60_000 });

  const refused = cdir();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /What will be LOST \(changes made since the checkpoint\):\n {2}b\.txt — reverted to the checkpoint\n\n/);
  assert.doesNotMatch(refused.stderr, /notes\.md|deleted\.txt/);

  const done = cdir("--force");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /put back as they were at the checkpoint \(changes since then discarded\):\n {2}b\.txt\n/);
  assert.doesNotMatch(done.stdout + done.stderr, /notes\.md|deleted\.txt|NOT restored/);
  assert.equal(fs.existsSync(path.join(root, "deleted.txt")), false);
});

test("undo: a tracked symlink is compared as git stores it — its target — not by the file it points to", () => {
  // The link is a candidate (a commit since the checkpoint repointed it) yet
  // identical to the checkpoint (the working tree points it back): git's
  // hash-object follows links, so hashed that way it would read as changed.
  const root = makeGitRepo({ "target.txt": "t\n", "a.txt": "a\n" });
  fs.symlinkSync("target.txt", path.join(root, "link.txt"));
  git(root, ["add", "link.txt"]);
  git(root, ["commit", "-qm", "link"]);
  fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
  createCheckpoint(root);
  fs.rmSync(path.join(root, "link.txt"));
  fs.symlinkSync("a.txt", path.join(root, "link.txt"));
  git(root, ["add", "link.txt"]);
  git(root, ["commit", "-qm", "repoint"]);
  fs.rmSync(path.join(root, "link.txt"));
  fs.symlinkSync("target.txt", path.join(root, "link.txt"));
  assert.deepEqual(preview(root), ["1 commit made since the checkpoint leaves the branch (still in the reflog)"]);
  const result = undo(root, { force: true });
  assert.deepEqual(result.lostFiles, []);
  assert.deepEqual(result.notRestored, []);
  assert.equal(fs.readlinkSync(path.join(root, "link.txt")), "target.txt");
});
