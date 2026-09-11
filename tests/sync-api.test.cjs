const { test } = require("node:test"); const assert = require("node:assert/strict"); const { join } = require("node:path"); const { readFileSync } = require("node:fs"); const vm = require("node:vm");
const esbuild = require("esbuild"); const code = esbuild.transformSync(readFileSync(join(__dirname, "../src/sync-api.ts"), "utf8"), { loader: "ts", format: "cjs" }).code; const context = { module: { exports: {} }, URL }; vm.runInNewContext(code, context); const { pathUrl, syncRequest } = context.module.exports;
test("sync transport encodes paths and sends conditional binary writes", async () => {
  const body = new Uint8Array([1, 2, 3]).buffer; let sent;
  await syncRequest(async request => { sent = request; return { status: 201, text: "{}" }; }, "http://nas/vault-sync", "device-token", pathUrl("a b/file.pdf"), "PUT", body, { "If-None-Match": "*" });
  assert.equal(sent.url, "http://nas/vault-sync/sync/v1/files/a%20b/file.pdf"); assert.equal(sent.body, body); assert.equal(sent.headers["If-None-Match"], "*"); assert.ok(!sent.url.includes("device-token"));
});
test("sync transport reports stale writes without exposing response content", async () => {
  await assert.rejects(() => syncRequest(async () => ({ status: 412, text: "secret backend error" }), "http://nas", "token", "/sync/v1/manifest"), /Vault changed remotely/);
});
test("sync transport permits double dots inside a filename while rejecting traversal segments", async () => {
  let sent;
  await syncRequest(async request => { sent = request; return { status: 200, text: "{}" }; }, "http://nas", "token", pathUrl("folder/2.1 Formulación q.org..pdf"));
  assert.match(sent.url, /2\.1%20Formulaci%C3%B3n%20q\.org\.\.pdf$/);
  await assert.rejects(() => syncRequest(async () => ({ status: 200, text: "{}" }), "http://nas", "token", "/sync/v1/files/folder/../secret"), /Invalid vault-sync API path/);
});
