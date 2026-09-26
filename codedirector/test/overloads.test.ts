/**
 * An id's API is every declaration it names: overloads share an id, and
 * `api-unchanged` guards all of them together.
 *
 * Reproduced on 0.4.5 and on main before this rule (audit finding F4):
 * `save(_ v: Int)` and `save(_ v: String)` both indexed as
 * `Store.swift#Store.save`; the graph and the baseline kept one of them, so
 * changing the Int overload to Bool passed as "signature unchanged". The
 * same hole in TypeScript: class method overloads collapsed the same way,
 * and a function's overload signatures were not indexed at all — only its
 * implementation.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { buildGraph } from "../src/core/graph";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { apiSignatures, checkLock, signatureHash } from "../src/lock/check";
import { VibeCheck } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;

const STORE_SWIFT =
  "public struct Store {\n" +
  "    public func save(_ v: Int) { print(v) }\n" +
  "    public func save(_ v: String) { print(v) }\n" +
  "}\n";

const PARSE_TS =
  "export function parse(v: string): number;\n" +
  "export function parse(v: number): number;\n" +
  "export function parse(v: any): number { return Number(v); }\n" +
  "export class Store {\n" +
  "  save(v: number): void;\n" +
  "  save(v: string): void;\n" +
  "  save(v: any): void {}\n" +
  "}\n";

async function setup(files: Record<string, string>, file: string, id: string): Promise<{ root: string; lock: VibeCheck }> {
  const root = makeGitRepo(files);
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "keep the API", { now: "2026-09-26T00:00:00.000Z", createdBy: "test" });
  lock.keep = [{ kind: "api-unchanged", symbols: [id] }];
  lock.budget = { files: [file], symbols: [], maxFiles: 1, maxLines: 50 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return { root, lock };
}

/** A command that replaces `from` with `to` in `file`. */
function replace(file: string, from: string, to: string): string[] {
  return [
    NODE,
    "-e",
    `const f=require("fs");const s=f.readFileSync(${JSON.stringify(file)},"utf8");` +
      `if(!s.includes(${JSON.stringify(from)}))process.exit(9);` +
      `f.writeFileSync(${JSON.stringify(file)},s.replace(${JSON.stringify(from)},${JSON.stringify(to)}))`,
  ];
}

async function apiItem(files: Record<string, string>, file: string, id: string, command: string[]) {
  const { root, lock } = await setup(files, file, id);
  const outcome = await runWithLock(root, lock.id, command, { stdio: "pipe" });
  assert.equal(outcome.record.exitCode, 0, "the change command ran");
  const item = outcome.record.verification!.items.find((i) => i.clauseKind === "api-unchanged")!;
  return { outcome, item };
}

const SWIFT = { "Store.swift": STORE_SWIFT };
const SAVE = "Store.swift#Store.save";

test("overloads: changing one Swift overload's parameter type is a violation, naming both sides (the audit's case)", async () => {
  const { outcome, item } = await apiItem(SWIFT, "Store.swift", SAVE, replace("Store.swift", "save(_ v: Int)", "save(_ v: Bool)"));
  assert.equal(item.verdict, "violated", item.detail);
  assert.equal(item.detail, `signature changed: ${SAVE} — public func save(_ v: Int) → public func save(_ v: Bool)`);
  assert.equal(outcome.verdict, "failed");
});

test("overloads: adding or removing a Swift overload is a violation", async () => {
  const added = await apiItem(
    SWIFT,
    "Store.swift",
    SAVE,
    replace("Store.swift", "    public func save(_ v: String)", "    public func save(_ v: Double) {}\n    public func save(_ v: String)"),
  );
  assert.equal(added.item.verdict, "violated");
  assert.equal(added.item.detail, `signature changed: ${SAVE} — added: public func save(_ v: Double)`);

  const removed = await apiItem(SWIFT, "Store.swift", SAVE, replace("Store.swift", "    public func save(_ v: String) { print(v) }\n", ""));
  assert.equal(removed.item.verdict, "violated");
  assert.equal(removed.item.detail, `signature changed: ${SAVE} — removed: public func save(_ v: String)`);
});

