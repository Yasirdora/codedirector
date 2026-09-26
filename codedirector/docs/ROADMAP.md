# Roadmap

What is being considered for the next releases, and the evidence for each
item. An item here is a candidate, not a promise. Each one is written so it
can become a GitHub issue as it stands.

## 0.4.6 candidates

### A required check that did not finish was reported "verified"

**Status: landed (IL-0028).** Found by an external audit of 0.4.5 and
reproduced on main (bb4b0cd): a lock whose `verifyCommand` was stopped by
its timeout ended "Done — verified. … verifyCommand timed out after 300ms",
exit 0, and the Lock was marked verified. Only a violation could block the
verdict, and a check that never finished is not a violation. The same held
for a `tests-pass` run that timed out or matched files its runner cannot
run, an `output-unchanged` command that could not run after the change, and
a structural clause with no baseline to compare against.

There are now three outcomes. **Failed** (a violation, or the command
failed; exit 1) beats **incomplete** (nothing violated, but a check the Lock
requires did not finish; exit 3, lock status `incomplete`) beats
**verified** (exit 0). Required means every KEEP clause except `custom`, and
the `verifyCommand` (`isRequiredCheck` in `src/verify/types.ts`, the one
place the rule lives). A `custom` clause and the ladder's own typecheck stay
named in the Unchecked bucket without blocking. The summary leads with "Not
verified: <check> did not finish — <reason>"; `run_locked` returns an error
that says so; `cdir verify <id> --test-timeout MS` re-checks with more time.
Guarded by `test/incomplete.test.ts` and eval case 20; removing the rule
fails 10 tests, and widening it to custom clauses and the typecheck fails 13.

One earlier test pinned the old behaviour: a `tests-pass` glob that reaches
Swift files (which `node --test` cannot run) exited 0. It is now incomplete.

**Still open from the same audit** (all reproduced on bb4b0cd):

- ~~A standalone `cdir report` re-runs today's checks but prints the run's
  old list of changed files~~ — landed (IL-0029), below.
- ~~Swift overloads share one symbol id, so changing one overload's
  parameter type passes `api-unchanged`~~ — landed (IL-0030), below.
- ~~`undo --force` brings back a tracked file deleted before the
  checkpoint~~ — landed (IL-0031), below.
- The parser loads every grammar before parsing anything: a missing Swift
  grammar stops a TypeScript-only project from being indexed.

### Undo brought back files deleted before the checkpoint, and its preview listed the wrong files

**Status: landed (IL-0031).** Audit finding F1b, reproduced on 71fd21e with
the audit's own script: a tracked file deleted before the checkpoint was
back after `undo --force` ("deleted.txt exists after undo: YES"). The
snapshot tried to copy every dirty path, skipped a missing one as
"vanished" and never recorded that it was gone; `git reset --hard`
recreated it. A rename's source came back the same way. And the account undo
gave was wrong in three places: the refusal's "What will be LOST" listed
every path dirty now — pre-existing untracked files and edits the undo
restores exactly as they were included; "discarded uncommitted changes in"
did the same afterwards; and "untracked files left in place" listed every
dirty path after the undo, restored tracked files included.

- The checkpoint records what was absent (`absent` in its snapshot), and
  undo removes it again after the reset. Checkpoints made before this still
  resurrect: they never recorded it.
