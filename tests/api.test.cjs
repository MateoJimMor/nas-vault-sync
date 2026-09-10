const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const esbuild = require("esbuild");
const code = esbuild.transformSync(readFileSync(join(__dirname, "../src/api.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const context = { module: { exports: {} }, URL, Error, JSON };
vm.runInNewContext(code, context);
const { requestApi } = context.module.exports;
const base = "https://example.test/calendar-api";
test("authenticated request keeps token out of URL and body", async () => {
  let request;
  await requestApi(async r => { request = r; return { status: 200, text: '{"apiVersion":1,"status":"ok"}' }; }, base, "test-token", "/v1/health");
  assert.equal(request.headers.Authorization, "Bearer test-token");
  assert.equal(request.url, base + "/v1/health");
  assert.equal(request.body, undefined);
});
test("invalid endpoint and missing token never reach transport", async () => {
  const transport = () => { throw new Error("must not be called"); };
  await assert.rejects(requestApi(transport, "file:///tmp", "x", "/v1/health"), /HTTP/);
  await assert.rejects(requestApi(transport, "https://user:secret@example.com", "x", "/v1/health"), /credentials/);
  await assert.rejects(requestApi(transport, base, "", "/v1/health"), /Connect this device/);
});
test("errors are redacted and mutations are not retried", async () => {
  let calls = 0;
  await assert.rejects(requestApi(async () => { calls++; throw new Error("secret-token"); }, base, "x", "/v1/events", "POST", {}), /Cannot reach/);
  assert.equal(calls, 1);
  await assert.rejects(requestApi(async () => ({status: 500, text: "secret-token"}), base, "x", "/v1/health"), /^Error: NAS request failed \(HTTP 500\)\.$/);
});
test("rejects conflicts, malformed JSON and incompatible versions", async () => {
  for (const [status, text, pattern] of [[412, "", /changed/], [200, "invalid", /JSON/], [200, '{"apiVersion":2}', /incompatible/]]) {
    await assert.rejects(requestApi(async () => ({status, text}), base, "x", "/v1/health"), pattern);
  }
});
