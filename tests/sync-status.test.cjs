const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const esbuild = require("esbuild");
const code = esbuild.transformSync(readFileSync(join(__dirname, "../src/sync-status.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const context = { module: { exports: {} } };
vm.runInNewContext(code, context);
const { readOnlySyncStatus } = context.module.exports;

test("reports the configured plugin boundary without conflict-resolution authority", () => {
  const status = readOnlySyncStatus();
  assert.equal(status.provider, "syncthing");
  assert.equal(status.observation, "configured");
  assert.equal(status.canScanVault, true);
  assert.equal(status.canTransferFiles, true);
  assert.equal(status.canResolveConflicts, false);
});