- What undo will change is one plan (`planUndo`, `src/checkpoint/index.ts`):
  every file as it is now against the file as it was at the checkpoint —
  the snapshot's bytes, absent, or the checkpoint commit's content compared
  the way git stores it (`hash-object` applies the path's filters, so
  line-ending and LFS conversions are not changes; a symlink is compared by
  its target, which is what git stores and what `hash-object` would not
  read; a submodule is not undo's to judge). The refusal lists it
  ("reverted to the checkpoint", "restored (deleted after the checkpoint)",
  "removed (absent at the checkpoint)", "deleted (created after the
  checkpoint)", and commits made since, which leave the branch); the result
  reports it; `--keep-untracked` keeps exactly the files created since.
- Checked, not assumed: after undoing, the same comparison runs again, and
  a file that still differs is named — "NOT restored", exit 1 from the CLI,
  an error from the MCP `undo` tool.

Guarded by 8 new tests in `test/checkpoint.test.ts`, one of them through the
CLI. Not recording absent paths fails 4; recording them without removing
them fails the same 4 — and the post-undo check, run by itself under that
mutation, names the resurrected file; hashing a symlink through its link
fails the symlink test. There is no eval case: the harness
drives `cdir run` and `cdir report`, not undo.

### Overloads shared an id, and api-unchanged compared only one of them

**Status: landed (IL-0030).** Audit finding F4, reproduced on 38d5ac8:
`save(_ v: Int)` and `save(_ v: String)` both indexed as
`Store.swift#Store.save`. The graph and the baseline keep one declaration per
id — whichever came last — so changing the Int overload to Bool passed:
"signature unchanged", exit 0. TypeScript had the same hole twice: class
method overloads collapsed the same way, and a function's overload
signatures (`function parse(v: string): number;`) were not indexed at all,
only its implementation.

Ids stay as they are — Locks name them, and a sealed Lock cannot be edited
without re-approval. What an id stands for is now all of it: `apiSignatures`
(`src/lock/check.ts`) collects every declaration the id names, sorted, and
the baseline and the verifier compare that. Changing, adding or removing any
overload is a proven violation that says what changed ("public func save(_
v: Int) → public func save(_ v: Bool)"; the baseline now keeps the signature
texts for this); reordering overloads is not. A symbol with one declaration
hashes exactly as before, so existing baselines stay valid — the end-to-end
output is unchanged. The TypeScript extractor indexes overload signatures
(parser version 6). `cdir lock check` warns when an api-unchanged id names
several declarations: they are guarded together. And the graph lists an
overloaded id once by name — `cdir why` printed a Swift overload once per
declaration, and would have done the same for every TypeScript function
with overload signatures.

