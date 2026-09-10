const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const esbuild = require("esbuild");

const code = esbuild.transformSync(readFileSync(join(__dirname, "../src/service-url.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const context = { module: { exports: {} }, URL, Error };
vm.runInNewContext(code, context);
const { inferNasBaseUrl, migrateNasBaseUrl, normalizeNasBaseUrl, serviceBaseUrl } = context.module.exports;

test("derives all internal service URLs from one private NAS base URL", () => {
  assert.equal(normalizeNasBaseUrl("https://nas.example/"), "https://nas.example");
  assert.equal(serviceBaseUrl("https://nas.example", "calendar"), "https://nas.example/calendar-api");
  assert.equal(serviceBaseUrl("https://nas.example", "sync"), "https://nas.example/vault-sync");
  assert.equal(serviceBaseUrl("https://nas.example", "enrollment"), "https://nas.example/vault-enroll");
});

test("migrates former service-specific URLs to the host base", () => {
  assert.equal(inferNasBaseUrl("http://nas.example/calendar-api/"), "http://nas.example");
  assert.equal(inferNasBaseUrl("http://nas.example/vault-sync-pilot"), "http://nas.example");
  assert.equal(inferNasBaseUrl("http://nas.example/vault-enroll-pilot/"), "http://nas.example");
  assert.equal(migrateNasBaseUrl("", { syncApiBaseUrl: "http://nas.example/vault-sync" }), "http://nas.example");
});

test("preserves reverse-proxy prefixes while stripping known service suffixes", () => {
  assert.equal(inferNasBaseUrl("https://gateway.example/private/calendar-api"), "https://gateway.example/private");
});

test("rejects credentials and non-HTTP base URLs", () => {
  assert.throws(() => normalizeNasBaseUrl("https://user:secret@nas.example"), /without credentials/);
  assert.throws(() => normalizeNasBaseUrl("file:///tmp/nas"), /HTTP or HTTPS/);
});
