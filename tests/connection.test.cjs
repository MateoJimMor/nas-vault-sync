const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const esbuild = require("esbuild");
const code = esbuild.transformSync(readFileSync(join(__dirname, "../src/connection.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const context = { module: { exports: {} }, URL };
vm.runInNewContext(code, context);
const { connectionReadiness } = context.module.exports;

test("reports connection readiness without returning sensitive values", () => {
  const ready = connectionReadiness("https://example.test/calendar-api", "device-token");
  assert.equal(ready.api, "ready");
  assert.equal(ready.token, "present");
  const missing = connectionReadiness("", "");
  assert.equal(missing.api, "missing");
  assert.equal(missing.token, "missing");
  const invalid = connectionReadiness("https://user:password@example.test/api", "token");
  assert.equal(invalid.api, "invalid");
  assert.equal(invalid.token, "present");
});