Guarded by `test/overloads.test.ts` and eval case 22 (the audit's case).
Keeping only the last declaration again fails 5 of the tests; not indexing
TypeScript overload signatures fails 1; comparing in source order instead of
sorted fails the reorder test; listing an id once per declaration fails the
`why` test.

A baseline captured before this change and verified after it compares an
overloaded id's old hash (one declaration) with the new (all of them), so
such a standalone verify reports the id as changed; a fresh run does not.

**Still open, found alongside:** Swift initializers (`init`) and subscripts
are not indexed, so `api-unchanged` cannot name them; nor can a TypeScript
`declare function`.

### A report judged today's checks against the run's old list of files

**Status: landed (IL-0029).** Audit finding F5, reproduced on 6784394: a
clean run edited allowed.txt; protected.txt, denied by the Lock, was then
changed by hand. `cdir report` re-ran today's checks but judged scope on the
run's stored list: "Done — verified. Only allowed.txt changed, within the
agreed scope." protected.txt was never mentioned.

A standalone report or verify now judges the tree as it is now, its scope
included (`judgeTreeNow`, `src/run/classify.ts`): the changed files are found
again against the run's baseline — the classifier the run itself uses — and
the ceilings measured on them. Every file that changed after the run is
named ("1 file changed after the run, not by its command: protected.txt") and
judged like any other. To see a further edit to a file the run itself
changed, a run now records each changed file's hash as it left it; a record
written before then still shows new paths. Without a trustworthy baseline the
run's own list is shown and the report is incomplete (or failed, when the
baseline's recorded hash no longer matches — tampering, as before).
`--allow-expand` keeps covering the run's own changes, not what came after.

`cdir report` no longer sets the lock's status — `cdir run` and `cdir
verify` do (the MCP `report` tool never did). Otherwise an old Lock's report,
read after later work, would turn it failed.

Guarded by `test/drift.test.ts` and eval case 21 (the harness gained
`afterRun`, a change made between the run and the report). Judging the
stored list again fails 7 of the tests; dropping the hash comparison fails
the further-edit test; a report that sets the status fails its own.

**Also in IL-0029, found alongside:** a `cdir verify` with no run behind it
— the direct-edit path the agent skill describes (`cdir checkpoint`, edit,
`cdir verify`) — judged no scope at all ("no run record — verification
only"). Reproduced: "Done — verified", exit 0, over an edit to a denied
file. Without a run there is no baseline to find the changed files against,
so the verdict is now incomplete, naming why. **Still open:** that path has
no way to reach verified; a checkpoint that captures the Lock's baseline
would give it one. Until then the skill steers work through `cdir run`.

### Stopping cdir during a check leaves the check running

**Status: open.** Found while building IL-0028. Reproduced on bb4b0cd:
SIGTERM to `cdir run` while its `verifyCommand` (`sleep 20; echo late >
a.txt.probe`) runs. cdir exits within a second, but the check's supervisor
is re-parented to init and the check runs to the end — up to its own
timeout, 15 minutes for a suite — and `a.txt.probe` is left in the tree:
the put-back that isolates checks runs in cdir, which is gone. Wanted: when
cdir is stopped, stop its running check's process group and put the tree
back before exiting, and say so on stderr. An MCP client cancelling a
request does exactly this, so it belongs with the item below about long
checks blocking the MCP server.

### A missing compiler read as a broken one; the suite read the developer's git settings

**Status: landed (IL-0026), completed by IL-0027.** IL-0027: the owner's
Mac then ran 248/249 — npx present (npm's shell shim beside node, in an app
runtime folder), but reached through a link it cannot find npm's own
scripts, and Node's loader fails with MODULE_NOT_FOUND, exit 1. Read as tsc
failing: VIOLATED again. Reproduced with that layout: 248/249, the same
test and message. npx failing to load itself now counts as "no compiler"
(Unchecked, with the loader's own line as the reason). And every "no tool
here" output pattern now counts only when the tool produced no diagnostic:
without that guard, a real tsc finding such as TS2307 "Cannot find module
'…'" would have been turned into "could not run" — shown by a test. The
"no compiler" test runs three ways: npx linked, absent, and broken.
250/250 in that layout, on Node 24.15 and on Node 22.22.

After IL-0025 the owner's Mac ran 246/248;
the two failures passed in the CI-like container. Reproduced here by
rebuilding the Mac's differences: 246/248, the same two tests.

- **Product bug.** With no local TypeScript, the typecheck asks
  `npx --no-install tsc`. Where npx is not on the PATH the shell answers
  "npx: not found", exit 127 — and that was read as tsc failing: the
  typecheck was reported VIOLATED. A false violation on any machine without
  npx whose project has a tsconfig.json. A shell's 127 ("not found") or 126
  ("not executable") now means the check could not run: Unchecked, with the
  shell's words as the reason. The "no compiler" test runs with and
  without npx.
- **Test assumption.** A global git excludes file listing `*.tsbuildinfo`
  hides the file a typecheck probe writes, so the test that names every
  probe's leftovers failed wherever such a file exists. The suite now runs
  git with an empty global configuration and no system one
  (`test/helpers.ts`), so no global ignore, cache, fsmonitor, hook or
  signing setting reaches a test. cdir itself is unchanged here: a file the
  user's own ignore rules hide is outside the fence by design, so a probe's
  ignored leftovers are not moved aside.

In a composite of the Mac's differences — Node 24.15, no npx beside node,
no global tsc, a symlinked temp directory, a global excludes file with
`*.tsbuildinfo` — `npm test` passes 249/249; so it does on Node 24.15 and
Node 22.22 in their default environments. On the owner's Mac the IL-0025
report named only the after-phase typecheck entry as missing, while the
reproduction loses both; green on the Mac is the proof that counts.

### A check's timeout did not stop what the check started

**Status: landed (IL-0023).** Checks (verifyCommand, tests, typecheck,
output commands) ran through Node's synchronous spawn, which can signal only
the process it started. Reproduced on cf2eeda:

- A timed-out check returned on time, but what its shell started kept
  running (three processes left behind). With xcodebuild, such orphans hold
  DerivedData locks the next build needs.
- A check that ignored SIGTERM hung cdir indefinitely: the timeout was never
  enforced.
- A check that finished but left a background process (a dev server) was
  reported as timed out, after waiting the whole timeout, because that
  process still held the output pipe.
- Past 16 MB of output the check failed as "could not run" (ENOBUFS) and the
  diagnostic was lost.

Each check now runs under a small supervisor process (`run/supervise.ts`):
its own process group, output written to files, and on timeout the whole
group is stopped — SIGTERM, then SIGKILL after 3s. A check that finishes on
its own may leave a daemon running; that is not a timeout. Output past 16 MB
per stream keeps its end (where diagnostics are) behind a line saying what
was left out; `output-unchanged` hashes the whole output, so the cut can
never hide a difference. Cost: about 45 ms per check. Guarded by
`test/probe.test.ts`; each of its protective tests fails on the old code.

**Still open — long checks block the MCP server.** Verification is
synchronous, so while `run_locked` runs a 15-minute xcodebuild the server
answers nothing and sends no progress; an MCP client with a 60-second
request timeout gives up. Wanted: run the locked command and its checks off
the server's main thread, and report progress while they run.

**Also fixed:** the "unchecked without a compiler" test assumed no compiler
existed and failed on any machine with a global TypeScript (`npm i -g
typescript`); it now hides global compilers itself, so `npm test` passes in
either environment.

### Every command that parses a Swift file waits ~8 seconds to exit

**Status: landed (IL-0022), corrected by IL-0025.** IL-0022 set V8's
`--liftoff-only` mid-process (`v8.setFlagsFromString`). That holds on Node 22
but not on Node 24: there the flag does not take effect, the background
optimisation runs, and the process crashes at exit — "Fatal process out of
memory: Zone", exit 133. Found on the owner's Mac (Node 24.15, five test
files failing), reproduced on Linux with Node 24.15.0: `npm test` 224 pass,
5 fail, each with that message. IL-0025 sets the flag where it always
works, at process start: `src/cli.ts` relaunches cdir with it when started
without it (one bare Node start, ~35 ms; signals and exit status pass
through), and `npm test` starts node with it. Every command now runs
this way, so a first full index of a JavaScript project is about a third
slower (393 files: 1.16s → 1.54s); incremental runs parse only changed
files. A program that embeds cdir and parses Swift without the flag gets
a one-line warning instead of a silent crash. After: `npm test` 248/248 on
Node 24.15 and on Node 22.22, eval 19/19 on both. Guarded by
`test/launch.test.ts`. The IL-0022 record follows. Found by timing the eval gate: the three Swift
cases took 9s each, the JavaScript ones 0.4s. The work took 0.1s. V8
optimises the Swift grammar's WebAssembly in the background once a Swift
file is parsed, and Node waits for that job before exiting (Node 22; 7.9s of
CPU, `process.exit()` does not avoid it). An indexing pass that parses up to
3,000 Swift files now uses V8's baseline WebAssembly compiler only (about
45% slower per file, nothing at exit); a pass without Swift keeps V8's
defaults. `cdir index` on one Swift file: 8.2s → 0.2s. Guarded by
`test/swift-exit.test.ts`. In the long-lived MCP server the cost was a
background compile, not a stall.

### The coverage finding says things that cannot be true

**Status: landed (IL-0022).** "X changed in-budget, but no test file
references its symbols" was printed for Markdown and YAML (IL-0021's own
report had five), and would be for every Swift file, because cdir
recognises no Swift tests yet. It now skips files the index does not read,
and for a language with no recognised test files says so once: "N Swift
file(s) changed in-budget (…); cdir recognises no Swift test files here, so
their test coverage is unknown".

### A run can hide a file from the fence by adding it to `.gitignore`

**Status: landed (IL-0021).** `.gitignore` files are judged like any other
file: cdir has not written the project's `.gitignore` since IL-0020, so the
exemption only protected the hole. The baseline keeps the text of every
ignore source (each `.gitignore`, and `.git/info/exclude`); when a run
changes one, every path git now ignores is checked against the rules as
they were, by git itself (`git check-ignore --no-index` in a scratch
repository), and what the old rules did not ignore is judged as a change
(status `!!`), counted in the line total. Output the old rules already
ignored stays out of scope, as before. Eval cases 15 and 16 pin both sides.
Known limit: a global excludes file (`core.excludesFile`) lives outside the
repository, and a run that edits it is not seen. The evidence below is kept
as the record.

**Found:** 2026-09-24 — a run's three-line `.gitignore` change wasn't
counted ("16 changed" for 17 files). Reproduced on
main (02a6ee0) the same day.

**What happens:**

- `.gitignore` is never judged. `isToolPath` (`src/run/tree.ts:161`) treats it
  as cdir's own file, because cdir writes its ignore block there, so a run's
  edits to it are not in the changed files, the budget or the line count —
  even when the lock's `deny` names `.gitignore`.
- **Update 2026-09-25:** cdir no longer writes to the project's
  `.gitignore`; its rules are in `.codedirector/.gitignore`. The exemption
  is now only needed where the old block is still in `.gitignore`.
- So a run can hide what it creates. Reproduced: a lock budgeting `src/a.ts`
  and denying `.gitignore`; a run that edits `src/a.ts`, creates `notes.txt`
  and appends `notes.txt` to `.gitignore`. Verdict: VERIFIED, "1 changed".
  The same run without the `.gitignore` line: OUT-OF-BUDGET: notes.txt.

**Why it matters:** the fence promises that nothing outside the budget changes
unseen. This is the same class as the 0.4.5 seal hole (IL-0015): an agent can
be marked verified for work outside its scope.

**Wanted:**

- Judge `.gitignore` like any other file, except cdir's own
  `# BEGIN cdir … # END cdir` block: compare it with that block removed on
  both sides.
- Classify files the run's own ignore rules hide: compare
  `git ls-files --others --ignored --exclude-standard` before and after the
  run (or evaluate paths against the baseline's copy of `.gitignore`), so a
  file hidden by a rule the run added is still judged.

**Test:**

- A run appending a line to `.gitignore` under a lock that doesn't budget it:
  OUT-OF-BUDGET: .gitignore — and DENY when the lock denies it.
- A run that creates `notes.txt` and ignores it: OUT-OF-BUDGET: notes.txt, as
  without the ignore line.
- cdir writing its own block on a repo's first run: no finding.

### Feature 8: `no-new-dependency` can't tell a version bump from a dependency

**Found in:** IL-0010, the 0.4.5 bump. The clause was left out of that lock's
`keep`, "for a mechanical reason, not an editorial one".

**What happens:** a release bump is not a new dependency, but the clause
cannot say so, so a lock that bumps the version has to give the promise up.

- `package.json` is compared by its dependency maps only
  (`dependencyFingerprint` in `src/run/deps.ts`), so its own `version` field
  is safe. IL-0010's note says "hashes package.json", which is broader than
  what the code does.
- Every other manifest in `DEPENDENCY_MANIFESTS` is hashed whole, including
  `package-lock.json`, `Package.resolved` and `Podfile.lock`. `npm version`
  rewrites the lockfile's own `version` fields (top level and `packages[""]`),
  so the hash changes and the clause reports a dependency that doesn't exist.

**Wanted:** judge lockfiles by what they resolve, not by their bytes. For
`package-lock.json`, that means the `packages` entries other than the root
package's own `version`. A bump then keeps the promise, and a real new or
changed dependency still breaks it.

**Test:** a lock with `no-new-dependency` whose run only runs `npm version
patch` holds. A run that adds a dependency is still violated.

### Untracked directories are never expanded into their files

**Status: landed (IL-0016)** for the verdict, the line count and the
checkpoint. `git status` now lists untracked files one by one
(`--untracked-files=all`), and a file already deleted when the baseline is
captured gets a fingerprint of its own, so neither a pre-existing untracked
folder nor a pre-existing deletion reads as the run's change (eDraft IL-0045's
three PNGs were the deletion case). The tolerated OUT-OF-BUDGET that
`test/run.test.ts` pinned is gone. The two undo items that stayed open here
landed in IL-0031 (*Undo brought back files deleted before the checkpoint*,
above).

The evidence below is kept as the record.

**Found in:** eDraft IL-0028, 2026-09-17.

**What happens:** a folder that was already untracked before a run reads as a
new change after it, a false scope violation.

- The project had an untracked `.githooks/` (the human's commit hook, last
  modified 37 minutes before the run).
- The run copied nine in-budget files and never touched the folder.
- The Change Report still listed `.githooks/` as OUT-OF-BUDGET and counted
  10 of 9 files. Verdict: FAILED, with every other check and the verify
  command passing.

**Cause:** `git status --porcelain` reports an untracked directory as a single
`?? dir/` line unless it is run with `-uall`.

- The checkpoint (`writeCheckpointBlobs` in `src/checkpoint/index.ts`) calls
  `readFileSync("dir/")`, which throws EISDIR. The error is caught as
  "vanished", so none of the folder's files are snapshotted.
- The baseline records no per-file hash for the folder either
  (`workTreeHashes` had `screenshot.png`, an untracked file, but nothing under
  `.githooks/`).
- After the run, the same `?? dir/` line has nothing to compare against and is
  classified as a change.

**Also:**

- **Half of this landed in IL-0014:** a run that creates a file in a new
  folder now counts its real lines (the numstat/untracked side). What remains
  here is the classification half — the collapsed `?? dir/` entry is still
  judged as a path and still reads OUT-OF-BUDGET — plus the checkpoint,
  undo-preview and EISDIR symptoms. A test in `test/run.test.ts` ("a new file
  in a new folder counts its real lines") pins a tolerated OUT-OF-BUDGET that
  this item's fix must remove.
- **Misleading preview:** `undo --force` listed the folder (and
  `screenshot.png`) as "will be LOST", then left both byte-identical
  (`deletedUntracked: []`).
- **Can't undo changes there:** a run that really did edit a file inside such
  a folder would have no checkpoint bytes to restore it from. This is read
  from the code, not reproduced.
- **A lock can't create a file in a new folder.** Reproduced by IL-0011, the
  lock that wrote this roadmap. Its budget named `docs/ROADMAP.md`, but
  `docs/` did not exist, so the new file arrived as `?? docs/`. It was judged
  as "docs/" against the budget (OUT-OF-BUDGET) and counted as 3 lines of
  127, with the verify command passing. A budget may name a file its run
  will create (IL-0008), but not when the file's folder is new too.

**Wanted:**

- List untracked paths file by file (`git status --porcelain -uall`, or
  `git ls-files --others --exclude-standard`) in the checkpoint, the baseline
  and the post-run tree.
- Snapshot, hash and classify each file.
- The undo preview names only what undo will actually remove or overwrite.
- EISDIR is never swallowed as "vanished".

**Test:**

- **Setup:** a repo with a committed file and an untracked `tools/hook.sh`,
  and a lock that budgets the committed file.
- **Run:** a command that edits only the committed file.
- **Expect:** no OUT-OF-BUDGET, and 1 of N files changed.
- **Then:** `undo --force` restores the committed file, and `tools/hook.sh`
  still exists, unchanged and not listed as lost.
- **And:** a lock whose budget names `notes/new.md`, in a folder that does
  not exist yet, runs a command that creates it. Expect no OUT-OF-BUDGET,
  1 file changed, and the file's real line count.

### Undo rolls approval seals back by accident, and says nothing

**Found in:** eDraft IL-0028, 2026-09-17, during the same undo.

**What happens:** undoing a failed run also removed the approval seal of the
lock that ran it, and nothing said so.

- IL-0028 was activated, and so sealed, but not yet committed. Its run failed.
- `undo --force` reported only the work files it discarded.
- Afterwards `.codedirector/seals.json` no longer had IL-0028's entry. The
  lock's next run would have been refused as "active but has no approval
  seal" until the human re-approved it.

**Cause:** undo is `git reset --hard` to the checkpoint's HEAD, plus a restore
of checkpoint blobs that excludes `.codedirector/`. So which seals survive
depends on repo convention, not on any decision:

- A repo that commits `seals.json` (eDraft does, lock by lock) gets it rolled
  back to its last commit. That drops the seal of every lock approved since,
  not just the one being undone.
- A repo that ignores `.codedirector/` keeps every seal.

**Not obviously a bug in one direction.** Rolling the seal back with the work
has its own logic: the undone run was carried out under that approval, and
asking for it again before a retry is defensible. Keeping the seal also has
logic, because the approved scope did not change.

**Wanted:** make the behaviour deliberate and loud, whichever way it goes.

- Decide what undo does to approval seals, independent of whether the repo
  commits `.codedirector/`.
- Scope that decision to the lock being undone, not every lock approved since
  the last commit.
- Name it in the undo preview and result, for example "IL-0028's approval seal
  is removed; re-approve with `lock check` + `lock activate` before running it
  again", or "kept".

**Test:** in a repo that commits `seals.json` and in one that ignores
`.codedirector/`, activate two locks without committing, fail a run of one,
and undo. The same documented outcome holds in both repos, the other lock's
seal is untouched, and the undo output states what happened to the seal.

### The changed-line count is wrong in a project rooted in a subfolder

**Status: landed (IL-0014).** The numstat loop now skips `.codedirector/` as
the classifier does, `snapshotWorkTree` lists tracked files with
`--full-name` so a subfolder baseline hashes its own files, and an untracked
folder entry is expanded and counted file by file. The evidence below is kept
as the record. Known leftover: `listHidden` (tree.ts) and two `ls-files`
calls in `checkpoint/index.ts` share the old mis-framed call and were left
out of IL-0014's scope — they matter only if hidden-flag files are used in a
subfolder-rooted project.

**Found in:** IL-0012, 2026-09-17, on this roadmap. The Change Report counted
12 lines. Git counts 9 added and none removed, on a tracked file.

**What happens:**

- **The extra 3:** they are `.codedirector/seals.json` (+2/−1), the approval
  seal that `lock activate` wrote before the run started. The classifier
  leaves `.codedirector/` out of the changed files, but the line counter
  counts it.
- **IL-0011's "3 lines of 127":** the same 3 seal lines. The new 127-line file
  counted 0, because its untracked folder can't be read as a file (see the
  untracked-directory entry).
- **At the git root, counts were exact:** eDraft's lock root is its git root,
  and the same day IL-0029 counted 10 of 10 and IL-0030 1,877 of 1,877.

**Cause (from the source):**

- `changedLineCount` (`src/run/classify.ts`) sums
  `git diff --numstat <baseline HEAD>` over the whole repository. It skips a
  file only when the baseline's `workTreeHashes` shows it unchanged since
  capture, and has no `.codedirector/` filter of its own.
- `snapshotWorkTree` (`src/run/tree.ts`) lists tracked files with
  `git ls-files`. In a subfolder that prints paths relative to the subfolder,
  which are then read as relative to the git root, so almost none resolve.
  IL-0012's baseline hashed 3 files: `.gitignore`, `LICENSE` and `README.md`,
  names that exist at both levels, hashed from the wrong copies.
- With no baseline hash for `seals.json`, the seal written before the run is
  counted as the run's change.
- At the git root, the snapshot hashes every tracked file (465 in eDraft),
  `seals.json` included, so the earlier write is recognised and skipped.
- The same hashes are consulted when classifying files
  (`src/run/classify.ts:145`). Whether that misjudges pre-existing changes in
  a subfolder project was not checked.

**Why it matters:** `maxLines` is a tripwire, and the ruler errs in both
directions. Lines it adds can trip a legitimate run. Lines it drops (a new file
in a new folder counted as 0) pass under the ceiling unmeasured.

**Wanted:**

- Count only what the run changed, leaving `.codedirector/` out of the line
  count as the classifier already does.
- Resolve `git ls-files` paths in one frame (`--full-name`, or run from the git
  root), so a subfolder project's baseline hashes its own files.
- Count a new file inside a new folder by its lines.

**Test:**

- **Subfolder root:** activate a lock (which writes `seals.json`), then run a
  command that adds 9 lines to a tracked file. The report counts 9.
- **Git root:** the same. The report counts 9.
- **New folder:** a run that creates a 127-line file in a new folder counts
  127.
