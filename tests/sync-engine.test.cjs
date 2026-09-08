const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash, webcrypto } = require("node:crypto");
const vm = require("node:vm");

function bytes(value) { return new Uint8Array(Buffer.from(value)).buffer; }
function text(value) { return Buffer.from(value).toString(); }

test("ordinary sync requires an explicit completed server-authoritative baseline", async () => {
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {}, "./scope": {}, "./sync-plan": {}, "./sync-reconcile": {},
    "./sync-state": { loadSyncState: () => undefined },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  await assert.rejects(() => context.module.exports.syncNow({}), /Initial server-authoritative vault sync/);
});

test("initial server-authoritative sync preserves local divergence without re-uploading it", async () => {
  const files = new Map([["note.md", bytes("local")], ["local-only.md", bytes("draft")]]);
  const remote = { path: "note.md", sha256: createHash("sha256").update("server").digest("hex"), size: 6, modifiedAt: "2026-09-08T00:00:00Z" };
  let saved;
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {
      manifest: async () => ({ entries: [remote], revision: "server-revision" }),
      pathUrl: path => path,
      syncRequest: async () => ({ arrayBuffer: bytes("server") }),
    },
    "./scope": { classifyVaultPath: path => ({ scope: path.includes(".conflict-") ? "user-reviewed" : "shared" }) },
    "./sync-plan": { conflictPath: path => `${path}.conflict-device-20260908T000000Z` },
    "./sync-reconcile": { reconcile: () => [] },
    "./sync-state": { loadSyncState: () => undefined, saveSyncState: (entries, revision) => { saved = { entries, revision }; }, loadPendingUpload: () => undefined, savePendingUpload: () => {}, clearPendingUpload: () => {} },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  const adapter = {
    exists: async path => files.has(path),
    readBinary: async path => files.get(path),
    writeBinary: async (path, value) => files.set(path, value),
    remove: async path => files.delete(path),
  };
  const plugin = {
    settings: { syncApiBaseUrl: "http://private", syncDeviceName: "device" },
    getSyncToken: () => "test-token",
    app: { vault: {
      adapter,
      getFiles: () => [...files].map(([path, value]) => ({ path, stat: { mtime: 0 }, value })),
    } },
  };
  const result = await context.module.exports.initialServerSync(plugin);
  assert.deepEqual({ ...result }, { downloaded: 1, uploaded: 0, deleted: 0, conflicts: 2, skipped: 0 });
  assert.equal(text(files.get("note.md")), "server");
  assert.equal(files.has("local-only.md"), false);
  assert.equal(text(files.get("note.md.conflict-device-20260908T000000Z")), "local");
  assert.equal(text(files.get("local-only.md.conflict-device-20260908T000000Z")), "draft");
  assert.deepEqual(saved, { entries: [remote], revision: "server-revision" });
});

test("normal sync resumes an interrupted chunk upload before committing", async () => {
  const sha256 = createHash("sha256").update("hello").digest("hex");
  const local = { path: "note.md", sha256, size: 5, modifiedAt: "2026-09-08T00:00:00Z" };
  const remote = { path: "note.md", sha256: "a".repeat(64), size: 3, modifiedAt: "2026-09-07T00:00:00Z" };
  const files = new Map([["note.md", bytes("hello")]]);
  const chunks = [], pending = [], cleared = [];
  let manifestCalls = 0, committed = false;
  const require = name => ({
    obsidian: { requestUrl: async () => ({}) },
    "./sync-api": {
      manifest: async () => (++manifestCalls === 1 ? { entries: [remote], revision: "before" } : { entries: [local], revision: "after" }),
      pathUrl: path => path,
      syncRequest: async () => ({}),
      startUpload: async () => ({ uploadId: "upload-id", offset: 0, size: 5, chunkSize: 2 }),
      uploadStatus: async () => ({ uploadId: "upload-id", offset: 2, size: 5, chunkSize: 2 }),
      uploadChunk: async (_requestUrl, _base, _token, _id, offset, value) => {
        chunks.push([offset, text(value)]);
        if (offset === 0) throw new Error("response lost after server write");
        return { uploadId: "upload-id", offset: offset + value.byteLength, size: 5, chunkSize: 2 };
      },
      commitUpload: async () => { committed = true; },
    },
    "./scope": { classifyVaultPath: () => ({ scope: "shared" }) },
    "./sync-plan": { conflictPath: path => `${path}.conflict` },
    "./sync-reconcile": { reconcile: () => [{ kind: "upload", path: "note.md", local, remote }] },
    "./sync-state": { loadSyncState: () => ({ entries: [remote], revision: "before" }), saveSyncState: () => {}, loadPendingUpload: () => undefined, savePendingUpload: value => pending.push(value), clearPendingUpload: path => cleared.push(path) },
  })[name];
  const context = { module: { exports: {} }, require, crypto: webcrypto, Uint8Array, Array, Date, Error };
  vm.runInNewContext(readFileSync(join(__dirname, "../src/sync-engine.js"), "utf8"), context);
  const plugin = {
    settings: { syncApiBaseUrl: "http://private", syncDeviceName: "device" }, getSyncToken: () => "test-token",
    app: { vault: { adapter: { exists: async path => files.has(path), readBinary: async path => files.get(path), writeBinary: async (path, value) => files.set(path, value), remove: async path => files.delete(path) }, getFiles: () => [{ path: "note.md", stat: { mtime: 0 } }] } },
  };
  const result = await context.module.exports.syncNow(plugin);
  assert.deepEqual({ ...result }, { downloaded: 0, uploaded: 1, deleted: 0, conflicts: 0, skipped: 0 });
  assert.deepEqual(chunks, [[0, "he"], [2, "ll"], [4, "o"]]);
  assert.equal(pending.length, 4);
  assert.deepEqual(cleared, ["note.md"]);
  assert.equal(committed, true);
});
