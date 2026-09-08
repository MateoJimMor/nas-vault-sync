const { test } = require("node:test"); const assert = require("node:assert/strict"); const { join } = require("node:path"); const { readFileSync } = require("node:fs"); const vm = require("node:vm");
const esbuild = require("esbuild"); const code = esbuild.transformSync(readFileSync(join(__dirname, "../src/sync-reconcile.ts"), "utf8"), { loader: "ts", format: "cjs" }).code; const context = { module: { exports: {} } }; vm.runInNewContext(code, context); const { reconcile } = context.module.exports;
const item = (path, sha256) => ({ path, sha256, size: 1 });
test("three-way reconciliation transfers one-sided edits and preserves conflicts", () => {
  assert.equal(reconcile([item("a.md", "one")], [item("a.md", "one")], [item("a.md", "two")])[0].kind, "download");
  assert.equal(reconcile([item("a.md", "one")], [item("a.md", "two")], [item("a.md", "one")])[0].kind, "upload");
  assert.equal(reconcile([item("a.md", "one")], [], [item("a.md", "two")])[0].kind, "conflict");
  assert.equal(reconcile([item("a.md", "one")], [], [item("a.md", "one")])[0].kind, "delete-remote");
  assert.equal(reconcile([item("a.md", "one")], [item("a.md", "one")], [])[0].kind, "delete-local");
});