test("overloads: a body change, or reordering the overloads, keeps the API — held", async () => {
  const body = await apiItem(SWIFT, "Store.swift", SAVE, replace("Store.swift", "{ print(v) }", "{ debugPrint(v) }"));
  assert.equal(body.item.verdict, "held", body.item.detail);
  assert.equal(body.item.detail, `signature unchanged: ${SAVE} (2 overloads)`);

  const reordered = STORE_SWIFT.replace(
    "    public func save(_ v: Int) { print(v) }\n    public func save(_ v: String) { print(v) }\n",
    "    public func save(_ v: String) { print(v) }\n    public func save(_ v: Int) { print(v) }\n",
  );
  const moved = await apiItem(SWIFT, "Store.swift", SAVE, [NODE, "-e", `require("fs").writeFileSync("Store.swift",${JSON.stringify(reordered)})`]);
  assert.equal(moved.item.verdict, "held", moved.item.detail);
});

test("overloads: Swift free-function overloads are guarded the same way", async () => {
  const files = { "Math.swift": "public func f(_ x: Int) -> Int { x }\npublic func f(_ x: String) -> Int { 0 }\n" };
  const { item } = await apiItem(files, "Math.swift", "Math.swift#f", replace("Math.swift", "f(_ x: String) -> Int", "f(_ x: String) -> Int?"));
  assert.equal(item.verdict, "violated", item.detail);
});

test("overloads: a TypeScript method overload signature change is a violation", async () => {
  const { item } = await apiItem({ "a.ts": PARSE_TS }, "a.ts", "a.ts#Store.save", replace("a.ts", "save(v: string): void;", "save(v: boolean): void;"));
  assert.equal(item.verdict, "violated", item.detail);
  assert.match(item.detail, /save\(v: string\): void → save\(v: boolean\): void/);
});

test("overloads: a TypeScript function's overload signatures are indexed and guarded, not only its implementation", async () => {
  const changed = await apiItem({ "a.ts": PARSE_TS }, "a.ts", "a.ts#parse", replace("a.ts", "parse(v: string): number;", "parse(v: boolean): number;"));
  assert.equal(changed.item.verdict, "violated", changed.item.detail);
  assert.equal(changed.item.detail, "signature changed: a.ts#parse — function parse(v: string): number; → function parse(v: boolean): number;");

  const body = await apiItem({ "a.ts": PARSE_TS }, "a.ts", "a.ts#parse", replace("a.ts", "return Number(v);", "return +v;"));
  assert.equal(body.item.verdict, "held", body.item.detail);
});

test("overloads: a symbol with one declaration hashes exactly as before — existing baselines stay valid", async () => {
  const root = makeGitRepo({ "Model.swift": "public struct Model {\n    public func refresh() -> Int { 1 }\n}\n" });
  const { index } = await buildIndex(root);
  const sigs = apiSignatures(index, "Model.swift#Model.refresh");
  assert.deepEqual(sigs, ["public func refresh() -> Int"]);
  const sym = index.files["Model.swift"].symbols.find((s) => s.id === "Model.swift#Model.refresh")!;
  assert.equal(signatureHash(sigs.join("\n")), signatureHash(sym.signature));
});

test("overloads: `lock check` says when an api-unchanged id names several declarations", async () => {
  const { root, lock } = await setup(SWIFT, "Store.swift", SAVE);
  const { index } = await buildIndex(root);
  const result = checkLock(root, lock, index);
  assert.ok(result.ok, result.errors.join("; "));
  assert.ok(
    result.warnings.includes(
      `api-unchanged ${SAVE} names 2 declarations (overloads) — they are guarded together: changing, adding or removing any of them is a violation`,
    ),
    result.warnings.join("\n"),
  );
  assert.ok(fs.existsSync(path.join(root, "Store.swift")));
});

test("overloads: the graph lists an overloaded id once by name — `why` shows it once", async () => {
  const root = makeGitRepo({ "a.ts": PARSE_TS, ...SWIFT });
  const { index } = await buildIndex(root);
  const graph = buildGraph(index);
  assert.deepEqual(graph.byName.get("parse"), ["a.ts#parse"]);
  assert.deepEqual(graph.byName.get("save"), ["Store.swift#Store.save", "a.ts#Store.save"]);
});
